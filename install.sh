#!/bin/bash
set -e

LINEMARK_HOME="${LINEMARK_HOME:-$HOME/.linemark}"
REPO_URL="https://github.com/gdaybrice/linemark.git"
CLAUDE_COMMANDS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/commands"

# Install or update linemark
if [ -d "$LINEMARK_HOME/.git" ]; then
  echo "Updating linemark..."
  git -C "$LINEMARK_HOME" pull --quiet
elif [ -L "$LINEMARK_HOME" ] || [ -d "$LINEMARK_HOME" ]; then
  echo "linemark already installed at $LINEMARK_HOME"
else
  echo "Installing linemark to $LINEMARK_HOME..."
  git clone --quiet "$REPO_URL" "$LINEMARK_HOME"
fi

# Copy skill as global slash command
mkdir -p "$CLAUDE_COMMANDS_DIR"
ln -sf "$LINEMARK_HOME/.claude/skills/linemark/SKILL.md" "$CLAUDE_COMMANDS_DIR/linemark.md"

echo ""
echo "linemark installed!"
echo "  Server: $LINEMARK_HOME/server.mjs"
echo "  Command: $CLAUDE_COMMANDS_DIR/linemark.md"
echo ""
echo "Run /linemark in Claude Code to start a review."
