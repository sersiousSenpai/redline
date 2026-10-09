# Contributing to Redline

Thanks for your interest in improving Redline. This guide covers how to build, test, and
submit changes.

## Contributor License Agreement (required)

**Every pull request is gated by a CLA check.** Before your first contribution can be
merged, you must agree to the [Redline Contributor License Agreement](CLA.md), a
copyright-assignment CLA that keeps the Project's copyright unified in a single owner of
record.

You don't sign anything manually. When you open a pull request, the CLA Assistant bot
checks whether you've already agreed. If not, it comments with instructions. To agree,
post a pull-request comment containing exactly:

> I have read the CLA Document and I hereby sign the CLA

One signature covers all of your present and future contributions. If you contribute as
part of your employment, see the "Corporate CLA" section of [CLA.md](CLA.md) first.

## Development setup

Prerequisites: a recent **Node.js** (with `npm`) and the **Rust** toolchain (`rustup`,
stable). Tauri 2 system dependencies must be installed for your platform — see the
[Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm install            # install JS dependencies
npm run tauri dev      # run the desktop app in development
```

Other useful commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server (frontend only) |
| `npm run build` | Type-check (`tsc`) and build the frontend |
| `npm test` | Run the test suite (`vitest run`) |
| `npm run tauri build` | Build the production desktop bundle |
| `cargo build --manifest-path src-tauri/Cargo.toml` | Build the Rust backend |

Perf is judged on the release build (`npm run redline`), not `tauri dev` —
see "Which build perf is judged on" in [docs/perf-budget.md](docs/perf-budget.md).

### Keeping `target/` from filling the disk

Rust build output is never collected on its own, and Redline's once reached
~400 GB across worktrees. The dev profile now sets `split-debuginfo = "off"`
(macOS otherwise keeps every object of every incremental rebuild —
rust-lang/rust#161824), and a guard in `src-tauri/tests/size_guard.rs` keeps
it there. What remains is habit:

- **Delete a worktree's `src-tauri/target/` when its branch merges** (or
  remove the worktree). Each worktree builds its own, tens of GB cold.
- **Run `cargo clean --manifest-path src-tauri/Cargo.toml` after a Rust
  toolchain upgrade.** Nothing built by the old compiler is reused.
- Each new build configuration still adds about 0.5 GB (an rlib plus a test
  executable); that is bounded, but it is why an old `target/` is worth
  clearing now and then.

## The review-protocol skill

`skills/redline/SKILL.md` is the canonical Redline review-protocol skill — the
contract handed to Claude Code sessions whose plans are reviewed in Redline. The
Rust backend embeds it at compile time (`include_str!`) and the in-app installer
writes it to `~/.claude/skills/redline/SKILL.md`.

`.claude/skills/redline` and `.agents/skills/redline` are **symlinks** to the
canonical `skills/redline/` directory, so a Claude Code (or other) agent working
in this repo loads the skill too. Edit only the canonical file — the symlinks
follow automatically. On Windows checkouts git may materialize the symlinks as
plain text files; that is cosmetic (the canonical file and the app installer are
unaffected).

## Submitting changes

1. Fork the repository and create a topic branch.
2. Make your change. Keep commits focused and write a clear commit message.
3. Add or update tests where it makes sense; ensure `npm test` and the Rust build pass.
4. New first-party source files must carry the SPDX header:
   ```
   // SPDX-License-Identifier: Apache-2.0
   // Copyright 2026 Yusuf Al-Bazian
   ```
5. Open a pull request describing the change and the motivation.
6. Agree to the CLA via the bot comment if you haven't already.

## License

By contributing, you agree that your contributions are assigned and licensed under the
terms of [CLA.md](CLA.md), and that the Project is distributed under the
[Apache License 2.0](LICENSE). Note the trademark reservation in the
[README](README.md#trademark): the code is Apache-2.0, but the Redline name, logo, and
app icon are not.
