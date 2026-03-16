#!/usr/bin/env node

import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseRef = process.argv[2] || "main";
const MAX_BUFFER = 10 * 1024 * 1024;

function safePath(cwd, file) {
  const filePath = resolve(cwd, file);
  return filePath.startsWith(cwd) ? filePath : null;
}

function getDiff() {
  const cwd = process.cwd();
  const execOpts = { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER };

  // Find merge base between current HEAD and the base ref
  // Try the ref as-is first, then origin/<ref> for remote tracking branches
  // Special case: "root" or "empty" diffs against the empty tree (shows everything as new)
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  let mergeBase;
  let resolvedRef = baseRef;
  if (baseRef === "root" || baseRef === "empty") {
    mergeBase = EMPTY_TREE;
    resolvedRef = "empty tree";
  } else {
    try {
      mergeBase = execSync(`git merge-base ${baseRef} HEAD`, execOpts).trim();
    } catch {
      try {
        resolvedRef = `origin/${baseRef}`;
        mergeBase = execSync(`git merge-base ${resolvedRef} HEAD`, execOpts).trim();
      } catch {
        process.stderr.write(
          `Warning: ref '${baseRef}' (and 'origin/${baseRef}') not found, falling back to HEAD\n`,
        );
        mergeBase = "HEAD";
        resolvedRef = "HEAD";
      }
    }
  }
  process.stderr.write(`Diffing against ${resolvedRef} (merge-base: ${mergeBase.slice(0, 8)})\n`);

  // Diff from merge base to current working tree (includes uncommitted changes)
  let patch = "";
  try {
    patch = execSync(`git diff ${mergeBase}`, execOpts);
  } catch {
    // no tracked changes
  }

  // Untracked files
  let untrackedFiles = [];
  try {
    const raw = execSync("git ls-files --others --exclude-standard", execOpts);
    untrackedFiles = raw.trim().split("\n").filter(Boolean);
  } catch {
    // ignore
  }

  for (const file of untrackedFiles) {
    try {
      const fileDiff = execSync(`git diff --no-index /dev/null "${file}"`, execOpts);
      patch += "\n" + fileDiff;
    } catch (e) {
      if (e.stdout) patch += "\n" + e.stdout;
    }
  }

  // Extract changed files from patch headers (avoids redundant git call)
  const files = [
    ...new Set([
      ...(patch.match(/^diff --git a\/(.*?) b\//gm) || []).map((m) =>
        m.replace(/^diff --git a\/(.*?) b\/.*/, "$1"),
      ),
      ...untrackedFiles,
    ]),
  ];

  let headRef = "";
  try {
    headRef = execSync("git rev-parse --short HEAD", execOpts).trim();
  } catch {}

  let branchName = "";
  try {
    branchName = execSync("git rev-parse --abbrev-ref HEAD", execOpts).trim();
  } catch {}

  return { patch: patch.trim(), cwd, files, baseRef, resolvedRef, mergeBase, headRef, branchName };
}

function imgLines(images) {
  if (!images?.length) return "";
  return images.map((img) => `![image](${img})\n`).join("");
}

function formatFeedback(data, diffData) {
  const { annotations, generalComment, generalImages, approved, cancelled } = data;

  if (cancelled) {
    return "## Code Review Feedback\n\nReview cancelled. No feedback provided.";
  }

  const baseLabel = `${diffData.resolvedRef}@${diffData.mergeBase.slice(0, 7)}`;
  const headLabel = diffData.branchName
    ? `${diffData.branchName}@${diffData.headRef}`
    : diffData.headRef;

  let md = "## Code Review Feedback\n";
  md += `> Base: ${baseLabel} → Head: ${headLabel} (+ working tree)\n`;

  if (approved) {
    md += "\nChanges approved.";
    if (!annotations?.length && !generalComment && !generalImages?.length) {
      return md + " No further action needed.";
    }
    md += " Comments below still apply.\n";
  }

  const byFile = new Map();
  for (const a of annotations || []) {
    if (!byFile.has(a.file)) byFile.set(a.file, []);
    byFile.get(a.file).push(a);
  }

  for (const [file, anns] of byFile) {
    md += `\n### File: ${file}\n`;
    const fileComments = anns.filter((a) => a.type === "file");
    const lineComments = anns.filter((a) => a.type !== "file");
    for (const a of fileComments) {
      md += `**File comment**: ${a.text}\n${imgLines(a.images)}`;
    }
    for (const a of lineComments.sort((x, y) => (x.fromLine || x.line) - (y.fromLine || y.line))) {
      const sideLabel = a.side === "left" ? ` (base: ${baseLabel})` : " (working tree)";
      const lineRef =
        a.fromLine && a.toLine && a.fromLine !== a.toLine
          ? `Lines ${a.fromLine}-${a.toLine}${sideLabel}`
          : `Line ${a.fromLine || a.line}${sideLabel}`;
      md += `**${lineRef}**: ${a.text}\n`;
      if (a.snippet) {
        md += `\`\`\`\n${a.snippet}\n\`\`\`\n`;
      }
      md += imgLines(a.images);
    }
  }

  if (generalComment || generalImages?.length) {
    md += `\n### General Comments\n`;
    if (generalComment) md += `${generalComment}\n`;
    md += imgLines(generalImages);
  }

  return md;
}

async function main() {
  const diffData = getDiff();

  if (!diffData.patch) {
    process.stderr.write("No changes to review.\n");
    process.exit(0);
  }

  const htmlTemplate = readFileSync(join(__dirname, "index.html"), "utf8");
  const jsonStr = JSON.stringify(diffData);
  const b64 = Buffer.from(jsonStr).toString("base64");
  const cachedHtml = htmlTemplate.replace(
    "<!--__DIFF_DATA__-->",
    `<script>window.__DIFF_DATA__ = JSON.parse(atob("${b64}"));</script>`,
  );

  let resolveFeedback;
  const feedbackPromise = new Promise((resolve) => {
    resolveFeedback = resolve;
  });

  const server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(cachedHtml);
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/context?")) {
      const params = new URLSearchParams(req.url.split("?")[1]);
      const file = params.get("file");
      const start = parseInt(params.get("start"), 10);
      const end = parseInt(params.get("end"), 10);
      if (!file || isNaN(start) || isNaN(end) || start < 1 || end < start) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid parameters" }));
        return;
      }
      const filePath = safePath(diffData.cwd, file);
      if (!filePath) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "File not found" }));
        return;
      }
      try {
        const content = readFileSync(filePath, "utf8");
        const allLines = content.split("\n");
        const lines = allLines.slice(start - 1, end);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ lines, start, end: Math.min(end, allLines.length) }));
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "File not found" }));
      }
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/file-versions?")) {
      const params = new URLSearchParams(req.url.split("?")[1]);
      const file = params.get("file");
      if (!file) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing file parameter" }));
        return;
      }
      let oldContent = "";
      try {
        oldContent = execSync(`git show ${diffData.mergeBase}:"${file}"`, {
          cwd: diffData.cwd,
          encoding: "utf8",
          maxBuffer: MAX_BUFFER,
        });
      } catch {}
      let newContent = "";
      const filePath = safePath(diffData.cwd, file);
      if (filePath) {
        try {
          newContent = readFileSync(filePath, "utf8");
        } catch {}
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ old: oldContent, new: newContent }));
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/raw-file?")) {
      const params = new URLSearchParams(req.url.split("?")[1]);
      const file = params.get("file");
      const ref = params.get("ref"); // "old" for base version, default is working tree
      if (!file) {
        res.writeHead(400);
        res.end("Missing file parameter");
        return;
      }
      try {
        let buf;
        if (ref === "old") {
          buf = execSync(`git show ${diffData.mergeBase}:"${file}"`, {
            cwd: diffData.cwd,
            encoding: "buffer",
            maxBuffer: MAX_BUFFER,
          });
        } else {
          const filePath = safePath(diffData.cwd, file);
          if (!filePath) {
            res.writeHead(404);
            res.end("Not found");
            return;
          }
          buf = readFileSync(filePath);
        }
        const ext = file.split(".").pop()?.toLowerCase();
        const mimeMap = {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          gif: "image/gif",
          svg: "image/svg+xml",
          webp: "image/webp",
          ico: "image/x-icon",
          bmp: "image/bmp",
        };
        const mime = mimeMap[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
        res.end(buf);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/feedback") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          resolveFeedback(data);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}`;
    process.stderr.write(`Diff review server running at ${url}\n`);

    // Open browser (macOS)
    try {
      execSync(`open "${url}"`);
    } catch {
      process.stderr.write(`Open ${url} in your browser to review changes.\n`);
    }
  });

  const feedback = await feedbackPromise;
  const markdown = formatFeedback(feedback, diffData);
  process.stdout.write(markdown + "\n");

  server.close();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
