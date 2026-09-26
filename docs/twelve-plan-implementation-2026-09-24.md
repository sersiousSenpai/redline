# Twelve-plan implementation — September 24, 2026

All twelve supplied plans were reviewed against the existing working tree. Three
parallel implementation agents covered browser/fullscreen, conversations, and
backend repairs; the primary session implemented Memory Cosmos and document
controls, integrated the changes, and ran the combined checks. Existing dirty
and untracked work was preserved. Changes remain uncommitted.

## Plan coverage

| Supplied plan | Result |
| --- | --- |
| Detect and resolve Plannotator hook conflicts | Audited the existing scanner, targeted removal, plugin precedence, file watcher and stale-result protections. Replaced automatic conflict-modal opening with a persistent nonblocking shell warning. Setup and Settings retain details/actions. Hardened handler ownership without losing Redline's generated capture wrapper, and preserved matcher metadata and unrelated empty hook containers. |
| Fix plan-discussion “temporary model error” | Startup strips inherited Claude session/process variables while retaining user configuration. Shared transcript lookup respects `CLAUDE_CONFIG_DIR`. Missing author transcripts seed a fresh, read-only discussion with plan/comment/history context; follow-ups resume its own thread. Actual CLI diagnostics are retained, and missing conversations are not described as transient errors. |
| Fix Prompt Drafter ribbon dropdowns | Every menu has an explicit content width independent of its trigger. Table width derives from grid constants. A measured classic-scrollbar gutter is included in both placement and rendering, preventing the final column from clipping. |
| Fix scoped push staging | Present paths use literal `git add` pathspecs; missing paths use literal, ignore-unmatched cached removal. Already-staged deletions/renames succeed, unstaged deletions stage correctly, bracketed filenames remain literal, and empty groups never stage the whole repository. |
| Memory Cosmos | Replaced the 2D Map with a lazily loaded Three.js scene and deterministic worker layout. Added seeded organic planets, bounded curved/branching filaments, relationship inspection, Orbit/Fly, approach/Home, pointer capture recovery, reduced motion, depth-aware labels, keyboard list, camera/selection restoration and WebGL recovery. Graphics leases are shared with terminal rendering. |
| One conversation at a time | Panel overrides are independent; terminal gestures do not open Discussion. Dock visibility is scoped to Home/plan/drafter/browser, and Home chat stays at Home. One-shot Chat/Plan submission produces a saved sourced brief, launch receipt and matching-ID transition into the plan. Prior chat context appears in the plan conversation. Queued handoffs survive Home unmounts; unrelated chats and fast arrivals cannot steal focus or regress a completed receipt. |
| Plan discussion slowdown and per-thread model/effort | Added a picker in both unopened and open comment threads. Overrides persist per comment and survive discard; Claude/Codex spawning and model attribution use them. The existing local `fork_plan` seat was changed from `opus/max` to `opus/xhigh`, preserving all other settings. |
| Press-and-hold document width | Tap retains wide/reading-width toggle; hold/vertical drag previews a continuous width with snapping, live readout and pointer capture. Release commits once; Escape/cancellation restore the initial width. Persisted reading measure and live control clearance use shared style math. |
| Browser refresh | Preserved and audited existing durable workspaces, arrangements, conversation identities, research artifacts, continuation, appearance and typed actions. Closed the remaining focus-mode gap: the transient address field and Page menu no longer change the stage geometry. |
| Remove “While you were away” | Confirmed the existing frontend removal and backend command/query deletion are complete. Companion containment and approval filing remain; no work-item cleanup was performed. |
| Restore injection misdiagnosis | Revised visible and hidden restore text to explain the user's Restore action, safe saved plan and expected marker replacement. Updated the review skill to v15 and pinned the normal deny-loop prefix. Completed the requested isolated five-per-variant replay and recorded its limitations. |
| Two-stage browser video fullscreen | Added browser-pane and monitor stages, owned-window tracking, hover exits, Escape routing, temporary-hide stability, filter/containing-block recovery, video/WebKit APIs, cross-frame cascading exit and detached-element cleanup. Native window transitions are serialized and guarded. |

## Verification

The final integrated tree passed:

- Frontend: **2,159 tests across 200 files**, with no failures.
- Rust: **1,397 tests**, with no failures and 15 ignored. The ignored native
  Apple Vision OCR fixture was then run separately and passed.
- TypeScript and the signed production application build.
- Strict size checks, license checks and `git diff --check`.
- Clippy completed successfully, with 84 library warnings and one activation
  helper warning; this is not a warning-free result.
- [Isolated native startup probe](twelve-plan-native-probe-2026-09-24.json):
  migrated a disposable copy of the user database, rendered the frontend and
  completed an IPC round trip in **2.358 seconds**, read 281 plans and one run,
  and shut down cleanly. Injected inherited session variables were scrubbed.

Focused visual and behavior evidence includes:

