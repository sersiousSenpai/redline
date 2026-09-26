# Four-plan implementation — 2026-09-13

This work implements the browser refresh, removal of the “While you were away” strip, Plannotator conflict detection/removal, and the performance plan. The Joey Home + Tasks product plan was explicitly excluded. Existing unrelated work in both repositories remains intact; no deployment or commit was made.

The subsequent [hook-conflict modal repair](hook-conflict-modal-repair-2026-09-13.md) fixes the warning/confirmation overlapping the window controls. Its 2,008-test run and rebuilt-app measurements supersede the initial frontend verification and artifact hash below.

The later [browser layout and menu repair](browser-refresh-repair-2026-09-14.md) supersedes the original browser chrome and layout names, fixes portal/native visibility races and bounds the chat composer. It includes the latest aggregate verification and embedded-app measurements.

## Delivered changes

| Plan | Implementation |
| --- | --- |
| Browser refresh | Simplified browser chrome; visual One/Two/Three/Four page arrangements (legacy layout IDs preserved); measured native tile bounds, keyboard/divider resizing, assignment and maximize; responsive layout preservation; SQLite workspace revisions; persistent browser and selected ChatRoom portals; stable follow/pin conversation identity; explicit new/branch and two-conversation dock; saved mission pages that can run while another workspace is visible. |
| Conversation and research | Mission creation starts a research turn after persistence; scoped routes, runtime checkpoints and recovery; durable synthesis documents and source links; editable Continue as… previews for browser, linked and Companion discussions; saved Drafter/model-plan/auto handoffs with launch claims, receipts and uncertain-outcome protection. Auto handoffs enter the existing graph review and Run workflow. |
| Browser control | Bounded native page events with a recovery poll; per-page operation queues, explicit stable targets, operation IDs, state preconditions, human interruption and observed outcomes; fill/key/scroll/select/wait operations; in-page element picker with structural metadata and redaction; independent per-site appearance, reading adjustments and zoom. |
| Away strip | Removed frontend feed and backend-only feed query/command. The Companion’s height wrapper, approval filing and Runs → Work graph remain. |
| Hook conflicts | Effective global/project/plugin conflict detection, exact executable parsing, actionable integration warning/settings details, fingerprint-checked selected removal, backup and atomic writes, preserved unrelated hook siblings, serialized configuration maintenance, and watcher refresh. Existing user hook configuration was inspected but not silently removed. |
| Performance | Qwallah instrumentation, bounded SQL/list payloads, narrow selected-resource endpoints, stable mounted lists, lazy optional UI/data, streaming boundaries and complete server pagination. Redline receives versioned mission context, monitoring contracts, optional short keyframe recordings with local OCR and playback, evidence review and a headless consumer. |

The mission foundation’s schema, contracts and worked Securities Dev reference are documented in [mission-context-foundation.md](mission-context-foundation.md). The capture adapter evaluation and isolated CPU/memory/latency results are in [capture-performance-2026-09-13.md](capture-performance-2026-09-13.md). The CRM’s measured results and reproduction commands are in [`qwallah/docs/performance/2026-09-13.md`](../../qwallah/docs/performance/2026-09-13.md).

## Important implementation boundaries

- A conversation brief quotes its source messages with explicit user/assistant roles. Suggestions are not promoted to decisions. The user can edit the brief before preparing it; exact selected source identities are retained separately.
- Repeating an identical conversation handoff uses the same context/body/destination digest. A launch must claim the saved handoff first. Interrupted or uncertain launches are retained for inspection instead of being automatically replayed.
- Branching creates a new conversation with linked completed-message history and a fresh model process. It does not replay queued turns or actions.
- Optional capture records bounded, timestamped native keyframes with local Apple Vision OCR, text-layout descriptions, playback, extraction checkpoints and retry. DOM text and OCR remain distinct; summaries do not claim semantic image interpretation. Retrace’s upstream Swift interfaces were evaluated, but its display capture is not a replacement for the selected-tab scope. No continuous desktop recording or external capture service is enabled.
- Monitoring definitions and run contracts support a compatible runtime; they do not claim a deployed remote scheduler or model fleet. The Python reference consumer verifies and consumes the exported format without importing Redline.
- No CRM architecture rewrite was justified by the measurements. The conditional Rust experiment was not triggered. Hosted database probes measure the developer laptop’s path to the configured endpoint, not deployed application performance.

