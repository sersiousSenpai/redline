#!/bin/bash
# Prepare a complete, installable Redline — and stop there.
#
# This is the *preparation* half of what `redline.sh` used to do in one go.
# Splitting it is the point: preparing a replacement application is long,
# repeatable and safe, and installing one is short, destructive and needs a
# recoverable transaction. Conflating them is what left the old script with a
# window where the installed app had been deleted and the new one had not yet
# been copied.
#
# It prints the path of the finished bundle on stdout and writes nothing
# outside the checkout.
set -euo pipefail
cd "$(dirname "$0")/.."

# The real stdout moves to fd 3 and stdout becomes stderr, so the ONLY thing
# this script ever writes to stdout is the path it exists to produce.
#
# This is not tidiness. `redline.sh` reads that path with `$(...)`, and npm,
# cargo and the Tauri bundler all print progress to stdout — so without this
# the caller captures the entire build log as a filename and reports "no
# application was produced" at the end of a four-minute build that in fact
# succeeded. Redirecting the whole script, rather than each command, means a
# command added later cannot reintroduce it.
exec 3>&1 1>&2

log() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
log "Installing/refreshing JS dependencies…"
npm install

# The activation helper first. It is a separate executable on purpose: the
# process that supervises replacing Redline must not link Redline. It has to
# exist before `tauri build`, because it goes *inside* the bundle and therefore
# inside the signature.
log "Building the activation helper…"
cargo build --release --manifest-path src-tauri/Cargo.toml -p redline-activate

# Sign with a stable identity when one is available. macOS keys TCC folder
# permissions (Downloads, Desktop, …) to the code signature; the default
# ad-hoc signature changes on every build, so each reinstall would reset the
# user's grants. Any local code-signing certificate (e.g. a self-signed
# "Redline Dev" made in Keychain Access) keeps grants across rebuilds. With
# no identity, fall back to ad-hoc exactly as before.
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  if security find-identity -v -p codesigning 2>/dev/null | grep -q '"Redline Dev"'; then
    export APPLE_SIGNING_IDENTITY="Redline Dev"
    log "Signing with local identity: Redline Dev"
  fi
fi

npm run tauri build

APP_SRC="src-tauri/target/release/bundle/macos/Redline.app"
if [ ! -d "$APP_SRC" ]; then
  log "error: build finished but $APP_SRC was not produced"
  exit 1
fi

# ---------------------------------------------------------------------------
# Identity and the helper go in, then the bundle is re-signed
# ---------------------------------------------------------------------------
# Both files are inside what the signature covers, so they cannot be added
# afterwards — a bundle with a file appended after signing does not verify, and
# `--verify --strict` is what the restart path checks before it will install
# anything.
RESOURCES="$APP_SRC/Contents/Resources"
mkdir -p "$RESOURCES"
cp src-tauri/target/release/redline-activate "$RESOURCES/redline-activate"
chmod 755 "$RESOURCES/redline-activate"

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY=""
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  DIRTY="+local"
fi
NOW="$(date +%s)"
RELEASE_ID="rel-${NOW}-${SHA}"
# The identity stamp. Small, immutable, and signed: it is how a recovering
# process answers "which release is installed right now?" on a machine where
# Redline cannot open its own database.
cat > "$RESOURCES/redline-release.json" <<JSON
{
  "manifestVersion": 1,
  "releaseId": "${RELEASE_ID}",
  "createdAt": ${NOW},
  "sourceFingerprint": "git:${SHA}${DIRTY}",
  "helperProtocol": 1
}
JSON

log "Signing the bundle (helper and identity included)…"
IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
# Nested code first, then the bundle: a signature over a bundle whose
# executables are signed afterwards does not verify.
codesign --force --sign "$IDENTITY" --timestamp=none "$RESOURCES/redline-activate"
for exe in "$APP_SRC"/Contents/MacOS/*; do
  [ -f "$exe" ] && codesign --force --sign "$IDENTITY" --timestamp=none "$exe"
done
codesign --force --sign "$IDENTITY" --timestamp=none \
  --entitlements src-tauri/Entitlements.plist "$APP_SRC"

if ! codesign --verify --strict --deep "$APP_SRC" 2>/dev/null; then
  log "error: the packaged application did not pass signature verification"
  exit 1
fi

log "Prepared ${RELEASE_ID}"
printf '%s\n' "$APP_SRC" >&3
