# Marketplace staging trees

These two directories are the staging trees for the marketplace's public
repos (Elevation program, phase B4). They are engineered and reviewed here,
and get extracted to their own GitHub repos **only after the first signed
DMG release** — the trust story ("checksummed artifacts inside a notarized
app") collapses if the app itself triggers Gatekeeper warnings.

- `redline-extensions/` → the curated index repo. `index.json` is the
  registry; human PR review on it is the v1 trust root, and its CI
  (`scripts/validate.mjs`, run by the workflow under `.github/`) re-verifies
  schema, name rules, artifact sha256/size, scope/event subsets, and the
  license allowlist mirrored from `src-tauri/deny.toml`. Drift tests in
  `src-tauri/src/marketplace.rs` pin the mirrored vocabularies to the ABI
  crate and deny.toml, so the mirrors cannot rot while staged here.
- `redline-extension-template/` → the publisher story: a working extension
  crate on `redline-extension-sdk`, with a release workflow that builds
  `wasm32-unknown-unknown`, computes the sha256, drafts the GitHub release,
  and prints the ready-to-paste index entry. The sdk dependency is a path
  dep while staged; it flips to the crates.io version at extraction (both
  SDK crates publish with the first marketplace release).

The workflows under each `.github/` are inert while staged (GitHub only
reads workflows at the repo root).
