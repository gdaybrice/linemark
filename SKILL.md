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
npx --yes github:gdaybrice/linemark $ARGUMENTS
```

If no argument is provided, it diffs against `main`.

**Timeout**: Allow up to 5 minutes for the user to review.

## Handling the output

- If the output contains "Changes approved" → acknowledge the approval, no further action needed
- If the output contains "Review cancelled" → acknowledge the cancellation, no further action needed
- Otherwise → the output contains line-level code review comments. Address **each comment** by making the requested changes to the code. After making changes, briefly summarize what you changed for each comment.
