---
name: linemark
description: Open interactive diff review UI in browser for current changes
allowed-tools:
  - "Bash(npx*)"
---

# Review Diff

Open an interactive diff review UI in the browser showing the full diff of the current branch against a base ref.

## Instructions

Run the diff annotator server with an optional base ref argument. Defaults to `main`.

```bash
npx --yes github:gdaybrice/linemark $ARGUMENTS --root <project-root>
```

If no base ref argument is provided, it diffs against `main`.

**`--root`**: the folder VS Code should open as the workspace when the reviewer clicks "Open in VS Code" on a diff line. Determine the project root the user is actually working in and pass it:

- Usually this is your primary working directory (the folder the session was started in).
- In a monorepo where the session covers the whole repo but the diff is in a package, prefer the broader workspace root.
- If unsure, omit the flag — it defaults to the git repo's cwd.

**Timeout**: Allow up to 5 minutes for the user to review.

## Handling the output

- If the output contains "Changes approved" → acknowledge the approval, no further action needed
- If the output contains "Review cancelled" → acknowledge the cancellation, no further action needed
- Otherwise → the output contains line-level code review comments. Address **each comment** by making the requested changes to the code. After making changes, briefly summarize what you changed for each comment.
