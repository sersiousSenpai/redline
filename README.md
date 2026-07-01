# Redline

**A document-based IDE for Claude Code.** — [redline.dev](https://redline.dev)

A code IDE puts your source files at the center — editor, terminal, and file tree all arranged around the code. Redline puts the **document** at the center — the plan, the spec, the research brief — and builds the IDE around it: a track-changes editor, an embedded browser, terminals, a file explorer, and a Claude Code agent on every surface. It's where the thinking happens *before* the code.

Redline began as a place to review Claude Code plans, and that loop is still its spine: when Claude Code finishes planning, the plan opens in Redline instead of a terminal prompt — mark it up with Word-style tracked changes and margin comments, ask questions, iterate through revisions, and approve it only when it's right. Your markup flows back into the live session as structured feedback Claude Code can act on precisely. Around that loop, Redline has grown the rest of the arc — research the problem in an AI browser, draft the spec, plan it, and review it — each surface paired with its own Claude Code agent.

![A plan open in Redline's track-changes editor, with tracked edits inline and the comment pane on the right](docs/assets/hero.png)

## Why

In the terminal, your only way to respond to a plan is to type one undifferentiated prose message against a wall of text. There's no way to point at a specific line, no way to attach a comment to the paragraph it's about, and no record of what got addressed across iterations.

Redline was built by a lawyer who wanted to mark up plans the way lawyers redline contracts: tracked changes, margin comments, and nothing accepted until it's resolved.

The underlying bet is that the cheapest place to catch a mistake is *upstream of the code* — in the research, the draft, and the plan. So Redline gives that work a real IDE: rounds of redlines, questions, and revisions, with AI you direct through tracked changes and comments, before any code gets written.

## The surfaces

Redline centers the document and arranges the IDE around it. Each surface pairs with its own Claude Code agent.

- **Research** — An embedded, tabbed web browser where every tab has its own Claude agent that reads *and* drives the page: open links, click, extract, download. Pin what matters as you browse, and a **Mission** orchestrator a tier above the tabs weaves your pins and open tabs into a single research brief.
- **Draft** — A **Prompt Drafter** rich-text surface where loose research becomes a sharp prompt or spec — the seed of a plan, written in a real editor instead of a chat box. The Mission's brief lands here.
- **Plan** — Claude Code's plan opens in a track-changes editor instead of a terminal prompt. Edit text inline (insertions and deletions appear as tracked marks) and attach comments exactly where they apply.
- **Review** — Comments, questions, and structural edits anchored to the exact line. Your Claude Code can post its own edits as tracked **suggestions right in the document** — Accept or Reject in your hands — and every round is resolved before you approve.
- **Voice** — Talk through a plan hands-free: a voice agent that holds the session, push-to-talk dictation, and read-aloud TTS (on-device or cloud).

## How it works (the plan loop)

The plan-review loop is the spine — the round-trip between Claude Code and the document.

1. **Intercept.** Redline installs a `PreToolUse` hook on `ExitPlanMode` in `~/.claude/settings.json`. When Claude Code exits plan mode, the plan is POSTed to a local daemon (`127.0.0.1:7676`) and the request is held open — for up to 12 hours — while you review.
2. **Redline.** The plan opens in a track-changes editor. Edit text inline (insertions and deletions appear as tracked marks), and attach **edits**, **feedback**, **questions**, and **structural changes** (insert, delete, or move whole blocks) exactly where they apply.
3. **Submit.** Two modes: **Ask** sends questions only and guarantees the plan body comes back unchanged; **Revise** sends your full markup and drives a new revision.
4. **Resolve.** Claude Code revises the plan following the `redline` skill contract. The new revision arrives with a resolution attached to each of your comments — accept it, or reopen it with a follow-up note for the next round.

The hook and skills are installed by the app itself: on first run, Redline detects they're missing and offers one-click setup.

## Features

- **Track-changes editor** — Tiptap/ProseMirror with inline suggestion marks, anchored comment threads, and an accept/reopen lifecycle that keeps the history of every round. The document model is CRDT-backed (Yjs), so track-changes are an authored suggestion layer, not a fragile base-vs-current diff.
- **Agent-in-document suggestions** — your Claude Code can propose edits directly in the live plan as tracked suggestions, streamed in while you watch, with Accept and Reject in your hands.
- **Embedded browser with page agents** — real native browser tabs, each with its own Claude agent that can read and drive the page, plus cross-tab research **Missions** that synthesize a Drafter-ready brief from your pins.
- **Prompt Drafter** — a second rich-text surface for turning research into the prompt or spec that seeds a plan.
- **Integrated terminals and file explorer** — real PTY-backed shells (xterm.js) and a sidebar file tree with a fast read-only viewer (syntax highlighting off the UI thread, virtualized for large files), so you can review the plan next to the code it touches.
- **Ask vs Revise round-trips** — question-only rounds never bump the plan version; if the plan body changes during an Ask round, Redline flags the contract violation.
- **Discussion forks** — open a read-only side conversation with the agent on any comment, then attach the outcome to your next submission.
- **Revisions navigator** — browse every version of a plan (v1, v2, …), restore an earlier one, and export any revision as clean Markdown or DOCX.
- **Voice, dictation, and read-aloud** — a voice agent, push-to-talk dictation, and text-to-speech (on-device or cloud).
- **Three interception modes** — Active (hold the session until you decide), Ambient (a claimable auto-approve countdown), and Paused (approve everything, capture nothing).
- **Built to not lose your work** — review state persists through crashes (Yjs + IndexedDB), sessions live in SQLite, and a tray icon shows pending reviews at a glance.

## Installation

There are no prebuilt binaries yet; for now, build from source.

<!-- RELEASES PLACEHOLDER: once binaries are published, replace the line above with a link to the Releases page. -->

**Prerequisites**

- macOS 11 or later (Apple Silicon or Intel)
- [Claude Code](https://claude.com/claude-code)
- Node.js ≥ 20 and npm
- Rust (stable, via [rustup](https://rustup.rs))
- Xcode Command Line Tools (`xcode-select --install`)

**Build and install**

```bash
git clone https://github.com/sersiousSenpai/redline.git
cd redline
npm install
npm run redline
```

`npm run redline` builds the app, installs it into **/Applications**, and launches it. From then on, open Redline like any Mac app — Spotlight, Dock, Launchpad. The first build takes several minutes (it compiles the app's native dependencies from source); after that, builds are fast.

**Updating** (until prebuilt downloads ship):

```bash
git pull && npm run redline
```

Redline also detects a stale installed build from inside the app and can prompt you to update.

**First-run setup**

On launch, Redline checks for its Claude Code integration and offers a one-click install that writes:

- a `PreToolUse` hook entry in `~/.claude/settings.json` pointing at the local daemon (plus a few `curl` allow-rules so Redline's own agents can reach the local bridge without prompts)
- the plan-revision skill at `~/.claude/skills/redline/SKILL.md`

Both are inspectable, and the hook can be paused from inside the app at any time. The `browse`, `mission`, and `sidecar` skills that govern Redline's browser and research agents ship inside the app.

## Local-first

Redline runs on your machine: no account, no telemetry. The daemon binds to `127.0.0.1`, your documents live in a local SQLite database, and every agent is your *own* local Claude Code driven as a subprocess — Redline never calls a model API itself. The only things that reach the network are the ones that inherently must: the embedded web browser, and text-to-speech if you choose a cloud voice (an on-device option is available).

## Status

Redline is an early release (v0.1) under active development. It currently supports **macOS only** — Windows and Linux are on the roadmap but not yet supported. Bug reports and feedback are welcome — please [open an issue](https://github.com/sersiousSenpai/redline/issues).

## Roadmap

Directions we're exploring, in no particular order:

- **Loop orchestrator** — turn an approved plan into parallel, individually-verified subtasks, each executed in an isolated git worktree and graded by an independent reviewer (in progress; not yet shipped).
- **Multiplayer** — several reviewers in one document at once, each paired with their own agent, over a CRDT (Yjs/Hocuspocus).
- **Documents beyond Claude Code plans** — a born-in-app Word-class editor with clean `.docx` export, and eventually high-fidelity import of arbitrary `.docx` files. See [docs/document-ide-northstar.md](docs/document-ide-northstar.md).
- Finer-grained comment anchoring (sentence- and word-level).
- Windows and Linux support.

## Architecture

Redline is a Tauri 2 app: a React 19 + TypeScript frontend and a Rust backend that embeds an axum HTTP daemon (the hook and agent-bridge endpoints), a SQLite session store, portable-pty terminals, and native browser webviews. Every agent surface — plan revision, discussion forks, browser page-discussion, missions, and voice — runs your own local `claude` binary as a subprocess, driven over the `127.0.0.1:7676` bridge. The full as-built specification — including the hook wire protocol, the feedback payload format, and the session lifecycle — is in [SPEC.md](SPEC.md), and the contracts Claude Code follows are in [skills/](skills/) (`redline`, `browse`, `mission`, `sidecar`).

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
