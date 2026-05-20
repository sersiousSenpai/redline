# Redline

Redline is a companion app for Claude Code that turns plan-mode review into a Word-style
track-changes workflow. Instead of approving or rejecting a plan in one shot, you can mark
up the plan inline — edits, comments, and decisions — and send structured feedback back
into the session.

## Status

Early development (v0.1). Built with Tauri 2, React, and an embedded axum daemon.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, build, and test instructions.

```bash
npm install
npm run tauri dev
```

## Contributing

Contributions are welcome. **All pull requests are gated by a Contributor License
Agreement** — a copyright-assignment CLA that keeps the Project's copyright unified in a
single owner of record. Agreement is handled automatically by a bot on your first pull
request. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CLA.md](CLA.md).

## License

Redline is licensed under the [Apache License 2.0](LICENSE). See also the [NOTICE](NOTICE)
file. The Apache-2.0 grant covers the **source code only**.

## Trademark

The Apache-2.0 license applies to the code and does **not** grant any rights to the
Redline name, brand, logo, or application icon. "Redline", the Redline name, the Redline
logo, and the Redline application icon are trademarks of Yusuf Al-Bazian and are **not**
licensed under the Apache License.

You may use, modify, and redistribute the source code under Apache-2.0, including for
commercial purposes. You may **not**, without prior written permission, use the Redline
name, logo, or icon in a way that suggests endorsement, affiliation, or that your
derivative work is the official Redline. If you distribute a modified version, please use
a different name and icon. For trademark permission requests, contact
**yab@albazianlaw.com**.
