# Extension marketplace (Elevation B4)

How Redline discovers, verifies, installs, and revokes marketplace
extensions. The WASM host itself (isolation, events, the single authorized
dispatch path) is B3 — see `docs/extensions-api.md`; this page is the
distribution layer on top of it.

## Shape

- **Registry**: the `redline-extensions` repo (staged under
  `marketplace/redline-extensions/` until the public launch, which follows
  the first signed DMG). One `index.json`, schema
  `redline.extension-index/1`. Artifacts are raw `.wasm` release assets on
  each extension's own repo.
- **In-app**: `src-tauri/src/marketplace.rs` + the Browse tab of
  Settings → Extensions (`ExtensionsPanel.tsx`). Two Tauri commands, both
  async and perf-guarded: `marketplace_index` (fetch-or-cache, manual
  refresh) and `marketplace_install` (consent-bound install/update).
- **Publisher story**: the `redline-extension-template` repo (staged under
  `marketplace/redline-extension-template/`): a working extension on the
  publishable SDK whose release workflow builds `wasm32-unknown-unknown`,
  computes the sha256, drafts the GitHub release, and prints the
  ready-to-paste index entry. An author never reads `extension_host.rs`.

## Trust model (v1)

Human PR review on the index repo is the trust root. Mechanical layers
under it, outermost first:

1. **Registry CI** (`scripts/validate.mjs`): schema, name rules
   (`^[a-z0-9_-]{1,32}$`, unique), strict `major.minor.patch` semver,
   artifact sha256 + exact size + wasm magic (it downloads each artifact),
   the ≤5 MB artifact cap, scope/event vocabulary subsets, and an SPDX
   license allowlist. The vocabularies and allowlist are mirrors of
   `redline-extension-abi` and `deny.toml`; drift tests in `marketplace.rs`
   pin them while the tree is staged here.
2. **App-side index validation** (`parse_index`): the same rules re-checked
   on every read, skip-with-warning per entry — a curated-repo compromise
   still can't smuggle an unknown scope or an oversized artifact into the
   consent dialog.
3. **Consent binding**: the dialog shows every scope and event in plain
   language (descriptions come from the ABI crate, where tests forbid an
   undescribed name), the artifact sha256, size, license, and publisher
   link. `marketplace_install` carries that sha256 and refuses if the
   cached index entry no longer matches it.
4. **Byte verification** (`verify_artifact`): sha256, exact size, and the
   `\0asm` magic, checked against the consented entry before anything is
   written. A mismatch refuses the install — there is no "install anyway".
5. **Generated manifest**: `extension.json` is written *from the index
   entry* (`manifest_for`), never shipped inside the artifact — so there is
   no artifact/manifest mismatch class, and what the user consented to is
   exactly what the host grants.
6. **The B3 host underneath**: per-boot scoped token, fail-closed
   `ROUTE_TABLE`, fuel/memory caps, three-strikes isolation. The
   marketplace adds no capability surface of its own.

Artifact **minisign signatures are v2**, deliberately out of this schema.

## Lifecycle

- **Install**: download → verify → write `~/.redline/extensions/<name>/`
  (module + generated manifest) → mint token + `register_grant` →
  `extension_host::load_one` — hot-registered, **no relaunch**.
- **Update**: never automatic. The launch check (below) and the Browse tab
  only *mark* `update_available`; installing re-runs the full consent
  dialog with the new version's grants (+ changelog link). The old
  registration is dropped and its token revoked (`auth::revoke_grant`)
  before the new version is written.
- **Uninstall**: drop from the registry, `auth::revoke_grant` (immediate —
  per-boot rotation alone is too slow for an explicit uninstall), delete
  the folder. A revoked token is `BadToken` to `authorize()` from that
  moment.
- **Enable/disable**: unchanged from B3 (persisted in
  `app_settings.extensions.disabled`; marketplace installs respect it).

## Index cache + the launch check

The fetched index document is cached in SQLite
(`app_settings.marketplace.index.cache` + `….fetched_ms`). The Browse tab
serves the cache and offers manual Refresh; a fetch failure falls back to
the cache with a warning instead of an error wall.

**Local-only posture** (see `docs/local-only-audit.md`): Redline never
fetches the index until the user first opens Browse. The boot-time
update-check runs only when a cache already exists, is metadata-only, and
at most notes friction (`extension_update_available`) + refreshes the
Extensions dialog badge state. A user who never opens Browse never
generates marketplace traffic.

`REDLINE_EXTENSIONS_INDEX_URL` overrides the index URL for development and
the e2e matrix — honored only for https or loopback URLs.

## Verification

- `marketplace::tests` — semver strictness, `min_redline` gating, the
  validation matrix (skip-with-warning), sha/size/magic refusal, generated
  manifests round-tripping through the real `extension.rs` validator,
  install-state enrichment, and the validate.mjs / deny.toml drift guards.
- `auth::tests::revoked_grant_token_is_denied`,
  `extension_host::tests::load_one_hot_registers_and_delivers` — the
  revocation and hot-register seams.
- `extension_host::tests::template_artifact_delivers_through_the_sdk_bridge`
  (`cargo test -- --ignored template_artifact`, after
  `marketplace/redline-extension-template/build.sh`) — the REAL template
  artifact, built through the SDK's `export!` bridge, delivering through
  the genuine middleware.
- Manual GUI matrix: browse → consent → install → event → visible write →
  update (re-consent) → uninstall (token dead), against a local index via
  the env override.
