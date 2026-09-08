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

   > **The token meter's compliance with this rule.** `{surface}-meter`
   > (`meter.rs` / `turn::MeterPacer`) is an `app.emit` and not a `Channel`,
   > which is only allowed because it is not high-frequency: it is coalesced to
   > at most one event per **250 ms**, plus an immediate one on a *discrete*
   > change (first model observation, a new tool call, a rate-limit onset, the
   > terminal) — never per text delta. The meter deliberately does NOT ride the
   > delta path, which does fire per token. Its payload is a bounded snapshot
   > (a fixed set of counters plus one ≤160-char activity label), and the
   > backend ring is capped at 200 entries, so nothing here is unbounded
   > either. If the meter ever needs per-token resolution, it must move to a
   > `Channel` first.

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

## Boot budget

The size budget above governs how much code ships. This one governs **how long
the user waits before they can act.** They are different questions: a boot can
be small and still slow, because the cost that matters is the *serial* work
between process start and the first surface a keystroke reaches.

> **Governing rule:** the first actionable frame waits only on the database,
> the session store, and the daemon bind. Integration discovery, repair,
> backups, syntax-set construction, terminal startup, and feature-only
> JavaScript happen **after** that frame, never in front of it.

### Milestones

One vocabulary, two halves. Names are constants on both sides so a rename is a
compile/type error rather than a silently-orphaned measurement.

**Native** — `src-tauri/src/boot_trace.rs`. The clock starts at the top of
`run()`; the post-boot coordinator emits one structured `tracing` record per
launch (`boot milestone` lines plus a `boot trace` summary). Local console
only: nothing is persisted, nothing leaves the machine, and milestone names are
`&'static str`, so no path or plan title can be smuggled into a field.

| Milestone | Recorded when |
|---|---|
| `process_start` | `run()` entered — the zero point |
| `setup_enter` | Tauri's `setup` closure entered |
| `db_migrate` | schema migration finished inside the open |
| `db_open` | `Database::open` returned |
| `store_hydrate` | `SessionStore::new` returned |
| `daemon_start` | the axum server task was spawned |
| `daemon_bind` | `127.0.0.1:7676` bound (or the bind failed) |
| `highlighter_init` | the shared `SyntaxSet` finished building |
| `extension_scan` | manifests scanned, wasm host started |
| `hook_maintenance` | hook + skill maintenance finished |
| `setup_done` | the `setup` closure returned |
| `window_reveal` | the frontend called `show_main_window` |
| `post_boot_done` | the post-reveal coordinator finished |

**Frontend** — `src/lib/bootMarks.ts`, thin wrappers over `performance.mark` /
`performance.measure`. Every mark after the origin also emits a measure *from*
the origin, so the devtools timeline reads as durations rather than instants.

| Mark | Recorded when |
|---|---|
| `rl:entry` | the entry module started evaluating — the zero point |
| `rl:first-commit` | React's first commit landed (layout effect) |
| `rl:core-bootstrap` | the core bootstrap IPC resolved |
| `rl:reveal-call` / `rl:reveal-done` | `show_main_window` invoked / resolved |
| `rl:actionable` | the first surface the user can act on is rendered |
| `rl:session-ready` | a held plan session finished loading |
| `rl:integration-ready` | post-reveal integration health resolved |
| `rl:terminal-ready` | the dock is mounted with a live PTY |
| `rl:boot-settled` | the decorative doors-open run finished |

### Measuring

Native, from a dev run:

```bash
RUST_LOG=info npm run tauri dev 2>&1 | grep -E "boot milestone|boot trace"
```

Frontend, from the WebView console once the shell is up:

```js
copy(await import("/src/lib/bootMarks.ts").then((m) => m.bootTimeline()))
```

Both read the same launch, so a milestone that moved on one side and not the
other is the interesting case — that is usually work that changed threads
rather than work that went away.

### Scenarios

A boot number without its scenario is not a measurement. Capture warm and cold
samples for each:

1. returning launch, no held session (the common case);
2. launch with a held plan session;
3. a large historical database;
4. first run / missing integrations;
5. Codex selected and unavailable;
6. extensions enabled.

### Measured — the boot program (2026-09-02)

Baseline is the tree immediately before the work; every number is the same
machine, same build command.

| Lever | Before | After | Note |
|---|---|---|---|
| Boot-path JS | 1,047,586 B | **550,553 B** | −47.4%; ceiling ratcheted 1,052,000 → 660,000 (16.6% headroom) |
| Fixed interaction floor | ~750 ms | **none** | the front door no longer gates on `bootSettled`; the decorative run is 300 ms |
| Schema SQL per launch | ~60 `CREATE TABLE` + ~50 `CREATE INDEX` + 68 failing `ALTER TABLE`, **every launch** | **one `PRAGMA user_version` read** | `db.rs` versioned runner; pinned by `a_current_database_runs_no_migration_sql` |
| Section parses at startup | one per revision of **every** session ever reviewed | **zero** | pinned by `hydrating_and_listing_sessions_parses_nothing` |
| `VACUUM INTO` in `setup` | synchronous, before the window | **after the reveal** | `postboot.rs`; the 6h + quit snapshots are unchanged and now serialized |
| `SyntaxSet` construction | synchronous in `setup` | **lazy `OnceLock`** | built by the post-boot warmup, or by the first file open — the same instance |
| `codex --help` per boot | up to 2 (hook status + preflight, uncached) | **≤ 1, cached by binary identity** | `binprobe.rs`; the login-shell resolver is cached too |
| Boot IPC round trips | 8 (incl. 4 subprocess-backed probes) | **1** (`bootstrap_state`, no child processes) | integration health follows the reveal |
| Terminal dock | mounted with the shell (xterm + PTY + cwd poll) | **after the first actionable frame** | launch intent queues on `ensureTerminalReady` |

