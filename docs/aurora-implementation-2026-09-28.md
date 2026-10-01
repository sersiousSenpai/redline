# Aurora and Monochat — implementation record

Redline now has one persistent floating conversation across app surfaces, a Codex setup and recovery flow, native Codex conversation turns, and mixed Codex/Claude run nodes. This is a local source update. The running packaged app has not been replaced or restarted.

A development macOS bundle was produced with `npm run tauri -- build --debug --bundles app` at `src-tauri/target/debug/bundle/macos/Redline.app`. This is a local review build, not a notarized release or an installation into `/Applications`.

## User experience

- **Home composer:** the welcome text remains, with no redundant “Start something” button. A compact, immediately writable floating input sits beneath it. Focus reveals the conversation controls, and the window grows with the draft. The former document-plate front door is retired: its glass composer, project selection, Plan/Chat/Draft destinations, attachments, dictation, readiness fixes, combine flow, and launch receipts all live inside this same island. There is one root input. Saved drafts from the former chat input migrate into it; a second message is retained while the first send waits for conversation creation/history.
- **Working surfaces:** a small tab rests at the lower-right edge above the existing footer, horizontally clear of the centered terminal toggle and common centered dictation indicator position. Hover or keyboard focus reveals a chat preview; hover does not take document focus. Leaving retracts the preview after a short grace interval. The first click pins a larger conversation without activating a control that moved beneath the pointer; moving to another surface returns the root conversation to its resting tab, retaining its transcript and draft. Explicit anchored discussions stay open. The header grip supports pointer dragging, arrow-key movement, and double-click reset. The new edge-relative position preference intentionally replaces the old centered, raised placement. Cmd-J reveals the composer, including while a native browser page has keyboard focus. Escape dismisses a menu first, then compacts/minimizes the island. Minimize restores document focus.
- **Pickers:** custom glass menus for harness, model, project, destination, and conversation actions. Model choices are selected rows; reasoning effort uses discrete buttons. Menus have viewport clamping, keyboard navigation, Escape dismissal, and focus return. Conversation rename/delete use themed in-app dialogs.
- **Anchored discussions:** plan comments, draft comments, and code-review threads open inside the same island. Their original scope, transcript attachment, stale attachment checks, discard/reopen behavior, and action-item controls remain in their existing components and backend contracts. Inline threads and the island share one persisted draft snapshot. A busy discussion remains visible in the notch's activity state.
- **Browser and memory:** selection questions enter Monochat. Mission findings and saved browser items remain reachable as focused island views; discussion returns to the shared conversation. The Memory question entry opens Monochat. Old stored conversations remain in the database.
- **Aurora:** a dark galactic palette, restrained background glows, iridescent surface edges, and slow border motion. Reduced-motion settings suppress decorative animation and collapse transition duration. Existing theme preferences are retained; Aurora is the default for new preferences.
- **External capture:** Memory now says “Capture external harness sessions” and explains that capture depends on connected prompt hooks, including Codex. The persisted opt-in key and capture policy remain compatible.

## Codex setup and compatibility

The selected harness drives proactive setup and launch readiness. Codex setup shows the CLI/version, account state, planning profile, review skills, hooks, and hook trust. Missing files, an unusable CLI, a signed-out account, and unverified trust have an actionable modal. Independent install steps report their own failures, then verify the complete integration. A pending launch retains its prompt, project, and selected harness and resumes only after verification.

The install action stages the official npm package in a unique directory under `CODEX_HOME/redline-runtime/versions`. Redline selects the candidate only after capability/version checks. Existing candidates and global/bundled installations are left intact. npm must be present, or the user can locate an existing executable. Installation is bounded and reports failure in the modal.

Codex owns authentication and hook trust. Redline opens an in-app terminal for login and `/hooks`, then offers verification and continuation. It does not edit trust records. Hook trust is read through `hooks/list`, including the target project at launch; health cached for one project cannot satisfy another project's launch. Binary discovery, version/help probes, login status, and metadata RPCs have deadlines. Skills honor `CODEX_HOME`.

The existing Codex planning Stop-hook review and approval handoff is retained. The update fixes setup and readiness around that contract; it does not replace the planning TUI with an unverified protocol.

## Shared context and execution

Each queued conversation turn captures its surface, browser target, project, and harness at enqueue time. Later navigation cannot redirect it. The root transcript persists across harness switches; switching providers starts the appropriate provider session with a bounded recap. Native provider session IDs are kept separate. Anchored threads receive bounded shared context and preserve their own source identity.

Codex foreground turns use app-server initialization, acknowledged thread start/resume, turn start, streaming events, final items, and native usage notifications. Foreign turns and duplicate items are ignored. Unsupported approval requests receive explicit rejection instead of hanging. Foreground discussion remains read-only except for explicitly authorized Redline bridge actions.

The local intent router is deterministic and conservative. An entire browser instruction containing one explicit HTTP(S) URL can dispatch navigation directly to its captured tab without a model turn. Quoted, mixed, credential-bearing, and ambiguous instructions fall through to the selected reasoning harness. Recall intents prefetch the existing answer pack. Derived intent labels live in local traces; they do not rewrite the immutable memory lake or turn inferred preferences into user decisions. No Jev service or additional model subscription is required.

