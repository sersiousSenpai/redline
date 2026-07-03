# Local-only audit (cold-wallet posture)

Redline's promise is that your work stays on your machine. This document
enumerates every network and cross-process touchpoint, so the "local-only"
claim (README.md, SPEC.md) is auditable rather than asserted. It is maintained
alongside the code; a change that adds egress must update this file.

The Polis prompt-store + ledger program (Phase 1) is built to preserve this
posture: it adds **no new Redline-originated network operation**. The capture
hook POSTs to loopback; the backup routine writes to local disk.

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

## Local-disk touchpoints (no egress)

| Touchpoint | Notes |
|---|---|
| `redline.db` (SQLite) | The prompt store + ledger + all app state. Under the OS app-data dir. |
| **DB snapshots** | **New (Phase 1).** `VACUUM INTO` dated files under `<app-data>/backups/`, newest `LEDGER_BACKUP_KEEP` retained. See restore below. |
| Whisper / Apple dictation | Transcription is on-device (whisper.cpp/Metal; Apple `SFSpeechRecognizer` on-device). |
| Read-only file viewer / file explorer | Reads files the user opens; no writes outside the user's own edits. |

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

## External-session capture toggle

The UserPromptSubmit hook is global, so it also sees `claude` sessions outside
Redline's tracked projects. Those are tagged `origin=external` and stored only
while `redline.capture.externalSessions` is on (default on; toggle in the Ledger
pane footer). Nothing about capture leaves the machine either way.