## Verification

Verification runs from `redline` unless noted:

- `npm test` — **2,004 tests passed across 176 files**, including browser lifecycle, layout, page-script, continuation and conversation-boundary fixtures.
- `npx tsc --noEmit` and `npm run build` — passed, including the final capture player and workspace-during-snapshot scope fixes.
- `cargo test` in `src-tauri` — **1,291 tests passed, 15 ignored**, across native/unit/workspace, schema-golden, authorization-route and documentation suites. The full run includes workspace scope, transport decoding, recording recovery, exclusions, retention and extraction retry. The final recording-identity regression passed separately. Actual Apple Vision recognition also passed in an isolated run (1.71 seconds); CI now requires that step after the main suite because parallel database-test load exhausted its unchanged five-second production budget. Ignored entries include that separately run fixture and optional/manual benchmarks; the capture benchmarks were also run explicitly.
- `cargo +1.98.1 clippy` in `src-tauri` — completed successfully with 77 warnings in the codebase, including unused/dead-code and API-arity/style warnings. The removed away-feed path leaves no unused-import or dead-code warnings in `work.rs` or `db.rs`.
- `npx tauri build --bundles app` — passed on final source. The embedded release executable is **37,467,840 bytes**; boot JavaScript is **591,051 bytes** and frontend dist **8,339,191 bytes**.
- `node scripts/check-size.mjs --strict` — passed after an independently reviewed binary ceiling increase from 36,050,000 to **37,700,000 bytes**. A clean same-HEAD Tauri baseline was already 140,704 bytes above the original ceiling; these changes add 1,277,136 bytes (+3.529%), leaving 232,160 bytes under the new ceiling. Both frontend limits and the strict checker are unchanged. The existing 15% aspirational boot-headroom goal remains unmet. Reproduction, artifact hashes and the review rationale are in [perf-budget.md](perf-budget.md#four-plan-implementation-measured-2026-09-13).
- Local bundle verification — the default build had only a linker signature. Rebundling the same executable with `APPLE_SIGNING_IDENTITY=- npx tauri bundle --bundles app --ci` applied the configured entitlements and an explicit ad-hoc signature; `codesign --verify --deep --strict` then passed. The resulting [Redline.app](../src-tauri/target/release/bundle/macos/Redline.app) contains 37,607,943 file bytes. It is not notarized and was not installed or launched.
- Qwallah: production build, lint and 155 tests passed, including isolated RLS and the paired query probe. The selected Files payload fell from 63,910 to 25,557 bytes (about 60%). The local query benchmark did not demonstrate lower latency; no browser or Salesforce speedup is claimed.

## Native walkthrough still requiring a working UI service

Computer Use failed to start on all three attempts in this session. Native visual fidelity, warm focus/action p95 under 100 ms, divider smoothness, pinch/back-forward gestures, OAuth popups, downloads, file chooser, fullscreen, background audio and WebContent crash recovery therefore do not have a completed interactive walkthrough.

[`fixtures/browser/control-lab.html`](../fixtures/browser/control-lab.html) is a local fixture for forms, SPA/full navigation, dynamic content, shadow/frame/canvas selection, horizontal scrolling, file input, download, fullscreen and audio. Serve `fixtures/browser` over HTTP and open it in Redline, compare at compact/wide sizes, keep a draft while following/pinning/switching threads, move a selected Companion into the dock, then conduct and resume a mission and exercise all three handoff destinations. Real OAuth behavior requires the relevant provider’s flow in addition to this fixture.

This boundary is explicit: passing source and fixture checks does not establish native visual behavior or user-visible latency.
