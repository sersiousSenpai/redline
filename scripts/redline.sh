#!/bin/bash
# Build Redline and install it into /Applications, replacing any existing copy,
# then launch it. This is what `npm run redline` runs.
set -euo pipefail
cd "$(dirname "$0")/.."

# Preflight: catch missing prerequisites with a readable message — and offer
# to install them — instead of letting the build die on a cryptic toolchain
# error.
if ! xcode-select -p >/dev/null 2>&1; then
  echo "✗ Xcode Command Line Tools aren't installed (needed to compile Redline)."
  echo "  Opening Apple's installer now — click Install, wait for it to finish,"
  echo "  then run 'npm run redline' again."
  xcode-select --install >/dev/null 2>&1 || true
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  # rustup installs may not be on PATH in this shell yet
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "✗ Rust isn't installed (the 'cargo' command was not found)."
  if [ -t 0 ]; then
    printf "  Install it now with rustup, Rust's official installer? [Y/n] "
    read -r ans
    case "${ans:-Y}" in
      [Yy]*|"")
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        . "$HOME/.cargo/env"
        ;;
      *)
        echo "  Install it yourself with:"
        echo "    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
        echo "  then restart your terminal and run 'npm run redline' again."
        exit 1
        ;;
    esac
  else
    echo "  Install it with:" >&2
    echo "    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2
    echo "  then restart your terminal and run 'npm run redline' again." >&2
    exit 1
  fi
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node.js $NODE_MAJOR is too old — Redline needs Node 20 or newer." >&2
  echo "  Install a current Node from https://nodejs.org (or via nvm/brew), then re-run." >&2
  exit 1
fi

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
# Remove the build-output copy so Spotlight doesn't index two Redlines.
rm -rf "$APP_SRC"
open /Applications/Redline.app

echo
echo "Redline installed to /Applications and launched."
echo "To update later: git pull && npm run redline"
