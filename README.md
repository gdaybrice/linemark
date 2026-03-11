# Linemark

Interactive code review for AI coding agents. After your agent makes changes, open a browser-based diff view, add line-level comments, and send structured feedback back to the agent.

Zero dependencies. Just Node.js 18+.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/gdaybrice/linemark/main/install.sh | bash
```

This clones linemark to `~/.linemark` and installs `/linemark` as a global Claude Code command. Works in any project, no per-project setup needed.

## Usage

1. Make some code changes (or ask Claude to)
2. Run `/linemark` in Claude Code
3. Browser opens with a side-by-side diff view
4. Click line numbers to add inline comments
5. Click **Submit Feedback** or **Approve**
6. Claude addresses each comment

## Features

- Side-by-side and unified diff views
- Line-level, multi-line, and file-level comments
- Comment categories (Bug, Fix needed, Style, Note, etc.)
- Syntax highlighting
- Image attachments (paste, drag-and-drop, file picker)
- Collapsible files with "Viewed" tracking
- Hunk expansion for surrounding context
- File tree sidebar with filter
- Configurable base ref (defaults to `main`)

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Cmd+Enter` | Submit feedback / save comment |
| `Escape` | Cancel inline comment |

## How it works

1. `/linemark` tells Claude to run `server.mjs`
2. Server captures `git diff` from merge-base + untracked files
3. Opens a browser with the diff UI on a random port
4. You review and annotate
5. On submit, structured markdown goes to stdout
6. Claude reads it and acts on each comment

## License

MIT
