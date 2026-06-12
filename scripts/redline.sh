#!/bin/bash
# Build Redline and install it into /Applications, replacing any existing copy,
# then launch it. This is what `npm run redline` runs.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run tauri build

APP_SRC="src-tauri/target/release/bundle/macos/Redline.app"
if [ ! -d "$APP_SRC" ]; then
  echo "error: build finished but $APP_SRC was not produced" >&2
  exit 1
fi

# Quit a running copy before replacing it, so the swap is clean.
osascript -e 'tell application "Redline" to quit' >/dev/null 2>&1 && sleep 1 || true

rm -rf /Applications/Redline.app
ditto "$APP_SRC" /Applications/Redline.app
open /Applications/Redline.app

echo
echo "Redline installed to /Applications and launched."
echo "To update later: git pull && npm run redline"
