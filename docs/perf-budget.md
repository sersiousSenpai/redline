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

   > **The streamed replies' compliance with this rule.** A chat reply's
   > `{surface}-delta` events (fork, companion, browse — Claude and Codex —
   > mission, memchat, draft-chat, voice, plus `run-delta` and the AI review's
   > `review-ai-log`) are an `app.emit` and not a `Channel`. That is allowed
   > only because they are no longer per token: `turn::DeltaPacer` coalesces
   > each turn's deltas to at most one event per **33 ms** (two frames). The
   > first token leaves at once, so time to first token is unchanged; what a
   > window holds leaves as one chunk that is the deltas' exact concatenation.
   > Held text never waits on the next line — `turn::next_line` (or a
   > `due()` arm in a reader that already selects) flushes it at its deadline
   > — and every reader flushes before any other event of the turn (done,
   > error, cancelled, a status line, a steer that splits the reply) and when
   > its stream ends, so a final reply is never short. The chunk is what gets
   > `turn::push_delta`'d, so `seq` counts chunks and the frontend's seq guard
   > is unchanged. One subscriber per stream is still the Channel's argument:
   > every mounted listener wakes for every chunk, which is bounded at ~30 a
   > second per streaming turn. `perf_guard.rs` pins the pacing. On the
   > frontend, `useAgentTurn` folds the chunks that land within one animation
   > frame into one render (a terminal event renders at once, with the full
   > text), and `StreamingBubble` re-parses only the reply's open last block:
   > the closed blocks go through a memoized `MarkdownView` that parses again
   > only when another block closes (`src/lib/streamSplit.ts`), at a boundary
   > markdown-it's own block parser confirms. A frame costs one block, not the
   > whole reply.
   >
   > **The token meter's compliance with this rule.** `{surface}-meter`
   > (`meter.rs` / `turn::MeterPacer`) is an `app.emit` and not a `Channel`,
   > which is only allowed because it is not high-frequency: it is coalesced to
   > at most one event per **250 ms**, plus an immediate one on a *discrete*
   > change (first model observation, a new tool call, a rate-limit onset, the
   > terminal) — never per text delta. The meter deliberately does NOT ride the
   > delta path, which has its own pacer, and it is a snapshot with its own
   > `rev` guard, so it never has to be ordered against the text. Its payload
   > is a bounded snapshot (a fixed set of counters plus one ≤160-char activity
   > label), and the backend ring is capped at 200 entries, so nothing here is
   > unbounded either. If the meter ever needs per-token resolution, it must
   > move to a `Channel` first.

4. **Heavy Tauri commands MUST be `#[tauri::command(async)]`.** A plain
   `#[tauri::command]` runs on the **main thread** — any fs read, parse, encode,
   or other non-trivial work there beach-balls the UI (this bit us: `open_doc`
   tokenized 57k lines on the main thread → 1–2 s freeze). Any command that reads
   files, encodes, parses, or otherwise does real work must be `(async)` (or
   genuinely async). Lightweight commands (a map lookup, a counter decrement like
   `pty_ack`) may stay sync for lowest latency. A long-running job that runs on
   its own `std::thread` (the PTY pump) is also fine — the gotcha is *only*
   synchronous work inside the command body.

   For a command with a sync body, the cheaper way off the main thread is its
   name in `OFF_MAIN_COMMANDS` (lib.rs): the invoke handler hands the whole
   call to the blocking pool, through one shared closure. `(async)` builds a
   tokio task for each command's own future type, about **11 KB of release
   binary per command** (measured 2026-10-09: 29 commands cost 331,248 B), and
   the binary has no room for that. Either way, two calls can finish out of
   order. A command whose calls must keep theirs goes in `IN_ORDER_COMMANDS`
   instead: each call takes a ticket as it arrives and runs on the pool when
   its turn comes, one at a time (`save_workspace`: every gesture saves
   without waiting for the last, and the file is what the next launch loads). `watch_dir`/`unwatch_dir` stay
   sync to keep their order with each other, and hand their slow part to a
   thread of their own.

   SQLite is heavy whatever the query's size. Every write waits on the one
   writer connection (`Database::lock_conn`), which a backup, the canary or an
   embedding tick can hold for seconds. A read goes through
   `Database::read_conn`, one of a few read-only WAL connections that never
   wait for the writer and always see every write that has returned; the
   writer is for writes. State that is edited in memory and then persisted
   releases its own lock before the write, so a poll reading it never waits on
   SQLite either (`SessionStore::lock_to_write`).