- [Document controls visual report](document-controls-visual-qa-2026-09-24.md):
  **142 checks and 25 screenshots**, using actual components at 1600, 900 and
  520 pixels. The Table scrollbar issue was found by visual inspection and
  verified against the scroll viewport's client bounds after repair.
- [Cosmos structured results](memory-cosmos-visual-qa-2026-09-24/results.json):
  **16 checks passed**, covering orbit, flight, exact Timeline focus, camera
  restoration, filters, resize, reduced motion, empty/single/over-limit data,
  context loss/retry and repeated Map–Timeline switching. With 150 nodes,
  Chrome on this Mac measured **16.7 ms median and 16.7 ms p95 frame intervals**
  at 900×680 and pixel ratio 1. These are browser frame intervals, not GPU
  timing or a native WKWebView benchmark.
- [Cosmos overview](memory-cosmos-visual-qa-2026-09-24/overview-150.png) and
  [close-range planet](memory-cosmos-visual-qa-2026-09-24/close-range-planet.png).
  Images were inspected; foreground geometry now increases detail near the
  camera and the peripheral visor remains subtle.
- [Browser/fullscreen audit](browser-fullscreen-2026-09-24.md) records stage,
  geometry, shim and controller coverage alongside existing browser work.
- [Conversation workflow report](conversation-workflow-2026-09-24.md) records
  handoff continuity, discussion recovery and model/effort regression coverage.
- [Restore A/B report](restore-replay-verification-2026-09-24.md): five old and
  five new trials all attempted ExitPlanMode first, without modifying the
  plan. The old refusal did not reproduce, and the current CLI disables the
  tool in print mode before the capture hook. This is a **weak behavioral
  evaluation**, not proof that the original refusal or live handshake is fixed.

## Size review

The available pre-task frontend artifact was 8,400,730 bytes. The first
integrated production build was 8,990,298 bytes (+589,568); the lazy Cosmos
chunk accounted for 563,609 bytes (95.60% of that aggregate increase). Its
worker, host and CSS accounted for another 14,527 bytes. This comparison uses
the existing pre-task artifact, not an isolated rebuilt source baseline.

An independent agent reviewed the build inventory, strict checker and static
boot closure. The explicit Three.js feature spend justified a bounded increase
of `distTotalBytes` from 8,500,000 to **9,150,000 bytes**. All other ceilings and
the checker remain unchanged. The reviewed boot closure was 599,267 bytes,
under 660,000, with Three.js entirely off the boot path. A source guard now
pins App → lazy MemorySurface → lazy MemoryMap → lazy scene. See
[the budget record](perf-budget.md#memory-cosmos-feature-budget--reviewed-2026-09-24).

Final packaged-build measurements:

| Artifact | Bytes | Limit |
| --- | ---: | ---: |
| Release executable before bundle signing | 38,431,936 | 38,500,000 |
| Activation helper | 546,112 | 800,000 |
| Boot-path JavaScript | 599,304 | 660,000 |
| Frontend distribution | 8,991,623 | 9,150,000 |

[Artifact hashes and inventory](twelve-plan-artifacts-2026-09-24.json) identify
the exact verified build. The signed bundled executable is 38,451,024 bytes.

## Installation

The verified application was installed at `/Applications/Redline.app` using
the activation helper and launched. Deep, strict signature verification passed;
the installed executable's SHA-256 matches the verified bundle:
`6d1ca3df89ffd63469b3b67b46bdb81b7221e01147e6bacc8b19b24e664150bb`.
The daemon's `/v1/liveness` endpoint reports Redline running with an open window
(PID 6036 at verification). The persisted `fork_plan` setting remains
`opus/xhigh` after launch.

The prior application was backed up to
`~/Library/Application Support/com.redline.app/manual-build-backups/20260924-135844/Redline.app`.
See the [installation record](twelve-plan-installation-2026-09-24.json).
No source changes were committed or pushed.

## Runtime scope and remaining validation

The native Computer Use service was attempted and returned
`Sky Computer Use service startup request failed`, with no apps or browsers.
Native YouTube/Vimeo/iframe playback, macOS monitor fullscreen, trackpad and
window gestures, OAuth, file dialogs/downloads, audio and WebContent crash
recovery therefore remain unverified. Chrome fixtures and mocked native tests
are explicitly narrower evidence.

Actual Claude/Codex discussion time-to-first-response, live model/effort argv
and real microphone continuity were not measured. The slowdown's explicit
configuration change is applied, but no new latency claim is made. The
`fork_plan` setting was backed up and updated transactionally only after
confirming no Redline process was running; no in-memory cache was bypassed.

The original qwallah staged deletion remains present on read-only inspection.
Push regression tests reproduce that shape in disposable repositories; no
qwallah commit/push or live review replay was performed. Current Codex hook
configuration contains Redline only, so conflict/removal validation used
fixtures instead of changing a live installation. Synthetic restore transcripts
and replay scratch files were removed.
