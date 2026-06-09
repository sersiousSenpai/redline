# Perf budget — keep the WebView main thread free

Redline's UI is a single Tauri WebView whose **one main thread** is shared by the
editor, embedded terminals, file tree, and read-only viewer. Twice, a path did
*unbounded synchronous work on that thread* and froze the **entire** app (down to
the macOS fullscreen button): a 1.15 MB / 57k-line JSON tokenized + rendered
synchronously, and a burst of embedded-terminal output emitted one tiny event per
read. The hardening (Phases 1–3) fixed both the VS Code / Cursor way.

> **Governing rule:** the WebView main thread *renders*; it never *computes* or
> *buffers* unboundedly. Heavy compute goes to Rust (or a Web Worker); large
> content is virtualized; high-frequency streams are batched and backpressured
> over a per-stream channel.

This doc is the budget. Treat each rule as a review gate — if a change can't meet
it, that's the discussion to have before merging.

## Rules

1. **No synchronous iteration over file-sized data on the main thread.** Parsing,
   tokenizing, highlighting, diffing, or scanning content whose size is bounded
   only by "whatever the user opens" must not run inline in a React render, an
   event handler, or a non-async Tauri command. Push it to Rust (preferred — see
   `highlight.rs`) or a Web Worker, and return it paged.

2. **No `dangerouslySetInnerHTML` of unbounded content.** Setting innerHTML to a
   string whose length scales with file/stream size forces a synchronous parse +
   layout of arbitrary size. It's acceptable only for **bounded** content (a
   rendered plan, one Mermaid diagram). Large/streamed content must be
   **virtualized** — only the visible window in the DOM (see `CodeView.tsx` +
   `src/lib/virtual.ts`).

3. **Every high-frequency backend→frontend stream must be batched and
   backpressured over a `tauri::ipc::Channel`.** Not a global `app.emit` per
   chunk (every mounted listener wakes for every event), and not base64 / a
   per-char JS decode loop. One `Channel` per stream = one subscriber; carry raw
   bytes (`Channel<tauri::ipc::Response>` + `Response::new(bytes)` → an
   `ArrayBuffer` on the JS side). Coalesce many small reads into ~one-per-frame
   messages, and apply flow control (ACK-based) so a firehose pauses the producer
   instead of flooding the renderer. See `pty.rs` (`Coalescer`, `Flow`) and
   `TerminalView.tsx`.

4. **Heavy Tauri commands MUST be `#[tauri::command(async)]`.** A plain
   `#[tauri::command]` runs on the **main thread** — any fs read, parse, encode,
   or other non-trivial work there beach-balls the UI (this bit us: `open_doc`
   tokenized 57k lines on the main thread → 1–2 s freeze). Any command that reads
   files, encodes, parses, or otherwise does real work must be `(async)` (or
   genuinely async). Lightweight commands (a map lookup, a counter decrement like
   `pty_ack`) may stay sync for lowest latency. A long-running job that runs on
   its own `std::thread` (the PTY pump) is also fine — the gotcha is *only*
   synchronous work inside the command body.

## Guards in CI

These are cheap regression nets, not a substitute for the rules above:

- `src-tauri/src/perf_guard.rs` — asserts the known-heavy commands keep `(async)`
  and that PTY output stays batched over a Channel (no `pty-output` per-read
  emit). Fails the Rust test suite if either regresses.
- `src-tauri/src/pty.rs` tests — `Coalescer` batching + `Flow` flow-control
  invariants.
- `src/lib/virtual.test.ts` — viewer windowing (only visible lines materialized).

Run the full set before merging anything that touches a viewer, a stream, or a
Tauri command:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
npx vitest run
npx tsc --noEmit
npm run build
```

## When you must add something heavy

- Highlighting / tokenizing / parsing large text → Rust, paged, mtime-cached
  (`highlight.rs` is the template).
- A new long-running process or job that streams progress → a per-task
  `Channel` with backpressure; render throttled/virtualized summaries, never
  per-item heavy work on the UI thread.
- Reading or encoding a file in a command → mark it `#[tauri::command(async)]`.

If a change genuinely needs to break a rule, say so explicitly in review and
explain why the content is bounded — silence reads as "this is safe" when it may
not be.
