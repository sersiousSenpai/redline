# Perf-hardening handoff — execute Phases 3 → 5

**You are a fresh session asked to "proceed with Phase 3" (and on through Phase 5,
the end).** This doc is self-contained: read it top to bottom and execute. The
full approved plan is at `~/.claude/plans/right-when-it-started-mighty-storm.md`;
continuity is in memory `project_redline_perf_hardening`.

## Why this work exists

Redline's UI is a single Tauri WebView whose one main thread is shared by the
editor, embedded terminals, file tree, and viewer. Two paths did **unbounded
synchronous work on that thread** and froze the *entire* app (down to the macOS
fullscreen button). We're fixing it the VS Code / Cursor way, adapted to Tauri.

**Governing rule:** *the WebView main thread renders; it never computes or buffers
unboundedly.* → heavy compute goes to Rust (or Web Workers); large content is
virtualized; streams are bounded, batched, and backpressured over per-stream
channels.

**Locked decisions:** Rust `syntect` for highlighting (done); **single window +
Rust task registry** (not multi-window); build all five phases.

## Already done — DO NOT redo (Phases 1–2)

Freeze vector #1 (large-file viewer) is fixed:
- `src-tauri/src/highlight.rs` — `syntect` tokenizer, mtime-keyed cache, paged
  `open_doc` / `doc_lines`, scope→`hljs-*` mapping. Registered in `lib.rs`
  (module, `Highlighter` state, two commands).
- `src/components/CodeView.tsx` — rewritten as a **virtualized paged viewer**
  (only visible lines in the DOM; token chunks fetched per scroll window).
- `src/lib/virtual.ts` (+ `.test.ts`) — windowing helpers.
- `src/hooks/useFsWatch.ts` — shared `useLiveFile` (debounced live reload).
- `src/components/FileViewer.tsx` — rewired; markdown keeps its full-read path.

Status: Rust 110 tests + FE 113 tests + `tsc` + `vite build` all green. GUI is
user-verified separately — assume the viewer works; don't touch it unless a
regression is reported.

## Baseline commands (run from repo root `/Users/yusufalbazian/redline`)

- Frontend typecheck: `npx tsc --noEmit`
- Frontend tests: `npx vitest run`
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml`
- Frontend build: `npm run build`
- DO NOT launch the built `.app` or run a second app instance (user rule). The
  user runs the GUI; you verify via tests + builds and hand off GUI checks.

Keep every phase green before moving to the next. Commit only if the user asks.

## ⚠️ Tauri threading gotcha (learned the hard way)

A plain `#[tauri::command]` (non-async) **runs on the main thread** and freezes the
UI (macOS beach ball) for any non-trivial work. This already bit us: `open_doc`
tokenized 57k lines on the main thread → 1–2 s beach ball. Fix applied: mark
CPU/IO-heavy commands `#[tauri::command(async)]` so the body runs on a worker
thread (`open_doc`, `doc_lines`, `list_dir`, `read_text_file`, `read_file_base64`
are now `(async)`).

**Rule for Phases 3–5:** any new command that reads files, encodes, parses, or
otherwise does real work MUST be `#[tauri::command(async)]` (or genuinely async).
Phase 5 should add this as an explicit guardrail. The PTY pump already runs on its
own `std::thread`, so it's fine — but anything new you add isn't, by default.

---

## Phase 3 — Flow-controlled, GPU terminal (freeze vector #2) — ✅ DONE (2026-06-08, GUI-unverified)

**Shipped:** `pty.rs` reader pump rewritten — raw PTY bytes → `Coalescer` (batch)
→ a flusher thread that drains once per `COALESCE_WINDOW` (8 ms) and pushes one
raw-byte message per drain over a **per-terminal `Channel<tauri::ipc::Response>`**
(`Response::new(bytes)` → `ArrayBuffer` on JS; verified raw-byte semantics against
tauri 2.11.1 source — `Channel<Vec<u8>>` would JSON-bloat via the blanket
`impl<T: Serialize>`, so `Channel<Response>` is required). ACK-based flow control
(`Flow` + new `pty_ack` command; reader parks at `FLOW_HIGH_WATER` = 256 KB
unacked, 200 ms stall-valve) pauses reading when the renderer lags. `pty-output`
global event + base64 gone. `TerminalView.tsx`: `Channel<ArrayBuffer>`, write
straight to xterm, ACK in the `term.write` callback; `@xterm/addon-webgl` loaded
with try/catch + `onContextLoss` fallback; `base64ToBytes` removed. Guards:
`Coalescer`/`Flow` unit tests + `perf_guard.rs`. Rust 116 + FE 113 + tsc + build
green. **GUI firehose check still owed by Yusuf:** `yes | head -n 5000000` in an
embedded terminal stays responsive; multiple terminals + a scrape stay smooth.

<details><summary>Original Phase 3 brief (kept for reference)</summary>

**The bug:** `src-tauri/src/pty.rs` reader pump emits **one global Tauri event per
≤8 KB read, unbatched** (`app.emit("pty-output", …)`), and every mounted
`TerminalView` runs a listener for every event, decoding base64 with a
**per-character JS loop** (`base64ToBytes` in `src/components/TerminalView.tsx`).
A burst of stdout floods the main thread.

**⚠️ RESEARCH FIRST — do not guess.** Before coding, confirm Tauri v2
`tauri::ipc::Channel` raw-byte semantics (does the JS side receive an
`ArrayBuffer`? how are bytes sent from Rust without JSON-array bloat?). Use the
`claude-code-guide` agent or WebFetch the Tauri v2 Channels + IPC docs. Getting
this wrong breaks the terminal that hosts `claude`. If raw-byte channels are
awkward, the acceptable fallback is: keep `emit` but **batch** in Rust (below)
and replace the per-char decoder — that alone removes most of the freeze.

