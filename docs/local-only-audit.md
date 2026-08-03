# Local-only audit (cold-wallet posture)

Redline's promise is that your work stays on your machine. This document
enumerates every network and cross-process touchpoint, so the "local-only"
claim (README.md, SPEC.md) is auditable rather than asserted. It is maintained
alongside the code; a change that adds egress must update this file.

The Polis prompt-store + ledger program (Phase 1) is built to preserve this
posture: it adds **no new Redline-originated network operation**. The capture
hook POSTs to loopback; the backup routine writes to local disk.

The Polis context-access + portability layer (Phase 4) also adds **no new
egress**. Its two new touchpoints are both local: the **memory mirror** writes
plain-markdown notes to a user-chosen local directory, and the **MCP server** is
a stdio proxy (`redline-mcp`) that binds nothing and only forwards localhost
GETs to the daemon on behalf of an external `claude` session. Both are
enumerated below.

## The daemon binds loopback only

Redline runs a local HTTP daemon that Claude Code's hooks and Redline's own
agents talk to. It binds **`127.0.0.1:7676`** — the loopback interface, never a
routable one.

- Bind site: `lib.rs` `run_server`, `TcpListener::bind(DAEMON_ADDR)`.
- Pinned by the test `daemon_binds_loopback_only` (asserts the address is
  loopback). Changing it changes the invariant, visibly.

## Loopback-only touchpoints (no egress)

| Touchpoint | Direction | Notes |
|---|---|---|
| ExitPlanMode hook → daemon | Claude Code → `127.0.0.1:7676/v1/plan` | The held-plan review loop. |
| **UserPromptSubmit capture hook → daemon** | Claude Code → `127.0.0.1:7676/v1/prompts/ingest` | **New (Phase 1).** Command-type curl, `--max-time 1`, always `exit 0` (fail-open). Payload is the hook's own stdin JSON. |
| Agent curl bridge → daemon | browse/mission/linked/code agents → `127.0.0.1:7676/*` | Scoped `Bash(curl -s http://127.0.0.1:7676/*)` allow; localhost only. |
| Restore / agent-in-doc curl | Claude Code → `127.0.0.1:7676/*` | Same scoped allow. |
| **MCP proxy → daemon** | **`redline-mcp` (external session) → `127.0.0.1:7676/v1/context/*`, `/v1/memory/*`** | **New (Phase 4).** A stdio JSON-RPC proxy (`src/bin/redline-mcp.rs`) an *external* `claude` session installs. It **binds nothing**, holds no data, and issues only read-only localhost GETs (override target via `REDLINE_DAEMON_ADDR`, still loopback). Internal agents keep `--strict-mcp-config` and never use it. |

## Local-disk touchpoints (no egress)

| Touchpoint | Notes |
|---|---|
| `redline.db` (SQLite) | The prompt store + ledger + all app state. Under the OS app-data dir. |
| **DB snapshots** | **New (Phase 1).** `VACUUM INTO` dated files under `<app-data>/backups/`, newest `LEDGER_BACKUP_KEEP` retained. See restore below. |
| Whisper / Apple dictation | Transcription is on-device (whisper.cpp/Metal; Apple `SFSpeechRecognizer` on-device). |
| Read-only file viewer / file explorer | Reads files the user opens; no writes outside the user's own edits. |
| **Portable memory mirror** | **New (Phase 4).** `mirror.rs` writes plain-markdown notes to the user-chosen `redline.mirrorDir` (off until chosen). **One-way only** — Redline writes, never reads vault edits back — and fully regenerable from the ledger. Only the managed `sessions/`, `missions/`, `unfiled/` subdirs are touched. |
| **Export bundles** | **New (Phase 4).** `export_context_bundle` writes a self-verifying JSON bundle to a path the user picks in a save dialog. No automatic location, no egress. |

## Pre-existing egress (NOT introduced by this program)

These predate the Polis program and are user-initiated or opt-in. Listed for a
complete picture; none is a Redline telemetry channel.

| Source | Egress | Trigger |
|---|---|---|
| `update.rs` | `git fetch` against the repo remote | Update-check menu action. |
| Embedded browser (WKWebView) | Loads pages the user navigates to | User browsing. |
| Agent `WebSearch` / `WebFetch` tools | Web requests by the spawned research agents | User-initiated research turns. |
| `tts.rs` | ElevenLabs / OpenAI speech APIs | Only when the user configures an API key and selects that engine. |
| `tts.rs` (Kokoro), `dictation_whisper.rs` | One-time model download (GitHub / Hugging Face) | Only when the user enables that local engine; the model then runs offline. |
| `codehealth.rs` — the **Shipwright digest**, Tier A | Redacted excerpts of the user's own reopen notes and edit pairs, baked into the Shipwright's model prompt | Only when the user clicks the Shipwright. |

