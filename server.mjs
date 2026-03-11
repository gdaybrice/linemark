#!/usr/bin/env node

import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseRef = process.argv[2] || "main";

function getDiff() {
  const cwd = process.cwd();
  const execOpts = { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 };

  // Find merge base between current HEAD and the base ref
  // Try the ref as-is first, then origin/<ref> for remote tracking branches
  let mergeBase;
  let resolvedRef = baseRef;
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

  // Get list of changed files
  let files = [];
  try {
    const raw = execSync(`git diff ${mergeBase} --name-only`, execOpts);
    files = raw.trim().split("\n").filter(Boolean);
  } catch {
    // no files
  }
  files = files.concat(untrackedFiles);

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

function formatFeedback(data) {
  const { annotations, generalComment, generalImages, approved, cancelled } = data;

  if (cancelled) {
    return "## Code Review Feedback\n\nReview cancelled. No feedback provided.";
  }

  if (approved) {
    return "## Code Review Feedback\n\nChanges approved. No further action needed.";
  }

  let md = "## Code Review Feedback\n";

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
      const lineRef =
        a.fromLine && a.toLine && a.fromLine !== a.toLine
          ? `Lines ${a.fromLine}-${a.toLine}`
          : `Line ${a.fromLine || a.line}`;
      md += `**${lineRef}**: ${a.text}\n${imgLines(a.images)}`;
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

  let resolveFeedback;
  const feedbackPromise = new Promise((resolve) => {
    resolveFeedback = resolve;
  });

  const server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      const injected = htmlTemplate.replace(
        "<!--__DIFF_DATA__-->",
        `<script>window.__DIFF_DATA__ = ${JSON.stringify(diffData).replace(/<\//g, "<\\/")};</script>`,
      );
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(injected);
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
      const filePath = resolve(diffData.cwd, file);
      if (!filePath.startsWith(diffData.cwd) || !existsSync(filePath)) {
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Read failed" }));
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
  const markdown = formatFeedback(feedback);
  process.stdout.write(markdown + "\n");

  server.close();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
