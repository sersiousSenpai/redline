# redline-extension-template

A working Redline WASM extension you can rename and ship. This one greets
every plan that arrives for review with a `[feedback]` comment — the
smallest honest demonstration of the whole contract: an event in, an
authorized control-plane call out.

You never read Redline's host internals to ship an extension. The surface
is three things:

- **`redline-extension-sdk`** — the `Extension` trait, the `export!` macro,
  typed helpers (`sdk::plan::comment(…)` documents the scope it needs), and
  `sdk::testing::MockHost` so `cargo test` runs as plain native Rust with no
  wasm toolchain.
- **`extension.json`** — what your extension may do (`scopes`) and hear
  (`events`). Redline enforces it fail-closed: a call outside your scopes
  comes back `401` no matter what the code says.
- **The events + scopes reference** — `docs/extensions-api.md` in the
  redline repo, generated from the same crate your code compiles against.

## Develop

```sh
cargo test        # your logic, against MockHost
./build.sh        # builds wasm32-unknown-unknown → ./extension.wasm
```

For local end-to-end testing, copy (or symlink) this folder into
`~/.redline/extensions/plan-greeter/` — the folder name must match
`extension.json`'s `name` — and relaunch Redline. Settings → Extensions
shows it running; ExitPlanMode on any Claude Code session makes it comment.

## Rename it

Change the name in three places (they must match): `Cargo.toml`'s
`package.name`, `extension.json`'s `name`, and the folder/repo name.

## Ship it

1. Tag `v<version>` (matching `Cargo.toml`). The release workflow tests,
   builds `wasm32-unknown-unknown`, drafts a GitHub release with
   `extension.wasm`, and prints a ready-to-paste index entry (with sha256
   and size) in the job summary.
2. Publish the draft release.
3. Open a PR adding the printed entry to the `redline-extensions` registry.
   Human review there is the marketplace's trust root; its CI re-verifies
   your artifact's hash, size, and schema.

## Rules of the sandbox

- No WASI: no filesystem, network, environment, or clock. Timestamps ride
  in event payloads.
- Every capability call goes through Redline's authorized local control
  plane with a per-boot token scoped to your manifest.
- Deliveries are sequential, fuel-budgeted, and memory-capped. A trap,
  fuel exhaustion, or `Err` return is a strike; three strikes in one boot
  disable the extension until relaunch.
