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
