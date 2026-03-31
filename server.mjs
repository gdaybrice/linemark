#!/usr/bin/env node

import { createServer } from "node:http";
import { execSync, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_BUFFER = 10 * 1024 * 1024;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const GIT_REF_RE = /^[a-zA-Z0-9_\-.\/@~^{}:]+$/;
function assertSafeRef(ref) {
  if (!GIT_REF_RE.test(ref)) {
    throw new Error(`Invalid git ref: ${ref}`);
  }
}

const baseRef = process.argv[2] || "root";
if (baseRef !== "root" && baseRef !== "empty") {
  assertSafeRef(baseRef);
}

function safePath(cwd, file) {
  const filePath = resolve(cwd, file);
  return filePath.startsWith(cwd) ? filePath : null;
}

function resolveBootstrap() {
  const cwd = process.cwd();
  const execOpts = { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER };

  let mergeBase;
  let resolvedRef = baseRef;
  if (baseRef === "root" || baseRef === "empty") {
    mergeBase = EMPTY_TREE;
    try {
      resolvedRef = execSync("git rev-list --max-parents=0 --abbrev-commit HEAD", execOpts)
        .trim()
        .split("\n")[0];
    } catch {
      resolvedRef = "root";
    }
  } else {
    try {
      mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], execOpts).trim();
    } catch {
      try {
        resolvedRef = `origin/${baseRef}`;
        mergeBase = execFileSync("git", ["merge-base", resolvedRef, "HEAD"], execOpts).trim();
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

  let headRef = "";
  try {
    headRef = execSync("git rev-parse --short HEAD", execOpts).trim();
  } catch {}

  let branchName = "";
  try {
    branchName = execSync("git rev-parse --abbrev-ref HEAD", execOpts).trim();
  } catch {}

  let hasWorktreeChanges = false;
  try {
    execSync("git diff --quiet HEAD", execOpts);
    const untracked = execSync("git ls-files --others --exclude-standard", execOpts).trim();
    hasWorktreeChanges = untracked.length > 0;
  } catch {
    hasWorktreeChanges = true;
  }

  return { cwd, baseRef, resolvedRef, mergeBase, headRef, branchName, hasWorktreeChanges };
}

function getDiff(bootstrap, commitHash) {
  const { cwd, mergeBase } = bootstrap;
  const execOpts = { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER };

  let patch = "";

  const includeUntracked = commitHash === "working" || commitHash === "all" || !commitHash;

  if (commitHash === "working") {
    // Working tree only: diff HEAD against working tree (staged + unstaged)
    try {
      patch = execSync("git diff HEAD", execOpts);
    } catch {
      // no tracked changes
    }
  } else if (commitHash && commitHash !== "all") {
    assertSafeRef(commitHash);
    try {
      patch = execFileSync("git", ["diff", `${commitHash}~1`, commitHash], {
        ...execOpts,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      try {
        patch = execFileSync("git", ["diff", EMPTY_TREE, commitHash], execOpts);
      } catch {
        // no changes
      }
    }
  } else {
    // Full branch diff: merge base to working tree
    try {
      patch = execFileSync("git", ["diff", mergeBase], execOpts);
    } catch {
      // no tracked changes
    }
  }

  if (includeUntracked) {
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
        const fileDiff = execFileSync("git", ["diff", "--no-index", "/dev/null", file], execOpts);
        patch += "\n" + fileDiff;
      } catch (e) {
        if (e.stdout) patch += "\n" + e.stdout;
      }
    }
  }

  return { patch: patch.trim(), ...bootstrap };
}

function getCommits(bootstrap) {
  const { cwd, mergeBase } = bootstrap;
  const execOpts = { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER };
  try {
    const raw = execFileSync(
      "git",
      ["log", "--format=%H%x00%h%x00%s%x00%an%x00%aI", `${mergeBase}..HEAD`],
      execOpts,
    );
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, subject, author, date] = line.split("\0");
        return { hash, shortHash, subject, author, date };
      });
  } catch {
    return [];
  }
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
    const richComments = anns.filter((a) => a.type === "rich");
    const lineComments = anns.filter((a) => a.type !== "file" && a.type !== "rich");
    for (const a of fileComments) {
      md += `**File comment**: ${a.text}\n${imgLines(a.images)}`;
    }
    for (const a of richComments.sort((x, y) => (x.blockIndex || 0) - (y.blockIndex || 0))) {
      const snippetPreview = a.snippet ? a.snippet.slice(0, 80).replace(/\n/g, " ") : "";
      const ref = snippetPreview
        ? ` "${snippetPreview}${a.snippet.length > 80 ? "…" : ""}"`
        : ` block ${(a.blockIndex || 0) + 1}`;
      md += `**Re${ref}**: ${a.text}\n`;
      if (a.snippet) {
        md += `> ${a.snippet.split("\n").join("\n> ")}\n`;
      }
      md += imgLines(a.images);
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
  const bootstrap = resolveBootstrap();

  // Check if there are any changes at all
  const initialDiff = getDiff(bootstrap);
  if (!initialDiff.patch) {
    process.stderr.write("No changes to review.\n");
    process.exit(0);
  }

  const htmlTemplate = readFileSync(join(__dirname, "index.html"), "utf8");
  const bootstrapJson = JSON.stringify(bootstrap);
  const b64 = Buffer.from(bootstrapJson).toString("base64");
  const cachedHtml = htmlTemplate.replace(
    "<!--__DIFF_DATA__-->",
    `<script>window.__BOOTSTRAP__ = JSON.parse(atob("${b64}"));</script>`,
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

    if (req.method === "GET" && (req.url === "/api/diff" || req.url?.startsWith("/api/diff?"))) {
      const params = new URLSearchParams(req.url.split("?")[1] || "");
      const commit = params.get("commit") || "all";
      const diffData = getDiff(bootstrap, commit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(diffData));
      return;
    }

    if (req.method === "GET" && req.url === "/api/commits") {
      const commits = getCommits(bootstrap);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(commits));
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
      const filePath = safePath(bootstrap.cwd, file);
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
        oldContent = execFileSync("git", ["show", `${bootstrap.mergeBase}:${file}`], {
          cwd: bootstrap.cwd,
          encoding: "utf8",
          maxBuffer: MAX_BUFFER,
        });
      } catch {}
      let newContent = "";
      const filePath = safePath(bootstrap.cwd, file);
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
          buf = execFileSync("git", ["show", `${bootstrap.mergeBase}:${file}`], {
            cwd: bootstrap.cwd,
            encoding: "buffer",
            maxBuffer: MAX_BUFFER,
          });
        } else {
          const filePath = safePath(bootstrap.cwd, file);
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
  const markdown = formatFeedback(feedback, bootstrap);
  process.stdout.write(markdown + "\n");

  server.close();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
