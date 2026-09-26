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

# whisper.cpp (bundled speech-to-text) is compiled from source by the whisper-rs
# build script, which shells out to `cmake`. cmake is NOT part of the Xcode
# Command Line Tools, so a fresh Mac won't have it — without this check the build
# dies deep inside cargo with a cryptic "is `cmake` not installed?" panic.
if ! command -v cmake >/dev/null 2>&1; then
  echo "✗ cmake isn't installed (needed to compile the bundled speech-to-text engine)."
  if command -v brew >/dev/null 2>&1; then
    if [ -t 0 ]; then
      printf "  Install it now with Homebrew (brew install cmake)? [Y/n] "
      read -r ans
      case "${ans:-Y}" in
        [Yy]*|"") brew install cmake ;;
        *)
          echo "  Install it yourself with 'brew install cmake', then re-run 'npm run redline'."
          exit 1
          ;;
      esac
    else
      brew install cmake
    fi
  else
    echo "  Homebrew wasn't found, so we can't install it automatically." >&2
    echo "  Install Homebrew from https://brew.sh, then run:" >&2
    echo "    brew install cmake" >&2
    echo "  (or download cmake from https://cmake.org/download/), then re-run 'npm run redline'." >&2
    exit 1
  fi
fi
if ! command -v cmake >/dev/null 2>&1; then
  echo "✗ cmake still isn't on PATH after the install attempt." >&2
  echo "  Open a new terminal (or run 'brew install cmake' manually), then re-run 'npm run redline'." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node.js $NODE_MAJOR is too old — Redline needs Node 20 or newer." >&2
  echo "  Install a current Node from https://nodejs.org (or via nvm/brew), then re-run." >&2
  exit 1
fi

# Preparation and installation are now two things, and the split is the point.
# `redline-build.sh` produces a complete, signed, verified application and
# stops; this script then installs it through the activation helper, which
# exchanges the bundles atomically instead of deleting the installed one and
# hoping the copy lands.
APP_SRC="$(bash scripts/redline-build.sh)"
if [ ! -d "$APP_SRC" ]; then
  echo "error: preparation did not produce an application" >&2
  exit 1
fi

# Quit a running copy before replacing it, so the swap is clean.
osascript -e 'tell application "Redline" to quit' >/dev/null 2>&1 && sleep 1 || true

HELPER="src-tauri/target/release/redline-activate"
if [ -x "$HELPER" ]; then
  # Atomic exchange, one installer at a time. There is no moment in here when
  # /Applications/Redline.app does not exist.
  "$HELPER" install "$APP_SRC" /Applications/Redline.app
else
  # The helper is built by redline-build.sh, so this should not happen — but a
  # missing helper must not silently become the old destructive path.
  echo "error: the activation helper was not built; refusing to install by deleting" >&2
  echo "       your existing copy. Re-run 'npm run redline'." >&2
  exit 1
fi

# Remove the build-output copy so Spotlight doesn't index two Redlines.
rm -rf "$APP_SRC"
open /Applications/Redline.app

echo
echo "Redline installed to /Applications and launched."
echo "To update later: git pull && npm run redline"
echo "After this install, prepared releases can also be applied from Runs → Build Redline."