Run tasks and independent reviews accept Codex or Claude. Codex-native task execution uses a read-only sandbox and exact file-change approvals: every path, including a rename destination, must pass scope, ownership, and active-attempt checks. Broad root grants and shell escalation are declined; external MCP/app mutation paths are disabled for that task. Dependency scheduling and independent verification remain in Redline. Codex structured reviews disable shell, web search, and connected tools.

Per-run concurrency limits exist independently for Codex and Claude. A rate-limited node waits for intervention while independent work on another harness can continue. Users can retry or reassign it. Conversation and run thresholds pause new dispatch based on observed tokens; active turns can exceed a threshold. These are ergonomic dispatch controls, not billing caps or organization-wide quota guarantees.

## Observability

The Activity & usage view shows local route, surface, provider/model, status, elapsed time, observed input/output/cache tokens, context occupancy where reported, rate-limit reset information, and provider-reported cost. Missing cost stays unknown. The panel also edits token thresholds and concurrency preferences. Conversation turns, anchored discussions, and run nodes produce local trace records; related run nodes link back to the originating conversation. Retention is bounded to 5,000 records, with 100 recent operations displayed per conversation.

## Verification and boundaries

Validation on this checkout:

- `npm test -- --reporter=dot`: 210 files, **2,246 tests passed**.
- `cargo test --lib`: **1,387 tests passed** across the application and workspace libraries; **14 intentionally ignored** live/fixture-dependent tests.
- `npm run build`: TypeScript and production Vite build passed. Vite reports existing large-chunk and CSS highlight-selector advisories.
- `cargo build -p redline`: native development build passed. Existing native warnings remain.
- `npm run tauri -- build --debug --bundles app`: native app bundle built successfully with the production frontend embedded.
- The generated development bundle initially failed strict resource-signature verification. Re-signing this local bundle ad hoc with `src-tauri/Entitlements.plist` repaired it; `codesign --verify --deep --strict` then passed. No personal signing identity or installed application was changed.
- `node scripts/monochat-visual-qa.mjs`: **102 checks passed**, with no browser runtime errors.
- `git diff --check`: passed. Pre-existing Memory Cosmos, fixture, and activation work was preserved.

The reproducible visual suite imports production island, original launch composer, chat, custom picker, setup-dialog, and theme components with synthetic service responses. It exercises 1440×960, 900×640, and 480×720 layouts with the production footer and terminal divider: home input growth, hover/focus preview, click expansion, control containment, terminal separation, unchanged footer/document dimensions, draft preservation, focus restoration, menus, modal dismissal, sidecar switching, and reduced motion. The fixture's document and sidecar contents are illustrative, not a captured live agent session. See [visual report](monochat-aurora-qa-2026-09-28/report.json) and [home composer](monochat-aurora-qa-2026-09-28/1440x960-home-entry.png), [resting tab](monochat-aurora-qa-2026-09-28/1440x960-notch.png), and [hover preview](monochat-aurora-qa-2026-09-28/1440x960-hover-preview.png). Run it with `node scripts/monochat-visual-qa.mjs`.

Native regression coverage includes protocol acknowledgment and turn scoping, duplicate delivery, cached-token accounting, rate-limit updates, task tool configuration, exact patch approval, scope/ownership/stale-attempt rejection, mixed-harness capacity, intent routing, and trace persistence. Frontend regression coverage includes project-scoped health caching, independent setup repair, draft restoration after rejected sends, shared sidecar drafts, and single-composer draft migration, floating plan launch, custom picker keyboard behavior, saved island positioning, and native browser geometry.

The previous bottom-band browser reservation has been removed. The footer component and its dimensions are unchanged. On macOS a shared AppKit plane preserves native page frames and uses rounded alpha-mask cutouts for the floating island and its menus. Hit tests in those cutouts fall through to the app webview; the surrounding live page keeps receiving input. Overlapping picker/island masks compose without reopening holes. This follows AppKit's [hit-testing](https://developer.apple.com/documentation/appkit/nsview/hittest(_:)) and Core Animation's [layer mask](https://developer.apple.com/documentation/quartzcore/calayer/mask) contracts.

`cargo run --example browser_overlay_probe` passed on the main thread with a real WKWebView, checking unchanged page dimensions, rounded hit testing, input reaching the app below, overlapping menu masks, shared tile composition, hidden-page input, and parent resizing. The probe opens no visible window or URL and touches no user database.

This remains an in-app floating surface, not a system-wide macOS panel. The new native composition adapter is macOS-specific. Live computer-use inspection was unavailable (the local service failed to start), so placement against the user's active Wispr Flow indicator, browser video playback during morphs, and interactive packaged-app acceptance are not visually verified. The lower-right default and adjustable position avoid the centered controls without claiming detection of another app's UI.

No paid live Codex/Claude model turns, OAuth login, npm installation, hook trust changes, or real multi-harness write run were performed during verification. Passing replay/unit/component tests and local metadata inspection does not establish live end-to-end provider parity. Learned intent classification, automatic preference learning, remote node provisioning, organization-wide spend enforcement, and automatic provider substitution are broader product directions, not features claimed by this update. Market leadership requires measured user outcomes; no competitive performance result is asserted.
