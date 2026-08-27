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

5. **The number of *visible* terminals is a budget dimension.** The tile grid
   puts up to fourteen live xterms on screen at once, all sharing the one main
   thread — a variable the user controls directly. Each stream is individually
   batched and ACK-backpressured (rule 3), so overload degrades per-stream (a
   busy terminal falls behind) rather than freezing the app, but anything that
   scales *per visible terminal* must be batched or bounded: the cwd poll is
   one `pty_cwds` subprocess per tick for the whole fleet (never one `lsof`
   per pane), and WebGL renderers are visibility-scoped and capped at
   `MAX_WEBGL` (surplus tiles keep xterm's DOM renderer) so WebKit's
   process-wide context cap can never silently evict the oldest terminal's
   context. At fourteen tiles that ceiling binds for the first time — it used
   to sit above the tile cap and never fire — so the fallback path is now a
   routine one rather than a backstop.

## Guards in CI

These are cheap regression nets, not a substitute for the rules above:

- `src-tauri/src/perf_guard.rs` — asserts the known-heavy commands keep `(async)`
  and that PTY output stays batched over a Channel (no `pty-output` per-read
  emit). Fails the Rust test suite if either regresses.
- `src-tauri/src/pty.rs` tests — `Coalescer` batching + `Flow` flow-control
  invariants.
- `src/lib/virtual.test.ts` — viewer windowing (only visible lines materialized).
- `src-tauri/src/codehealth.rs` — `probe_command_hygiene` reports **every** sync
  `#[tauri::command]` whose body reads a file, parses JSON, encodes base64, or
  shells out. It is a digest signal, not a test, so it never fails a build: the
  Shipwright surfaces it and you decide. When you act on one, add it to
  `perf_guard.rs` — a rule the suite enforces beats a rule an agent re-reports
  every run, which is the whole argument this doc is built on.
- `src-tauri/tests/size_guard.rs` — pins the `[profile.release]` size levers and
  the rlib-only lib in the manifest text (tests build in debug, so only a
  source invariant can catch a profile revert).
- `src/lib/sizeGuard.test.ts` — asserts mermaid/docx stay dynamic-only imports
  and `PlanEditor` stays lazy, catching main-chunk regressions at PR time.
- `scripts/check-size.mjs` — measures built artifacts against
  `scripts/size-budget.json` (warn locally, `--strict` in CI).

> **The guard test is the deliverable.** Two whole-app freezes became four
> written rules became five source-text tests, and that is the only friction fix
> in this repo that *compounds*: a refactor fixes today's instance, a guard stops
> every future one, and a guard is far cheaper to review than a diff. The
> Shipwright's SKILL tells it to prefer exactly this shape over a refactor.

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

## Size budget

The shipped artifact is part of the product. Redline counter-positions against
server-stack collaboration apps as **local-first and light**: one small binary,
no backend stack, instant boot. That claim needs the same discipline as the
main-thread rules above — measured baselines, hard ceilings, and guards that
catch the *cause* of a regression at PR time.

**Budgets:** `scripts/size-budget.json`, checked by `scripts/check-size.mjs`
(warn-only locally, `--strict` in CI). Ratchet budgets **down** as levers land;
every **increase** must be a deliberate, reviewed diff of the JSON — never
silent drift.

**Where the guards run** (`.github/workflows/`): `ci.yml` gates every PR and
main push — the full cargo suite on macos-14 (the `size_guard.rs` source
invariants run there), tsc + vite build + vitest on ubuntu (ditto
`sizeGuard.test.ts`), and `cargo deny check licenses` against
`src-tauri/deny.toml`. `size.yml` checks the byte budgets on main pushes +
nightly + manual dispatch — deliberately NOT on PRs, because the honest
artifact is the real release binary (a 15–25 min build); it mirrors
`scripts/redline.sh`'s sequence exactly (joint `tauri build`, then the lean
`-p redline-mcp` relink) and runs `check-size.mjs --strict`, uploading the
output as a `size-report` artifact. `release.yml` builds per-arch DMGs on
`v*` tags (dry-runnable via workflow_dispatch; ad-hoc signed until the
Developer ID secrets land).

### Baseline (measured 2026-08-06)

| Artifact | Size | Notes |
|---|---|---|
| `target/release/redline` (arm64) | 30,038,704 B | pre-profile build (Jul 3): unstripped (64,629 symbols), no LTO, 16 codegen units |
| …of which `__text` | 14.88 MB | tauri/wry/axum/serde monomorphization |
| …of which `__const` | 4.66 MB | syntect + two-face grammar dumps |
| …of which unwind tables | ~2.8 MB | `__eh_frame` + `__gcc_except_tab` (kept: see below) |
| main chunk `dist/assets/index-*.js` | 3,056,164 B | Tiptap+PromptDrafter and xterm still static |
| `dist/` total | 8.6 MB | embedded into the binary by Tauri |
| `dist-viewer/` total | 4.2 MB | re-bundled its own mermaid/cytoscape/katex (~2.27 MB duplicated) |

