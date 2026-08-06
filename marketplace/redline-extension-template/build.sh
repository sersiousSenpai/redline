#!/bin/sh
# Build the extension and place the module next to extension.json, so this
# folder (named to match extension.json's `name`) can be copied straight
# into ~/.redline/extensions/ for local development. Relaunch Redline (or
# install via the marketplace) to load it.
set -eu
cd "$(dirname "$0")"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build --release --target wasm32-unknown-unknown
cp "target/wasm32-unknown-unknown/release/$(sed -n 's/^name = "\(.*\)"$/\1/p' Cargo.toml | head -1 | tr '-' '_').wasm" extension.wasm
ls -la extension.wasm
shasum -a 256 extension.wasm
