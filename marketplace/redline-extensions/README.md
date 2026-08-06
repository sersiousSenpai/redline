# redline-extensions

The curated index for Redline's extension marketplace. Redline's Extensions
dialog (Settings → Extensions → Browse) reads `index.json` from this repo's
`main` branch; installing an extension downloads the listed artifact, verifies
its sha256/size/wasm magic against the entry, and generates the on-disk
manifest **from the index entry** — the artifact never carries its own, so a
listing can't lie about what it will be granted.

## Trust model (v1)

- **Human PR review on this repo is the trust root.** Every listing and every
  version bump is a reviewed diff.
- CI (`scripts/validate.mjs`) re-verifies each PR mechanically: schema, name
  rules, strict semver, artifact sha256 + exact size + wasm magic, scope and
  event vocabularies, the ≤5 MB artifact cap, and a permissive-license
  allowlist (mirrored from Redline's `deny.toml`).
- Redline re-verifies all of it again at install time, and every capability
  call an installed extension makes goes through Redline's authorized local
  control plane with a per-boot scoped token — an extension can use exactly
  the scopes its listing declared, nothing else.
- Artifact **minisign signatures are v2**; they are not part of this schema.

## Listing an extension

1. Build your `.wasm` with the [`redline-extension-template`] workflow — it
   compiles `wasm32-unknown-unknown`, computes the sha256, drafts a GitHub
   release with the artifact, and prints a ready-to-paste index entry.
2. Open a PR adding that entry to `index.json`.

## Schema — `redline.extension-index/1`

```json
{
  "schema": "redline.extension-index/1",
  "extensions": [
    {
      "name": "plan-greeter",
      "version": "0.1.0",
      "publisher": "acme",
      "repo": "https://github.com/acme/plan-greeter",
      "artifact": {
        "url": "https://github.com/acme/plan-greeter/releases/download/v0.1.0/extension.wasm",
        "sha256": "…64 lowercase hex chars…",
        "size": 48213
      },
      "scopes": ["plan.comment", "ui.panel"],
      "events": ["plan.received"],
      "api_version": 1,
      "license": "Apache-2.0",
      "min_redline": "0.1.0",
      "description": "Greets every plan that arrives for review.",
      "changelog": "https://github.com/acme/plan-greeter/releases"
    }
  ]
}
```

- `name` — `^[a-z0-9_-]{1,32}$`, unique across the index; also the install
  directory name under `~/.redline/extensions/`.
- `version`, `min_redline` — strict `major.minor.patch` (no `v`, no
  pre-release tags).
- `artifact` — a raw `.wasm` release asset on the extension's own repo
  (https), at most 5 MB.
- `scopes` / `events` — must be subsets of Redline's closed vocabularies
  (see `docs/extensions-api.md` in the redline repo).
- `api_version` — the extension ABI major version (currently 1).
- `license` — SPDX id from the permissive allowlist in
  `scripts/validate.mjs`.

Updates are never automatic: Redline shows the new version's full scope and
event list (plus `changelog`) and re-asks for consent before installing.

[`redline-extension-template`]: https://github.com/sersiousSenpai/redline-extension-template
