# History loading and chat progress repair — 2026-09-09

## History incident

The running app opened the correct database, but its session list was empty.
The database still held 245 sessions, 474 revisions and 321 comments.

An older migration lineage had already written `PRAGMA user_version = 2`.
The new runner migration reused that number. Its fast path skipped the migration
even though `sessions.effort` and the native runner tables were absent.
`SessionStore::new` then discarded the resulting query error and constructed an
empty store. The history HTTP endpoint also converted database errors to 404.

The repair adds migration 3, which applies the idempotent additions and verifies
the schema before advancing the stamp. The current-version path verifies shape
without running DDL. Session hydration now propagates failure; desktop startup
records a specific boot error instead of exposing an empty session store. The
history endpoint returns 500 for a read failure and reserves 404 for an unknown
session ID.

Before any repair, a consistent SQLite backup was created outside the rotating
backup directory at:

`~/Library/Application Support/com.redline.app/recovery/before-history-migration-20260909-9bce7e9f.db`

An opt-in test migrated a separate copy, loaded all 245 sessions, 474 revisions
and 321 comments, compared every original history field, and passed SQLite's
integrity check. The recovery backup was not modified. After restarting the
actual app, its database reported schema 3 and the same record counts; the live
agent registry contained 245 loaded plans and a known plan's history endpoint
returned its revision successfully.

## Chat delay and visibility

The reported chat turn took about 403 seconds before its only visible text.
Its transcript metadata recorded 48 model requests and 64 tool calls: 39 Bash,
20 Grep and 5 Read, with 11 tool errors. Tool execution accounted for about seven
seconds. Repeated investigation and model requests dominated the delay; this was
not a six-minute database query.

Chat now keeps a progress panel beside the composer throughout the turn,
including after an early public message. It shows elapsed time, current public
activity, tool-call count, recent activity and Stop. It distinguishes active reply
generation from a quiet period and never displays private reasoning text.

Every chat turn also receives a bounded snapshot of stored history counts and
the loaded session count. Database errors remain unknown values, not zero.
Instructions request brief public progress updates before extended work and
discourage repeated unsupported or denied probes without new evidence. The
selected model and effort are unchanged. This removes the need for the repeated
count probes seen here; no new-turn latency benchmark is claimed.

## Validation

- History/error-handling library run: 1,217 tests passed, plus the opt-in recovery
  copy test. It covers the exact old schema stamped 2 and preservation of records.
- Final chat Rust tests: 22 passed.
- Chat progress, wiring and shared turn-lifecycle tests: 32 passed; TypeScript
  check passed.
- Final frontend suite: 1,960 tests passed across 165 files.
- Shared report construction: 42 runner tests passed, including complete JSON
  field/null preservation and meter-history checks. The final executable size
  was unchanged by this refactor; no measured size saving is claimed.
- Visual QA used the actual ChatRoom, turn hook and production CSS with stubbed
  native IPC at 1366×768 and 360×760. Pre-text waiting, thinking/tool status,
  elapsed time, expanded recent activity, Stop and the composer stayed visible;
  progress remained after reply text. No paid chat was sent and no live state
  was changed. Existing header Close clipping at 360px is outside this change.
- `CARGO_INCREMENTAL=0 npm run tauri build` passed and produced
  `src-tauri/target/release/bundle/macos/Redline.app` with all repairs.
- Release and bundled executables both measure 36,004,416 bytes, compared with
  the pre-repair four-plan artifact's 35,987,600 bytes (+16,816 bytes overall).
  After independent review, the native ceiling increased from 36,000,000 to
  36,050,000 bytes (+0.139%), leaving 45,584 bytes of headroom. This is a deliberate
  cost for the history recovery/error handling and chat diagnostics/progress;
  no section-level attribution is claimed. Frontend ceilings remain unchanged.
- `node scripts/check-size.mjs --strict` passed: native 36.00/36.05 MB, boot
  JavaScript 0.58/0.66 MB and total frontend assets 8.28/8.50 MB.

The repaired development app is running against the original database. Source
changes remain uncommitted.
