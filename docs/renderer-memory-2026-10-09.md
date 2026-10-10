# Renderer memory: what grows, and the caps that stop it

Phase 6 of the responsiveness program ("renderer memory stays flat"). The
starting point, measured on the live app on 2026-10-09: Redline's main
WebContent process had a **4.0 GB footprint after two days**, with 3.2 GB of
dirty WebKit Malloc, 2.3 GB swapped, and **546 "WebAssembly memory" regions**.

A Web Inspector heap snapshot of the live app was not possible from this
change (no app launch), so the investigation is static, plus two harnesses: a
`jsc` and `footprint` experiment on what the regions are, and a headless-Chrome
soak of the real surfaces (`scripts/memory-soak.mjs`). The rule that came out of
it is rule 7 in `docs/perf-budget.md`.

## 1. The 546 regions are not WebAssembly

`<mach/vm_statistics.h>` defines `VM_MEMORY_WEBASSEMBLY` as
`VM_MEMORY_JAVASCRIPT_CORE` (tag 63). The two tools name that one tag
differently: `footprint` calls it "WebAssembly Memory", `vmmap` calls it "JS VM
Reservations". Checked by tagging a 64 KB allocation 63 in a small C program and
reading it back with both.

What lives under the tag, measured with `jsc` (JavaScriptCore's own shell,
`/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`)
and `footprint`:

| `jsc` holding | "WebAssembly Memory" | WebKit Malloc | Footprint |
|---|---|---|---|
| nothing | **546 regions**, 32 KB dirty | 2.5 MB | 6 MB |
| 1,000,000 small objects | 546 regions, 32 KB | **300 MB** | 304 MB |
| 100,000 strings | 546 regions, 32 KB | 32 MB | 36 MB |
| 400 × 256 KB typed arrays | 546 regions, **100 MB** | 3.7 MB | 108 MB |

So **546 is JavaScriptCore's fixed reservation layout** (its cages and VM
reservations), present in an empty engine, and the bytes inside it are
ArrayBuffer and typed-array storage. It is not a count of instances: the live
app's 546 is exactly what an empty engine has. The 3.2 GB of WebKit Malloc is
the ordinary JS heap and DOM:
objects, strings and nodes something is still holding.

The app instantiates no WebAssembly either, so there was nothing to
re-instantiate:

- No direct dependency calls `WebAssembly.instantiate`/`compile`/`Module`.
  `docx` only carries a util polyfill's `isWebAssemblyCompiledModule` type
  check. three's draco and meshopt decoders sit under `examples/jsm/libs`,
  which nothing imports (src imports `three`, `OrbitControls` and
  `BufferGeometryUtils`). `@dimforge/rapier3d-compat` arrives only with
  `@types/three`.
- `vite build` emits no `.wasm` asset and no inline module (no `AGFzbQ`, no
  `\0asm`). The four chunks that mention `WebAssembly` do so as a language
  name (CodeMirror's language list, highlight.js's wasm grammar and its JS
  globals list) or as that util check.

## 2. What grew, and what holds it now

Each finding is a collection or object the page kept for longer than anything
could use it. Soak numbers are from `scripts/memory-soak.mjs` (section 4),
before and after, same Chrome.