> **The Shipwright digest is the one egress this program adds**, and it is the
> only one that carries the user's own prose. Reopen notes and edit pairs are
> text *they* wrote that had only ever lived on this disk. So
> `codehealth::redact_evidence` (a pure function with its own tests) caps each
> quote at **240 characters**, allows at most **3 quotes per signal**, and strips
> paths, URLs and absolute-home prefixes. Counts and round numbers pass through
> whole — the number is the signal; the prose is only illustrative.

Worth noting while here: this table lists agent `WebSearch`/`WebFetch` but **not
agent model calls at all**. Every spawned `claude` turn sends its prompt to a
model API, and that has always been true of every agent Redline runs. It is a
pre-existing gap in this document, worth its own fix, and deliberately not
folded into the Shipwright's row above — which would have quietly made the new
egress look like the whole story.

There is **no** analytics, crash-reporting, or licensing phone-home.

## Backup & restore (protecting the chain)

The ledger is append-only and hash-chained: a corrupted `redline.db` would
otherwise be unrecoverable. The snapshot routine is the crown-jewels backup
(the memory mirror and export bundles are secondary content copies).

- **When:** once at startup, every 6 hours on a background thread, and once more
  on app quit.
- **Where:** `<app-data>/backups/redline-<unix-ms>.db`.
- **Retention:** newest `LEDGER_BACKUP_KEEP` (7); older snapshots are pruned.
- **Restore:** quit Redline, replace `<app-data>/redline.db` with the chosen
  `backups/redline-*.db` (rename it to `redline.db`), relaunch. Open the Ledger
  pane and click **Verify chain** — a green result confirms the restored chain
  is intact.

### The Bookshelf is data, not cache

Until the Bookshelf, every byte Redline owned was either **rebuildable** (the
memory mirror, from the hash chain) or **incidental** (thumbs). The Bookshelf is
neither: the documents you author, revisit and launch live in
`drafts.doc_json` — it *is* the data, and `drafts.doc_markdown` is only a
derived mirror. So it is named here alongside `redline.db`, because the mirror
could afford to be casual precisely by being disposable and this cannot.

- **What to back up:** `<app-data>/redline.db` (the documents themselves) **and**
  `<app-data>/bookshelf/<draft_id>/` (files attached to a document). They are one
  backup unit, in the same directory as `attachments/` and `thumbs/`.
- **What replaced localStorage:** the TipTap fidelity source used to live in the
  webview's localStorage, where a cache clear wiped it. A one-time,
  frontend-initiated migration (flagged in `app_settings` as
  `redline.bookshelf.migrated`, so it survives that same cache clear) moved it
  into the DB. Nothing about this touches the network.
- **Deletes have no undo:** deleting a document or a folder cascades through its
  discussion thread, comments, pending suggestions and sources, and destroys the
  only copy of the document. Both are gated behind a typed-name confirm that
  names the counts first.

## Friction telemetry (`friction_events`) — local, and not the ledger

Redline computes a lot of failure information at runtime and used to throw all
of it away: a stall-killed agent, a context overflow, an Ask-mode violation, a
malformed resolutions block, a fired revise watchdog, a turn timeout, a 401, a
rejected memory proposal, a contained React render crash. `tracing` wrote some
of it to **stderr**, which goes nowhere when Redline is launched from
`/Applications`.

`friction_events` records them so the Shipwright's digest can rank real pain
instead of guessing. Three properties, stated so they aren't relaxed later:

- **It never leaves the machine.** No new egress; it is a local SQLite table in
  the same `redline.db` as everything else.
- **It is deliberately NOT hash-chained into the ledger.** The ledger records
  *decisions*; a stall-kill is not a decision. Mixing telemetry into the chain
  would dilute exactly the thing the chain is for.
- **It is self-bounding.** Prune-on-insert keeps the newest 5,000 rows and
  nothing older than 90 days, modelled on `context_journal`. No sweeper task, no
  unbounded growth. `detail` is capped at 500 characters at write time.

## External-session capture toggle

The UserPromptSubmit hook is global, so it also sees `claude` sessions outside
Redline's tracked projects. Those are tagged `origin=external` and stored only
while `redline.capture.externalSessions` is on (default on; toggle in the Ledger
pane footer). Nothing about capture leaves the machine either way.

## MCP server (`redline-mcp`)

The MCP server ships with core as a separate binary target in the `src-tauri`
crate (`src/bin/redline-mcp.rs`), built by the same `cargo` build as the app. It
is a **stdio** proxy: an external `claude` session spawns it, and it forwards
each tool call as a read-only localhost GET to the running daemon. It opens no
listening socket and stores nothing.

- **Path:** the app resolves it next to the main executable (`resolve_mcp_bin`),
  and the settings surface hands the user a `~/.claude.json` snippet pointing at
  that path. **Packaging note:** the release `.app`/DMG bundle must co-locate the
  `redline-mcp` binary beside the app binary for the snippet's path to resolve
  for end users (a dev `cargo build` already places both in `target/<profile>/`).
- **Internal agents are unaffected:** they keep `--strict-mcp-config` and reach
  the same routes over the curl bridge. Re-enabling MCP for internal roles is
  deliberately rejected (see `docs/protocol-verification.md`).