**Steps:**
1. **Batch the Rust pump** (`pty.rs`): in the reader thread, accumulate bytes and
   flush at most every ~8–16 ms OR when the buffer hits a size threshold
   (e.g. 64 KB), instead of emitting per read. A stdout burst becomes a few large
   messages, not thousands of tiny ones. (A small timer/`Instant`-based coalescer
   in the read loop.)
2. **Per-terminal `tauri::ipc::Channel`** (pending the research above): change
   `pty_spawn` to accept a `Channel` from the frontend and push output to it
   instead of the global `pty-output` event. One subscriber per terminal → no
   N-tab fan-out, no id filtering. Carry **raw bytes** to drop base64 and the
   per-char `base64ToBytes` loop. Keep `pty-exit` handling equivalent.
3. **Frontend** (`TerminalView.tsx`): create a `Channel` in the mount effect, pass
   it to `pty_spawn`, write incoming bytes straight to xterm. Remove
   `base64ToBytes` and the global `listen("pty-output")` fan-out.
4. **xterm flow control:** use `term.write(data, callback)` and pause/resume the
   PTY when the renderer falls behind (ACK-style — see xterm `FlowControl` docs).
   Add a `pty_pause`/`pty_resume` or a bounded channel so Rust stops reading when
   the consumer lags.
5. **GPU rendering:** `npm i @xterm/addon-webgl`; load it in `TerminalView`
   (`term.loadAddon(new WebglAddon())`) with a try/catch fallback to the default
   renderer (WebGL can fail on some GPUs/contexts; also handle `onContextLoss`).

**Verify:** `cargo test`, `vitest`, `tsc`, `npm run build` green. Add a Rust unit
test asserting the pump coalesces (e.g. the batching helper). Hand the user a GUI
check: run `yes | head -n 5000000` (or `cat` a big file) in an embedded terminal —
UI stays responsive, output correct; multiple terminals + a scrape at once stay
smooth.

smooth.

</details>

---

## Phase 4 — Parallel-workload foundation (task registry) — ⏸️ DEFERRED BY DESIGN (2026-06-08)

**Decision (Yusuf, 2026-06-08):** defer until the consumer surfaces (native
browser, cron-job GUIs, localhost orchestration) actually exist — building the
registry speculatively risks over-engineering an API before its consumers. The
two freeze vectors are already fixed by Phases 1–3. Revisit when the first such
surface lands; the brief below is the starting point when that happens.

**FIRST: confirm timing with the user.** Recommended engineering call (state it,
get a yes): **defer Phase 4** until the surfaces it serves (native browser,
cron-job GUIs, localhost orchestration) actually exist — its value only
materializes alongside them, and building it speculatively risks over-engineering.
If the user wants it now, proceed:

1. **Rust task/process registry** with bounded worker pools (tokio tasks or a
   thread pool). Every long-running job (scrape, cron run, localhost process,
   browser automation) is a registered task with an id, status, and **its own
   `Channel`** streaming progress with backpressure.
2. **Single-window UI** subscribes per task and renders throttled/virtualized
   summaries — never per-process heavy work on the UI thread. Keep surface state
   modular so a future split into separate Tauri windows is cheap; don't build
   multi-window.
3. **"Slow" UX layer:** a global activity/busy model fed by task + channel state —
   per-surface spinners/progress, "output throttled (backpressure)", "highlighting
   paused (large file)". Informative, never blocking.

**Verify:** unit-test the registry (bounded concurrency, backpressure, task
lifecycle); FE tests for the busy model. GUI check: start several tasks at once;
UI stays smooth with independent per-task progress.

---

## Phase 5 — Perf guardrails (the end) — ✅ DONE (2026-06-08)

**Shipped:** `docs/perf-budget.md` (the 4 rules incl. the Tauri `(async)` threading
rule + reviewer gate + CI commands); `src-tauri/src/perf_guard.rs` regression tests
(heavy commands stay `(async)`; PTY output stays batched over a Channel, no
`pty-output` per-read emit); `Coalescer`/`Flow` unit tests cover PTY batching;
`src/lib/virtual.test.ts` already covers viewer windowing. All suites + build green.

<details><summary>Original Phase 5 brief</summary>

1. Add a short perf-budget doc (e.g. `docs/perf-budget.md`) + a review rule:
   - no synchronous iteration over file-sized data on the main thread;
   - no `dangerouslySetInnerHTML` of unbounded content;
   - every high-frequency backend→frontend stream must be batched over a Channel.
2. Add lint/tests where feasible — e.g. a test asserting the PTY pump batches, and
   a viewer cap/virtualization test (extend `src/lib/virtual.test.ts`).
3. Add the **Tauri threading rule** to the perf-budget doc: heavy commands must be
   `#[tauri::command(async)]` (see the gotcha section above). Consider a grep-based
   check that flags a non-async command doing fs/encode work.

**Verify:** all suites + build green.

</details>

## Definition of done (whole effort)

**Status (2026-06-08): code-complete.** Phases 1–3 + 5 DONE; Phase 4 deferred by
design (above). All tests + `tsc` + `npm run build` green (Rust 116, FE 113).
**Remaining: Yusuf's GUI verification** — (a) large files open instantly and stay
interactive ✅ (Phase 2, already verified); (b) a terminal firehose keeps the UI
responsive (Phase 3, **owed**: `yes | head -n 5000000` + multi-terminal + scrape);
(c) parallel workloads stay smooth (Phase 4, n/a until built).

> Note: this reflects the decisions locked on 2026-06-08. The user mentioned
> upcoming feedback that may amend scope — if their guidance differs from this
> doc, their latest direction wins; update this doc accordingly.