| Finding | Where | Cap now | Soak before → after |
|---|---|---|---|
| **Browser tab pictures.** A PNG data URL as wide as the tile, kept for every tab ever captured. Closing a tab or swapping workspaces never removed one. | `BrowserPane` `tabShots` | One per open tab (`shotsForOpenTabs`); a picture landing for a tab that closed meanwhile is dropped. | not in the soak; unit-tested |
| **Repo logos, one copy per directory.** The cache kept every directory a terminal had ever been in, forever, and each answer was a fresh copy of the repo's logo (a file of up to 512 KB). A terminal `cd`-ing through one repo multiplied its logo. | `useRepoIcons` | One copy per repo; at most `MAX_REPO_DIRS` (256) directories, earliest first, never one a mounted tab shows. | 300 directories of 3 repos: **+75.2 MB → +0.95 MB** |
| **Collab rooms kept their whole Y.Doc.** y-webrtc 10.3's `destroy()` leaves the provider in the shared signaling socket's provider set (only `disconnect()` takes it out, and only that closes the socket, which otherwise reconnects forever), and leaves the awareness's 3 s outdated-peer interval running (only `awareness.destroy()` clears it, and y-webrtc calls that only from `doc.destroy()`, which PlanEditor deliberately never calls). Both reach the doc. | `collab/provider.ts` `destroy` | `disconnect()`, `destroy()`, `awareness.destroy()`: nothing is left that reaches the doc. | 20 rooms joined and left: **20 docs alive → 0** |
| **Broken diagrams left nodes in `<body>`.** With error rendering on (the default), mermaid 11 draws its error diagram into the `d`-prefixed wrapper it measures in, appended to `<body>`, then throws before removing it. MermaidView's sweep removed the inner svg, not the wrapper. | `MermaidView` | `suppressErrorRendering: true` (our own error card was always what showed), and the sweep removes the wrapper too. | **26 nodes after 13 cycles → 0** |
| **Every version of every plan.** The Front Door's research ranking cached plan text (up to 20 KB) per `(session, updatedAt)`: each new version joined the old ones for the app's lifetime. | `doorRecents` `planCache` | One version per plan, at most `PLAN_CACHE_MAX` (32) plans. | unit-tested |
| **Long threads in memory.** A mounted chat holds its whole persisted thread. It is released on unmount (the soak's mount/stream/unmount cycles leave 0 listeners and flat heap, before and after), but nothing bounded a long one. No surface pages its history yet. | `agentTurn` reducer, `VoicePanel` transcript | The newest `THREAD_KEEP` (1,000) rows; the rest stay in SQLite, where the agent still reads them. | 2,400-row thread open: **2,400 rows, +14.0 MB → 1,000 rows, +6.5 MB** |
| Rasterized repo marks, one PNG data URL per repo name shown. | `repoMarkImage` | `MAX_MARKS` (128) | not in the soak |

## 3. Checked, and already bounded

- **Listeners and timers.** 320 `listen(`, `setInterval(` and
  `addEventListener(` sites in src. 252 sit in an effect, and every one of those
  effects returns a cleanup. The other 68 are drag gestures that remove their
  listeners on pointer-up, ProseMirror plugin views with `destroy`, classes
  with `dispose` (the memory cosmos scene and flight), the turn controller
  (`detach` clears its listeners and heal timer), and app-lifetime singletons
  (the fs-watch fan-out, the file-drop router, the perf probe).
- **Tauri IPC.** `invoke` registers two one-shot callbacks and the settling one
  unregisters the other (tauri 2.11 `core.js`). A `Channel`'s callback is
  unregistered when the Rust side drops it (the `end` message); `pty_detach`
  drops the terminal's channel, so a disposed xterm is not reachable through it.
- **Terminals.** xterm is disposed on unmount with its addons; the WebGL addon
  lives only while the terminal is visible (`MAX_WEBGL`); a hidden terminal's
  unparsed output is capped at 2 MB; scrollback is 5,000 lines. The count is the
  user's (rule 5).
- **MarkdownView** has no module-level cache: one markdown-it and one
  highlight.js instance, and a per-instance `useMemo`.
- **Memory cosmos** disposes its renderer (with `forceContextLoss`), geometries,
  materials and observers on unmount.
- **Existing caps:** shots LRU 60, git history detail 64 per view, AI review log
  and orchestration tail 60,000 characters, activity ring 40, perf probe ring
  two minutes. The push log is one line per push step and resets per push.

Left as they are, with their bound written down in rule 7:

- **The drafter's session cache** (`App` `drafterSessionCache`) keeps one
  document per draft flushed this run. A session entry is what keeps a remount
  ahead of a database still in its persist retry window, so evicting one trades
  a correctness guarantee for a few KB of prompt text.
- **Per-id bookkeeping** that is a few bytes per id seen this run: the terminal
  handoff seams (`ptySpawned`, and an 8 KB tail only for an observed terminal;
  the comment in `TerminalView` says why they outlive a close), terminal titles
  and cwds in `TerminalTabs`, `autoDiscussed` in `CommentThread`, closed-tab ids
  in `BrowserPane`, workspace revisions in `browserWorkspace`, and repo mark
  geometry (five numbers per repo name).

## 4. The soak harness

`node scripts/memory-soak.mjs [report.json] [--cycles N]` mounts the real chat
hook, MarkdownView (rich, so diagrams render), StreamingBubble, collab provider
and repo-icon hook in headless Chrome, behind a synthetic Tauri boundary
(`fixtures/memory-soak`). Between steps it forces two garbage collections and
reads the JS heap, DOM node and listener counts, the page's event-bus listeners,
leftover diagram nodes, and live `Y.Doc` instances (`Runtime.queryObjects`).
It takes about 45 seconds.

| Scenario | Before | After |
|---|---|---|
| 12 × mount a chat (40 rows), stream 8 replies, unmount | 0.029 MB/cycle, 26 diagram nodes left, 0 listeners left | 0.023 MB/cycle, 0 nodes, 0 listeners |
| Open a 2,400-row thread | 2,400 rows, +14.03 MB; +0.07 MB after close | 1,000 rows, +6.45 MB; +0.04 MB after close |
| Join and leave 20 rooms | 20 of 20 docs alive, +1.49 MB | 0 alive, +0.38 MB |
| `cd` through 300 directories of 3 repos (256 KB logos) | 300 cached, +75.2 MB | 256 cached, +0.95 MB |

Full series: `docs/renderer-memory-soak-2026-10-09.json`. The soak runs V8, not
JavaScriptCore, and React's development build, so the absolute numbers are
Chrome's. What carries over is growth per step, and objects that outlive
their surface. A plan's real Y.Doc carries the plan's whole edit history, so the
retained rooms cost far more in the app than the 75 KB fixture documents here.

## 5. Reading it in the app

`GET /v1/perf` now carries `renderer: {pid, footprintBytes}`: the main
webview's WebContent pid (WKWebView's `_webProcessIdentifier`) and its
`proc_pid_rusage` physical footprint, the number `footprint` and Activity
Monitor report. It is there whether or not the probe is on, and on the 502 when
the page can't answer. A watch thread started after the reveal finds the pid
(again every minute, since WebKit relaunches a crashed renderer under a new
one) and logs one warning when the footprint passes 1.5 GB, and again only
after it has dropped back below. It costs the release binary about 10 KB of
code (one 16 KB page of file size, 41,289,920 → 41,306,720 B); a first version
that awaited the pid on a channel cost twice that. Checked on this machine with
a Swift probe: a WKWebView answers `_webProcessIdentifier` with a
`com.apple.WebKit.WebContent` pid, and `proc_pid_rusage` reads it (9 MB for a
blank page).

Still to do, with a person at the keyboard: the plan's verification is
**renderer footprint after 8 hours within 20% of the 1-hour reading**, on the
release build. Read it with `curl -s localhost:7676/v1/perf | jq .renderer` at
1 h and 8 h (or `scripts/perf-idle.sh`), and take a Web Inspector heap
snapshot at both in a dev build to diff by constructor if it isn't flat.