5. **The number of *visible* terminals is a budget dimension.** The tile grid
   puts up to fourteen live xterms on screen at once, all sharing the one main
   thread — a variable the user controls directly. Each stream is individually
   batched and ACK-backpressured (rule 3), so overload degrades per-stream (a
   busy terminal falls behind) rather than freezing the app, but anything that
   scales *per visible terminal* must be batched or bounded: the cwd poll is
   one `pty_cwds` subprocess per tick for the whole fleet (never one `lsof`
   per pane), `pty_procs` (each terminal's foreground program and listening
   ports, for the wall's state badges) is one `ps` and one `lsof` per call
   whatever the terminal count, and WebGL renderers are visibility-scoped
   and capped at `MAX_WEBGL` (surplus tiles keep xterm's DOM renderer) so WebKit's
   process-wide context cap can never silently evict the oldest terminal's
   context. At fourteen tiles that ceiling binds for the first time — it used
   to sit above the tile cap and never fire — so the fallback path is now a
   routine one rather than a backstop.

6. **Paint is a budget too.** No `infinite` animation, and no animation longer
   than 300 ms, may animate anything but `transform` or `opacity` (or the
   individual `translate` / `rotate` / `scale` properties). Those are the only
   properties WebKit's compositor moves without repainting. Everything else —
   `background-position`, `box-shadow`, `background`, a registered custom
   property driving a gradient, even `visibility` — repaints its layer every
   frame in the GPU process, and every keystroke's layer commit queues behind
   that backlog. `filter` is not on the list: WebKit composites some filters
   and repaints others, so it is never a safe default. Large surfaces (body,
   plates, pane backgrounds) stay static. To make something drift, pulse,
   sweep or glow, paint it once on a pseudo-element and move that: a crossfade
   between two static layers (the Aurora edge light), a scaled halo (the live
   dot), a translated window (the working shimmer). The rule covers every way
   an animation starts: a stylesheet, an inline style, `el.animate(…)`, and a
   package's own CSS that a prop switches on — React Flow's `animated` edge
   marches its dash forever, so the Runs canvas tints a live edge instead.

   > **What it cost before it was a rule (2026-10-09).** The default Aurora
   > theme animated `background-position` on a 280%-size gradient behind a
   > mask, forever, on all four plates. With the app idle, the
   > `com.apple.WebKit.GPU` process sat at 102% CPU, one
   > `RemoteRenderingBackend` thread spent ~83% of its samples in
   > `WebCore::Gradient::paint`, and the renderer's
   > `RemoteLayerTreeDrawingArea.CommitQueue` spent 88% of its samples waiting
   > in `flushAndCollectHandles` — so typing, dragging and every other input
   > felt late. The ring it drew sat on the plates' 1px border, which their own
   > `overflow: hidden` clips: all that paint bought a few antialiased pixels
   > at the corners. `scripts/perf-idle.sh` ("Responsiveness" below) is that
   > diagnosis as a recipe.

7. **Memory is bounded.** Anything the renderer keeps longer than one
   interaction has a stated cap, written beside it with the reason it is safe:
   a module-level cache, state a long-lived surface appends to, anything keyed
   by an id that keeps coming (a directory, a tab, a plan version, a room).
   Caches drop their oldest entries. A chat's history re-fetches older pages
   from SQLite where the surface pages, and otherwise holds a hard cap of its
   newest rows. What a surface creates, its unmount releases: listeners, timers,
   xterms, providers, and whatever a library leaves running on their behalf
   (y-webrtc's awareness interval outlives `provider.destroy()`). A leak never
   shows in a test or a morning's use. It shows as a renderer that is 4 GB
   after two days, with every GC pause and swap-in landing behind a keystroke.

   | Kept in the renderer | Where | Cap |
   |---|---|---|
   | A mounted chat's settled rows | `THREAD_KEEP`, `lib/agentTurn` (and `TRANSCRIPT_KEEP`, `VoicePanel`) | newest 1,000; activity ring 40 |
   | A hidden terminal's unparsed output | `MAX_HIDDEN_BUFFER_BYTES`, `TerminalView` | 2 MB per terminal; scrollback 5,000 lines; xterm disposed on unmount, WebGL only while visible |
   | Repo logos by directory | `MAX_REPO_DIRS`, `useRepoIcons` | 256 directories, never a shown one; one copy per repo |
   | Rasterized repo marks | `MAX_MARKS`, `lib/repoMarkImage` | 128 |
   | Browser tab pictures | `shotsForOpenTabs`, `BrowserPane` | one per open tab |
   | Plan text for the Front Door's ranking | `PLAN_CACHE_MAX`, `lib/doorRecents` | 32 plans, one version each |
   | Memory shots | `LRU_MAX`, `useShotCache` | 60 |
   | Commit details | `HistoryView` | 64 per view |
   | AI review log, orchestration tail | `LOG_CAP`, `TAIL_CHAR_BUDGET` | 60,000 characters each |
   | Perf probe samples | `RETAIN_MS`, `lib/perfProbe` | two minutes, in fixed rings |
   | A live room's Y.Doc | `collab/provider` `destroy` | released with the room: nothing left that reaches it |
   | Mermaid's measuring nodes | `MermaidView` | none left in `<body>` |
   | Drafts flushed this run | `drafterSessionCache`, `App` | one document per draft; not evicted, because it keeps a remount ahead of a database still retrying its write |
   | Per-id bookkeeping | terminal titles, cwds and handoff seams, closed-tab ids, workspace revisions, `autoDiscussed` | a few bytes per id seen this run (plus an 8 KB output tail per terminal a handoff watched) |

   > **What it cost before it was a rule (2026-10-09).** The renderer had a
   > 4.0 GB footprint after two days: 3.2 GB of dirty WebKit Malloc, 2.3 GB
   > swapped. Its 546 "WebAssembly memory" regions were a red herring:
   > `footprint` gives that name to JavaScriptCore's own VM tag, and an empty
   > `jsc` shows the same 546. What grew was the plain heap: a browser tab's
   > picture kept after the tab closed, a repo's logo copied once per directory
   > a terminal visited, every left collab room's whole Y.Doc, a node in
   > `<body>` per broken diagram, every version of every plan the Front Door
   > ranked. `docs/renderer-memory-2026-10-09.md` has the investigation and
   > before/after numbers from `scripts/memory-soak.mjs`.

## Guards in CI

These are cheap regression nets, not a substitute for the rules above:

- `src-tauri/src/perf_guard.rs` — asserts the known-heavy commands keep `(async)`
  or their place in `OFF_MAIN_COMMANDS` or `IN_ORDER_COMMANDS` (and that every
  name there is registered, and `save_workspace` keeps its order),
  that PTY output stays batched over a Channel (no `pty-output` per-read
  emit), that every streamed reply's delta arm feeds a `DeltaPacer` and its
  reader flushes it, that run events carry a run id and revision rather than
  the graph, and that the renderer footprint is watched and served (rule 7).
  Fails the Rust test suite if any of them regresses.
- `src-tauri/src/turn.rs` tests — `DeltaPacer` coalescing (the leading token,
  the window, whole and ordered chunks, a gapless `seq`) and its flushes:
  before done, before error, on an abrupt end, and when the stream goes quiet.
- `src-tauri/src/pty.rs` tests — `Coalescer` batching + `Flow` flow-control
  invariants.
- `src/lib/virtual.test.ts` — viewer windowing (only visible lines materialized).
- `src/components/StreamingBubble.test.tsx` — streams real-shaped replies
  (fences, lists, tables, headings, quotes, mermaid) a few characters at a
  time and holds the split render to one full render at every step (including
  where the line scan misreads a block), and pins that the closed blocks'
  `MarkdownView` re-renders only when a block closes.
- `src/lib/paintGuard.test.ts` — rule 6. Resolves every `animation` in
  `src/**/*.css`, every inline `animation:` in a component and every
  `el.animate(…)` call to the properties it animates, and fails when an
  infinite or >300 ms animation touches anything but `transform` /
  `opacity`. Its `ALLOWLIST` admits finite one-shots only (a focus flash, a
  tile hail, the snap-back ring, the spring swap's corners), each with a
  written reason and a duration ceiling; an infinite paint animation cannot
  be allowlisted. The package stylesheets src imports are scanned too: each
  endless paint animation in one is listed in `PACKAGE_SWITCHES` with the
  switch that starts it, which nothing using the package may set.
- Rule 7 — each cap is tested beside its cache (`useRepoIcons`, `doorRecents`,
  `agentTurn`, `BrowserPane`'s `shotsForOpenTabs`), and the two releases a
  library made easy to miss have their own: `src/collab/provider.test.ts`
  (leaving a room closes the relay socket and stops every timer) and
  `src/editor/extensions/MermaidView.test.tsx` (a broken diagram leaves
  nothing in `<body>`). `renderer_memory.rs` tests the footprint read and the
  once-per-crossing warning, and `perf_guard.rs` pins that the watch starts and
  `/v1/perf` serves it. `scripts/memory-soak.mjs` is the manual counterpart (it
  needs Chrome): run it before merging anything that keeps state across mounts.
- `src-tauri/src/codehealth.rs` — `probe_command_hygiene` reports **every** sync
  `#[tauri::command]` whose body reads a file, parses JSON, encodes base64,
  shells out, or reaches SQLite (`.database()`, a store's `db` handle, called
  or lent to a helper, `lock_conn`, `read_conn`), unless `OFF_MAIN_COMMANDS` or
  `IN_ORDER_COMMANDS` runs it off the main thread anyway. It is a digest
  signal, not a test, so it never fails a build: the Shipwright surfaces it
  and you decide. When you act on one, add it to
  `perf_guard.rs` — a rule the suite enforces beats a rule an agent re-reports
  every run, which is the whole argument this doc is built on.
- `src-tauri/tests/size_guard.rs` — pins the `[profile.release]` size levers,
  the rlib-only lib and the dev profile's `split-debuginfo = "off"` (the
  `target/` leak, CONTRIBUTING.md) in the manifest text (tests build in debug,
  so only a source invariant can catch a profile revert).
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
- Reading or encoding a file in a command → add it to `OFF_MAIN_COMMANDS`
  (or mark it `#[tauri::command(async)]` when the body is itself async).

If a change genuinely needs to break a rule, say so explicitly in review and
explain why the content is bounded — silence reads as "this is safe" when it may
not be.

## Responsiveness

The rules above keep the main thread free; this section measures whether it
is. The bar is the one set by the editors people compare Redline to:

| Goal | Target |
|---|---|
| Input latency (INP), p95 | under 50 ms |
| Frame gaps while you interact | none longer than one refresh interval |
| WebKit GPU process at idle | near 0% CPU (under 5%) |
| Renderer memory | flat over days of uptime |

### Instruments

**The probe** — `src/lib/perfProbe.ts`. Rolling over the last two minutes:

- `input` — per interaction (a keystroke, a click, the down and up of a
  drag), its slowest event's time from input to the next paint, from the
  Event Timing API, split into `keyboard` and `pointer`. The engine reports
  only events of 16 ms or more and rounds to 8 ms, so the probe also counts
  every keydown and pointerdown and files the unreported ones at the 16 ms
  floor: **a value of 16 means "at most 16"** (`floorMs`). Without Event
  Timing it falls back to input-to-next-frame timing and says
  `source: "approximate"`.
- `frames` — gaps between `requestAnimationFrame` callbacks while you
  interact with the visible page: p50/p95/max and a histogram. A keydown,
  pointerdown, drag, wheel or input starts the sampler and it stops itself
  2 s after the last one (`FRAME_TAIL_MS`), so it never keeps an idle app
  drawing. A healthy 60 Hz gap is ~16.7 ms; anything in the 34 ms bucket or
  above is a frame the main thread dropped. Pointer *moves* are not
  interactions to Event Timing, so **pane-drag smoothness is read here**, not
  from `input`.
- `longTasks` / `longAnimationFrames` — where the engine has them. WebKit has
  neither (2026-10), and the snapshot says `null` rather than reporting a
  clean zero; `supported` lists what was live.

It runs by default in a dev build. On a release build it is off until
switched on: **⌘K → "Start the performance probe"** (the choice persists;
"Stop the performance probe" turns it off in either build). At idle it costs
nothing: the frame sampler sleeps until you touch the app, and the Event
Timing and long-task observers are passive, so an idle `sample` can be taken
with it on.

Two ways to read it:

```bash
# Any build, from a terminal — the daemon evaluates window.__rlPerf in the
# main webview. windowMs: 1000–120000 (default 60000).
curl -s 'http://127.0.0.1:7676/v1/perf?windowMs=20000' | jq
```

```js
// A dev build's Web Inspector console.
__rlPerf.snapshot(20000)   // __rlPerf.reset() starts a scenario clean
```

**The renderer's footprint** — `src-tauri/src/renderer_memory.rs`. WebKit has
no `performance.memory`, so Redline reads its renderer from outside: the main
webview's WebContent pid and that process's physical footprint
(`proc_pid_rusage`, the number `footprint` and Activity Monitor show). It rides
on every `/v1/perf` answer as `renderer: {pid, footprintBytes}`, probe on or
off, and on the 502 when the page can't answer. A watch thread re-finds the pid
every minute and logs one warning when the footprint passes 1.5 GB (rule 7):

```bash
curl -s http://127.0.0.1:7676/v1/perf | jq .renderer
```

**The soak** — `node scripts/memory-soak.mjs`. Headless Chrome, real surfaces
behind a synthetic Tauri boundary: opens and closes chats while replies stream,
opens a long thread, joins and leaves collab rooms, walks a terminal through
directories, and reports what each leaves behind after a forced collection
(rule 7; `docs/renderer-memory-2026-10-09.md` has the 2026-10-09 numbers).

**The idle recipe** — `scripts/perf-idle.sh`. With the app open on the
default Aurora theme and hands off the keyboard and pointer (the probe can
stay on):

```bash
scripts/perf-idle.sh             # 3 s; --seconds N, --keep for the raw reports
```

It finds the app's WebKit helpers through LaunchServices ("Redline Graphics
and Media", "Redline Web Content"; the app's own renderer is the oldest — the
others are browser tabs), runs `sample` on the GPU process and the renderer
concurrently, and prints each one's CPU over the window, its physical
footprint, the share of the GPU's rendering threads spent in
`WebCore::Gradient::paint`, the share of the renderer's
`RemoteLayerTreeDrawingArea.CommitQueue` spent waiting in
`flushAndCollectHandles`, and `/v1/perf` if the probe is on. Healthy: GPU
under 5%, `Gradient::paint` ~0%, the commit queue absent or not waiting. The
2026-10-09 storm read 102%, ~83% and 88% (rule 6). `--app Safari` runs the
same recipe against any WebKit app, which is how to check the recipe itself.

### Which build perf is judged on

**The release build — `npm run redline` — is the only build a perf number is
taken from, and the one to use day to day when you are not editing Redline.**
`tauri dev` runs React's development build with StrictMode's double renders
and unbundled modules, plus a debug binary; expect it to be roughly 2–5×
slower than the release app on the same interaction, so a dev-build number
measures the build rather than the app, and a lag felt only there is not yet
a product bug.

The dev profile narrows the backend half of that gap without hiding it:
dependencies build at opt 2, and Redline's own crate at opt 1
(`[profile.dev.package.redline]`), so its serde, database and parsing paths
are no longer unoptimized in dev. That costs edit-loop time — a one-line
body edit rebuilt in ~23 s at opt 1 against ~10 s at opt 0, measured
2026-10-09; the manifest comment carries the numbers. If the loop matters
more on a given day, delete that section locally; it changes nothing the
release build ships.

### Baseline — release build, to be measured

**Not yet measured.** The numbers have to come from the release build with a
person at the keyboard, which the change that added the instruments could not
do. Measure on `npm run redline`, never on `tauri dev` (see "Which build
perf is judged on" above), and fill in the table with the date, the commit
and the app's uptime:

1. Build and install with `npm run redline`, launch it, keep the Aurora
   theme, and quit other heavy apps. Note the uptime — the renderer's memory
   is the one number that depends on it.
2. **Idle.** Hands off for 10 s, then `scripts/perf-idle.sh`. Record GPU CPU
   and both footprints.
3. ⌘K → "Start the performance probe".
4. Each scenario below for 20 s, then **immediately**
   `curl -s 'http://127.0.0.1:7676/v1/perf?windowMs=20000' | jq .snapshot`,
   then 20 s hands off before the next, so no window spans two scenarios:
   - **Front Door typing** — type continuously into the Front Door composer.
   - **Comment typing** — type into a plan comment's reply composer.
   - **Typing during a streaming reply** — send a chat question, then type
     into the composer while the reply streams.
   - **Pane drag** — drag the sidebar divider back and forth.

| Measure | Scenario → field | Goal | Release value |
|---|---|---|---|
| INP p95, Front Door typing | Front Door → `input.keyboard.p95` | < 50 ms | to be measured |
| INP p95, comment typing | Comment → `input.keyboard.p95` | < 50 ms | to be measured |
| INP p95, typing while a reply streams | Streaming → `input.keyboard.p95` | < 50 ms | to be measured |
| Frame gap p95 / max, reply streaming | Streaming → `frames.p95`, `frames.max` | ≤ 17.5 ms p95 | to be measured |
| Frame gap p95 / max, pane drag | Pane drag → `frames.p95`, `frames.max` | ≤ 17.5 ms p95 | to be measured |
| INP p95, pane drag down/up | Pane drag → `input.pointer.p95` | < 50 ms | to be measured |
| GPU process CPU at idle | `perf-idle.sh` | < 5% | to be measured |
| Renderer footprint at 1 h and 8 h of uptime | `/v1/perf` → `renderer.footprintBytes` (or `perf-idle.sh`) | 8 h within 20% of 1 h | to be measured |

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
`size-report` artifact — and it now builds `-p redline-activate` first, because
`tauri build` alone does not produce the activation helper and `--strict`
reports a missing artifact as a failure. `release.yml` builds per-arch DMGs on
`v*` tags (dry-runnable via workflow_dispatch; ad-hoc signed until the
Developer ID secrets land).

### Build Redline (measured 2026-09-16)

Three points, on one machine, same day:

| Tree | Release binary | dist | Boot JS |
|---|---|---|---|
| Clean HEAD `260a90c`, in a worktree | 36,190,704 B | 8,276,563 B | — |
| Working tree immediately before the feature | 37,467,840 B | 8,363,465 B | 589,660 B |
| After the feature | 38,166,656 B | 8,383,222 B | 590,037 B |

The clean-HEAD number is the same one the 2026-09-13 entry records, which is
what makes the middle row trustworthy: the baseline has not moved, so the
pre-feature measurement is comparable and the delta is attributable.

**+698,816 B (+1.865%)** on the binary, for six backend modules
(`runtime_profile`, `confine`, `release_manifest`, `probe`, `activation`,
`self_develop`), the shared activation-protocol crate and a schema step.
`binaryBytes` raised to 38,500,000 — 333,344 B (0.866%) of headroom, in line
with the 0.616% the previous raise left.

**+377 B on the boot path**, for a feature that builds and installs the
application. That is the whole point of the island split: the release panel
rides the already-lazy Runs chunk, and the readiness indicator is its own lazy
island that a machine which never prepares a release never fetches.

The activation helper is deliberately *not* in the binary number. It is a
separate 546,112 B executable with its own `helperBinBytes` ceiling, because
its defining property is that it does not link the application it installs —
and a gate is what keeps that true. A dependency creeping in would show up
there as megabytes rather than as nothing at all.

### Four-plan implementation (measured 2026-09-13)

The [browser layout and menu repair](browser-refresh-repair-2026-09-14.md) records the latest embedded-app measurements with these same ceilings.

These measurements record the initial four-plan completion. The subsequent
[hook-conflict modal repair](hook-conflict-modal-repair-2026-09-13.md) updates
the artifact hash and frontend measurements and passes these same ceilings.

The browser, hook-conflict, away-strip and mission/performance changes were
measured against a clean detached worktree at the same HEAD,
`260a90c44392eac2f5e2f783323506acebf2f8c0`. Both used
`npx tauri build --bundles app`, arm64, rustc 1.95.0, the same installed frontend
dependencies and the existing release profile. The Joey product plan was
excluded. Standalone `cargo build --release` does not embed the frontend and
is not the comparison used here.

| Artifact | Same-HEAD baseline | Final | Delta |
| --- | ---: | ---: | ---: |
| Embedded release executable | 36,190,704 B | 37,467,840 B | +1,277,136 B (+3.529%) |
| Tauri app bundle, before explicit signing | 36,309,359 B | 37,586,495 B | +1,277,136 B |
| Frontend dist | 8,276,563 B | 8,339,191 B | +62,628 B |
| Static boot JavaScript | 577,939 B | 591,051 B | +13,112 B |

The old 36,050,000-byte binary ceiling already failed at the baseline by
140,704 bytes. After an independent agent reread the artifact and reviewed
the checker and budget policy, **binaryBytes increases to 37,700,000**.
The 1,650,000-byte ceiling increase comprises that 140,704-byte pre-existing
breach, the 1,277,136-byte measured feature delta, and 232,160 bytes of
headroom (0.616%). This is the smallest 100 KB-rounded ceiling leaving at
least 0.5% headroom. It is an explicit feature-budget increase, not a claim
that the executable became smaller. Sharing request decoders saved 16,448
bytes in paired shipping builds before the final capture integration;
that intermediate saving is not attribution of the remaining size to any
single feature.

Both frontend ceilings remain unchanged: 660,000 bytes for boot JavaScript
and 8,500,000 bytes for dist. Final headroom is 10.447% and 1.892%,
respectively. The aspirational 15% boot headroom goal remains unmet; it was
already unmet at the baseline (12.433%). The strict checker, panic unwind,
thin LTO, single codegen unit, symbol stripping and dependency configuration
were not weakened.

The final release executable SHA-256 is
`753bfbb7d308ca2fd0e79dd3850307a0f5c4c15a4af79c3a8bec07d395eb6825`;
the baseline hash is
`a048d0b7912ddec3aefc09b753ff4311618fbba9037a98afd84c8da396620617`.
The original-ceiling strict check failed as expected; the same unchanged
checker passes with the reviewed ceiling. Same-HEAD baseline artifacts and
logs are preserved in `/tmp/redline-head-size-1789307892674706000` and final
build/size logs in `/tmp/redline-swarm-final-app-build.log` and
`/tmp/redline-swarm-final-size.log`.

The default local build carried only the linker's executable signature, so
strict bundle-signature verification initially failed. The already-built
app was regenerated with
`APPLE_SIGNING_IDENTITY=- npx tauri bundle --bundles app --ci`, using the
repository's configured entitlements. `codesign --verify --deep --strict`
then passed. That local ad-hoc signed bundle contains 37,607,943 file bytes
and a 37,486,848-byte executable; its signature accounts for the difference
from the size-checker's release executable. This is neither Developer ID
signing nor notarization, and the app was not installed or launched.

See [the implementation report](plan-swarm-implementation-2026-09-13.md)
for verification and the remaining native walkthrough boundary.

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

## Restart budget

The other kind of time the product asks for: [Build Redline](self-develop.md)
prepares a replacement application in the background, and then asks to restart
into it. Four numbers, measured separately because they fail differently:

| Measure | What it is | Where it comes from |
|---|---|---|
| Preparation | Dependencies, checks, build, package, sign, probe | `release-manifest.json` — per-step `durationMs` |
| Saving and draining | Flush, workspace snapshot, database snapshot, staging copy | The activation journal's timestamps, `Staged` → `HandedOff` |
| **Downtime** | Old process exits → new workspace is interactive | The journal's `HandedOff` → the handshake's `Workspace` |
| Recovery | A failed startup → the previous release is running again | `HandshakeFailed` → `RolledBack` |

**Target: under 10 seconds from process exit to an interactive workspace** for
a prepared release with unchanged persistent formats, on the reference Mac.
A target to validate, not a guarantee — and the number the *user* is shown is
not this one. It is the candidate probe's own measured time to interactive plus
a bounded allowance for the exchange and launch, so a slow build says it is
slow instead of promising ten seconds. With nothing measured it says "not
measured yet".

What makes the target reachable is a rule rather than an optimisation: **no
dependency installation, compilation, signing or bulk application copying
happens after the process exits.** The staging copy — the expensive part, tens
of megabytes — is made while Redline is still usable, and what remains after
the exit is one atomic exchange and a launch. Anything that creeps back over
that line will show up here as downtime, not as a slower build.

The quit-time database snapshot is skipped when the restart path has already
taken one; a second `VACUUM INTO` of the same bytes is pure downtime, and
downtime after the user has clicked Restart is the kind that shows.

Preparation concurrency is the other side of it: preparing a release must not
degrade the foreground app. Two concurrent editing agents and one heavyweight
build is the starting point, and the main-thread rules above apply to the
window the whole time a build is running — the build is in another process, and
under an OS sandbox, precisely so that stays true.

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


## Memory Cosmos feature budget — reviewed 2026-09-24

The twelve-plan implementation adds a Three.js renderer as expressly requested
by the Memory Cosmos plan. An independent agent verified the build inventory,
static boot closure and lazy source chain before the budget change.

The available pre-task `dist` artifact measured **8,400,730 B**. The first
integrated production build measured **8,990,298 B**, an increase of 589,568 B.
The lazy Cosmos scene is 563,609 B (95.60% of that aggregate delta); its worker,
Map host and CSS add 14,527 B. Removing just the scene chunk leaves 8,426,689 B,
under the old 8.5 MB ceiling. These are whole-artifact comparisons, not a claim
that the pre-task artifact was rebuilt from an isolated source baseline.

`distTotalBytes` increases from **8,500,000 to 9,150,000 B**, leaving 159,702 B
(1.745%) headroom on the independently reviewed artifact. The strict checker
is unchanged. The boot ceiling stays at 660,000 B; the measured static closure
is 599,267 B and contains neither Three.js nor OrbitControls. The import chain
is App → lazy MemorySurface → lazy MemoryMap → lazy MemoryCosmosScene; a new
source regression guard pins that boundary. The older aspirational 15% boot
headroom target remains unmet, as it already was before this work.

Final source validation, packaged binary measurements and native-probe results
are recorded in [the implementation report](twelve-plan-implementation-2026-09-24.md).
