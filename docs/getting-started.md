# Getting started

[← Back to the README](../README.md)

The supported setup described here builds from source. Redline is an early macOS release.

## Prerequisites

- macOS 11 or later (Apple Silicon or Intel)
- [Claude Code](https://claude.com/claude-code)
- Node.js 22.12+ and npm (or Node 20.19+; required by Vite 7)
- Rust (stable, via [rustup](https://rustup.rs))
- Xcode Command Line Tools (`xcode-select --install`)
- CMake (`brew install cmake`) for the bundled speech-to-text engine

## Build and install

```bash
git clone https://github.com/sersiousSenpai/redline.git
cd redline
npm ci
npm run redline
```

`npm run redline` builds the app, installs it into **/Applications**, and launches it. From then on, open Redline like any Mac app — Spotlight, Dock, Launchpad. The first build takes several minutes (it compiles the app's native dependencies from source); after that, builds are fast.

**Updating a source build**

```bash
git pull
npm ci
npm run redline
```

Redline also detects a stale installed build from inside the app and can prompt you to update.

## First-run setup

On launch, Redline checks for its Claude Code integration and offers a one-click install that writes:

- a `PreToolUse` hook entry in `~/.claude/settings.json` pointing at the local daemon (plus a few `curl` allow-rules so Redline's own agents can reach the local bridge without prompts)
- the plan-revision skill at `~/.claude/skills/redline-plan-review/SKILL.md`

Both are inspectable, and the hook can be paused from inside the app at any time. The `browse`, `mission`, and `sidecar` skills that govern Redline's browser and research agents ship inside the app.

## Planning backends

The Front Door supports Claude Code, Codex, Cursor, and **Antigravity Preview**. Choose a provider, then use its readiness row to locate the executable, install the integration, or sign in. These are local CLI sessions in Redline's terminal; Cursor and Antigravity's editors are not embedded.

| Provider | CLI and sign-in | User hook file | Planning skill directory |
| --- | --- | --- | --- |
| Claude Code | `claude` | `~/.claude/settings.json` | `~/.claude/skills/redline-plan-review/` |
| Codex | `codex login` | `~/.codex/hooks.json` | `~/.codex/skills/redline-plan-review/` |
| Cursor | `agent login` (`cursor-agent` also supported) | `~/.cursor/hooks.json` | `~/.cursor/skills/redline-plan-review/` |
| Antigravity Preview | Launch `agy` to sign in | `~/.gemini/config/hooks.json` | `~/.gemini/antigravity-cli/skills/redline-plan-review/` |

Installers preserve other integrations and report malformed or conflicting hook files instead of replacing them. Optional executable overrides are `REDLINE_CLAUDE_BIN`, `REDLINE_CODEX_BIN`, `REDLINE_CURSOR_BIN`, and `REDLINE_ANTIGRAVITY_BIN`; environment choices take precedence over the in-app Locate selection.

Codex automatically chooses the newest capable installation, with version/capability results invalidated when its file changes. Its picker reads `codex debug models`; Claude's picker discovers model ids from the installed binary and always retains the four familiar aliases as fallback. Cursor and Antigravity use their own live `models` commands. Changing the selected executable refreshes that provider's catalog.

Claude and Codex discussions fork their own author conversations. Cursor and Antigravity discussions use a clearly labeled **Claude sidecar**, seeded with the current plan and comment; they never resume the held author conversation. Their plan sessions still restore through the original provider. Keep Claude installed for these sidecars and Redline's other Claude-backed surfaces.

Native-provider sidecars have only Read, Grep, Glob, WebFetch, and WebSearch. Shell and Skill tools, additional MCP tools, and arbitrary seat flags are excluded. They cannot curl Redline's memory bridge; the current plan and discussion context are supplied directly. Non-Claude plan consultations use this same boundary.

Cursor Cloud Agents are outside this local-hook integration. Antigravity's later manually typed prompts are not yet captured independently; Redline records its initial launch request. Extension-pack planning remains on Claude. Captured compatibility evidence and the Preview limits are in [the protocol notes](protocol-verification.md).

## Development

Run `npm run tauri dev` for the desktop app with the development frontend. `npm run dev` alone serves the frontend; native browser tabs, terminals, and the local bridge require Tauri.

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

`npm run redline` builds, installs, and launches the application.
