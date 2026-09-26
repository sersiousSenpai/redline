# Browser layout and menu repair — 2026-09-14

The browser now has familiar navigation, an address/search field, one Chat toggle and one Page menu. Page arrangements use visual previews labeled One page through Four pages. Changing the arrangement preserves the conversation state. Bookmarks, appearance, preferences and research use bounded, keyboard-accessible dialogs. Reading adjustments remain collapsed until requested.

The conversation header has a thread picker, one actions menu and close. New and Branch remain explicit actions; follow/pin, text size, a second conversation and page notes are in Conversation settings. Existing linked conversations and research workspaces remain accessible. The selected Redline conversation retains its mounted identity and draft when moved into the browser. Page selection and element attachments reveal their destination conversation before consuming a seed.

## Rendering fixes

- The browser host is explicitly attached and detached through a keyed portal slot. React can no longer reuse an unkeyed document container while leaving the browser's imperative DOM attached beside the Front Door.
- Every ancestor from the app's work area to either chat has bounded flex sizing. Messages scroll independently; the composer stays reachable. Long browser-chat drafts grow to 160 pixels, then scroll internally.
- A per-native-label controller serializes positioning, sizing, showing and hiding. A delayed show cannot win over a later hide, and a hidden page with unchanged bounds is shown again when its overlay closes.
- Native creation checks mount/workspace identity before adopting its result. Late creation hides the view. Cleanup stops visibility immediately, cleans late resize subscriptions, and preserves the existing short remount grace period.
- Native rectangles intersect the actual slot, clipping ancestors and viewport. Fullscreen follows fixed-position containing-block rules. Hidden/disconnected ancestors reject visibility. Global divider drags hide native views, and layout settling compares current DOM measurements.
- Menu registration occurs before paint; cached page images stand in while native views are hidden. Failed native creation/navigation/geometry exposes a bounded retry state. Inactive browser shortcuts and stale focus/selection events cannot take over another surface.

The separate [hook-conflict modal repair](hook-conflict-modal-repair-2026-09-13.md) remains included: warning, removal result and restart confirmation stay in the regular modal, outside the window-control layout.

## Verification

- `npx tsc --noEmit` passed.
- All **2,053 frontend tests across 184 files** passed, including portal containment, menu focus/placement, draft continuity, selection routing and native visibility/creation races.
- `APPLE_SIGNING_IDENTITY=- npx tauri build --bundles app --ci` passed on the final source. All 653 recorded source-file hashes were unchanged during that build.
- `codesign --verify --deep --strict` passed on the [rebuilt local app](../src-tauri/target/release/bundle/macos/Redline.app).
- `node scripts/check-size.mjs --strict` passed with the existing ceilings. Release executable: **37,467,840 bytes**; boot JavaScript: **589,660 bytes**; frontend dist: **8,363,465 bytes**; signed app file total: **37,607,943 bytes**. No additional size-budget increase was made.
- `git diff --check` passed.

The final executable SHA-256 is `3c9d7191e39bc0dc37f3ef17f7e59ae3a5818795b85fa9946bb3c51c437ddcd5`. [Structured build results](browser-refresh-build-results-2026-09-14.json) record the exact measurements. Logs are `/tmp/redline-browser-refresh-vitest.log`, `/tmp/redline-browser-refresh-final-app-build.log` and `/tmp/redline-browser-refresh-size.log`.

The [component visual report](browser-refresh-visual-qa-2026-09-13.md) records **102 passing checks**, zero browser errors and 33 screenshots at 900×640, 1200×800 and 1600×900, including a light theme. It uses the production components and theme CSS with synthetic page images and transport. It verifies composer/message bounds, menus/dialogs, focus containment, exact portal/draft identity, divider dragging and responsive arrangement restoration.

The native Computer Use service failed to start. Native WKWebView rendering, gesture behavior and latency still require an interactive walkthrough; the component screenshots and controller tests do not claim that verification. The local app is rebuilt but is not installed or launched, preserving the user's running sessions.

This completes the browser/menu correction within the earlier four-plan implementation. The Joey product plan remains excluded. No changes were committed or deployed.