### After the B1d frontend diet (measured 2026-08-06, same day)

| Artifact | Size | What moved |
|---|---|---|
| boot-path JS (entry + preloaded shared chunk) | 1,101,717 B | **−64%**: PromptDrafter/VoicePanel/ShareSnapshotDialog lazy, xterm behind a load-once loader, `highlight.js` → `lib/common` (−1.2 MB of grammars), App's one `docModel` need split into pure `sectionMaps` (freed the Tiptap/prosemirror/yjs chain) |
| `dist/` total | 7,708,940 B | now **includes** the viewer (second Rollup entry, shares every chunk) |
| `dist-viewer/` | retired | folded into the main build; the daemon serves `viewer/index.html` + `/assets/*` from the embedded app assets, legacy standalone bundle still served if present |

The budget metric changed with the fold: `bootJsBytes` is the entry chunk
**plus** every chunk `dist/index.html` modulepreloads (the entry's transitive
static closure — shared-with-the-viewer modules live in a preloaded chunk, so
the entry file alone would under-count). `ANALYZE=1 npm run build` writes a
`dist/stats.html` treemap for attribution.

**`manualChunks` is deliberately absent** (tried and reverted here): pinning
vendor groups makes rollup co-locate shared dependencies into the pinned
chunks — measured: react fragments landed in an editor pin, lodash-es and
dompurify in a mermaid pin — which the entry then statically imports. The
`bootJsBytes` sum plus the `sizeGuard.test.ts` source invariants (lazy
surfaces stay lazy, xterm only via its loader, no `highlight.js` barrel) are
the re-merge guards instead.

### Levers

| Lever | Status | Expected |
|---|---|---|
| `[profile.release]`: `strip="symbols"`, `lto="thin"`, `codegen-units=1` | **landed** (pinned by `size_guard.rs`) | measured 2026-08-06 (first post-profile release build, B1d dist embedded): 30.04 MB → **25.66 MB**; ceiling ratcheted 33 → 28 MB |
| lib `crate-type = ["rlib"]` only | **landed** | build time + target/ footprint, not shipped size |
| `panic = "abort"` | **rejected permanently** | would save ~2 MB but breaks `catch_unwind` panic containment (and the extension host's crash isolation is built on it) |
| `opt-level = "s"` | pending, gated | adopt only if first-open highlight of a large TSX stays in budget (syntect throughput is a product invariant); fallback: per-package `opt-level = 3` pins for syntect/onig |
| `redline-mcp` workspace split (own crate, own `reqwest(blocking)`) | **landed** (pinned by `size_guard.rs::mcp_proxy_stays_split_and_lean`; ceiling in `size-budget.json`) | measured: the mcp binary ~28 MB → **1.50 MB** (release, own feature set: no TLS/charset/proxy-detection); app drops the `blocking` feature |
| grammar-dump trim (curated syntect set built in `build.rs`) | pending, optional | −1.5 to −3 MB `__const` |
| lazy `PromptDrafter` / `VoicePanel` / `ShareSnapshotDialog` / xterm loader / hljs `lib/common` | **landed** (pinned by `sizeGuard.test.ts`) | measured: boot-path JS 3.06 MB → **1.10 MB** (`manualChunks` tried and rejected — co-location, see above) |
| viewer as second Rollup entry (dedupe mermaid/katex) | **landed** | measured: `dist-viewer/` (4.2 MB resource) retired; `dist/` total 8.6 → 7.71 MB **including** the viewer |
| `wasmi` extension host (B3) | **landed** — a deliberate spend, not a lever | the one budgeted size **increase**: the in-process WASM host (interpreter, no JIT — wasmtime's +8–12 MB was rejected for exactly this row). Measured 2026-08-06: binary **25.49 MB** with the full host + ABI crate linked in — the interpreter's cost disappeared into thin-LTO variance against the 25.66 MB pre-B3 build. Ceiling unchanged at 28 MB (91.0% used). |

Post-profile release build measured 2026-08-06 (all four rows ~91% of their
ratcheted ceilings): binary 25.66 MB, mcp proxy 1.50 MB, boot-path JS
1.11 MB, dist 7.72 MB. The ad-hoc-signed aarch64 DMG from the same build is
12.8 MB and passes `hdiutil verify` + mount + detach — the exact assertions
`release.yml` makes in CI. Re-measured after the B3 wasmi host landed:
binary 25.49 MB, boot-path JS 1.13 MB (Extensions panel), mcp 1.50 MB,
dist 7.74 MB — all green, ceilings untouched.