What did **not** move, deliberately: run-watcher rehydration and extension-host
startup stay in `setup`. The plan gates deferring them on measurement showing
they are material, and extension access must remain fail-closed until token
registration completes — moving it behind the reveal would open a window in
which an extension could reach the daemon unregistered. The second,
measurement-gated step on session hydration (keeping only summaries in memory
and fetching bodies on demand) is likewise not taken: row hydration no longer
parses anything, so the remaining cost is a `SELECT`, and the plan says to
measure before spending that complexity.

### Relative goals

Absolute ceilings get ratcheted from the measured baseline, exactly like the
size budget. These hold regardless of the machine:

- **No fixed interaction floor.** The decorative boot animation must not gate
  actionability — `src/lib/boot.test.ts` pins this at source level.
- Warm start-to-actionable median **at least 30% better** than the baseline,
  with no p95 regression.
- **Zero** historical section parses before a session is opened.
- At least **15% headroom** under the static boot-JS budget.

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
`scripts/redline.sh`'s sequence exactly (the joint `tauri build`; the lean
`-p redline-mcp` relink that used to follow retired 2026-09-07 with the
proxy) and runs `check-size.mjs --strict`, uploading the output as a
`size-report` artifact. `release.yml` builds per-arch DMGs on
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
`build-analysis/stats.html` treemap for attribution — outside `dist/`, because
everything under `dist` is embedded into the binary and counted by
`distTotalBytes`, so the treemap used to inflate the number it exists to
explain (and shipped to users on any build that ran with `ANALYZE` set).

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
| `redline-mcp` workspace split (own crate, own `reqwest(blocking)`) | **retired 2026-09-07** — the daemon mounts `/mcp` from `polis-mcp` (Polis E1: streamable HTTP over the same `MemoryApi`), so no proxy binary ships and `mcpBinBytes` left `size-budget.json`; `size_guard.rs::mcp_proxy_stays_split_and_lean` now pins the two things that outlived it: the app's reqwest never regains `blocking`, and `/mcp` is served by `polis_mcp` | historical: the proxy measured ~28 MB → 1.50 MB on its own graph; the `blocking` drop stays in the app |
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

Re-measured 2026-09-07 (docs/polis-extraction.md, A7): main @ ba3b8cf
**30.54 MB** locally and 30.39 MB on CI's `size.yml` — over the 28 MB
ceiling before the Polis extraction began; the extraction branch adds
~0.54 MB (A1–A6) plus 16 KB for the git dependency.

**Ceiling raised 2026-09-08: 28 → 36 MB**, a deliberate, reviewed increase
(`scripts/size-budget.json` carries the reasons). Measured along the Polis
program: 31.10 MB after the extraction, 33.82 MB when the daemon began
serving MCP in-process (rmcp + its schema generator; the separate 1.5 MB
proxy binary retired), 34.05 MB with the run journal and undo, 34.39 MB
with the identity crates — plus main's own 2.5 MB overage that predates
all of it. The old ceiling had been failing the nightly job since at least
2026-09-04, which made it no guard at all; the new one is the measurement
plus ~4.5 %, so the next unexplained megabyte fails again. Levers for a
size session: MCP mounted only when enabled or without schema generation
(~2.7 MB), the duplicate sha2 line, an audit of main's pre-program growth.

## Memory latency budget

The memory system (Polis Memory, linked from
https://github.com/sersiousSenpai/polis-memory since docs/polis-extraction.md
A7) carries its own latency budget, stated in the plan's §6.1 and kept in the
new repo's `docs/bench.md` beside the measured baseline. The same table lives
here so a Redline change that lands on a memory path (a surface calling the
answer pack on every keystroke, a route added in front of it) is measured
against the same numbers. Instruments: `tracing::info_span!` with `ms` on
every retrieval arm and route, a per-op latency ring exposed on
`GET /v1/context/stats` (`latency: [{op, n, p50Ms, p95Ms, maxMs}]`), criterion
benches over a seeded synthetic corpus, and a real-DB instrument
(`POLIS_REAL_DB=<copy>`) that prints p50/p95 per op.

| Operation | Corpus | p50 | p95 |
|---|---|---|---|
| ingest | any | < 5 ms | < 20 ms |
| answer pack warm / cold | 10k prompts | < 50 / < 300 ms | < 200 / < 800 ms |
| semantic search alone | 100k chunks | < 60 ms | < 120 ms |
| grep (trigram) | 10k | < 30 ms | < 100 ms |
| MCP `memory_context` round-trip | 10k | < 100 ms | < 300 ms |
| canary set (200 packs) | real DB | < 3 s | < 8 s |
| organize per item / per run | any | < 3 s / p50 < 20 s | p90 < 60 s |
| embed one chunk (model2vec) | — | < 1 ms | — |

A Redline path that calls into the memory (the sidecar's class-router reads,
Memory Ask, the Companion's consults) inherits these rows; anything new that
sits in front of them is budgeted as its own row here, with a measurement.
