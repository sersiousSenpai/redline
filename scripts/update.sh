#!/bin/bash
# Launched by Redline's "Check for Updates…" menu item via `open -a Terminal`.
# Terminal hands this script a bare launchd environment, so re-exec the user's
# login shell interactively — that's where nvm/brew put node and npm on PATH.
cd "$(dirname "$0")/.."
exec "${SHELL:-/bin/zsh}" -ilc 'git pull --ff-only && npm run redline'
