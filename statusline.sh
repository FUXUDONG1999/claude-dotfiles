#!/usr/bin/env bash
# Thin wrapper: real logic lives in statusline.py (stdin passes through)
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$HOME/.claude/statusline.py"
else
  exec python "$HOME/.claude/statusline.py"
fi
