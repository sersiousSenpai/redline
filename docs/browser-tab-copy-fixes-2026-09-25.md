# Tab dragging and address copying — 2026-09-25

Follow-up to the browser simplification, addressing the reported need to place dragged tabs precisely and the address bar's unreliable ⌘C.

## Changes

- Reordering follows the dragged tab's geometry instead of the cursor's absolute position. Crossing halfway over a neighboring tab changes the preview, whether the grab began at the left, middle, or right of the tab.
- A small hysteresis prevents adjacent positions from flickering under pointer jitter. A 40 px margin around the strip permits diagonal releases without accidentally assigning the tab to a page tile.
- Overflow scrolling continues while the pointer rests near an edge, using elapsed frame time rather than the number of pointer events.
- Siblings slide aside during dragging. On release, the DOM order commits synchronously and a short animation carries each tab from its existing screen position into its final slot, avoiding the previous jump caused by clearing transforms while React reordered the nodes. Reduced-motion settings are respected.
- The address bar explicitly restores the main native webview's focus so AppKit Edit commands target it. First-click selection survives WebKit's mouseup behavior, while subsequent clicks and partial selections remain editable.
- ⌘C/Ctrl+C copies the actual selected address text through the clipboard API, with a native Copy fallback and a visible failure message. The native `copy` event also supplies the selected plain text. Repeated ⌘L selects the entire current address again.

## Verification

- `npx tsc --noEmit` passed.
- 45 focused tests passed across tab dragging, browser chrome, pane lifecycle, and tile controls. The final clipboard fallback guard was followed by another successful run of all eight BrowserChrome tests.
- The [Chrome visual fixture](browser-tab-copy-visual-qa-2026-09-25/results.json) passed **123 checks**, with **34 screenshots** and no console errors. New cases cover short edge grabs, diagonal release, release-position continuity, stationary-pointer edge scrolling, and actual clipboard reads after ⌘C for full and partial address selections.
- `git diff --check` passed.
- The refreshed macOS package built successfully, includes its activation helper and release identity, and passed strict signature verification. Release: `rel-1790404956-f96e167`.
- Strict size budgets passed: release executable **38,231,792 B**, boot JavaScript **600,006 B**, frontend assets **8,971,905 B**. See [exact build measurements](browser-tab-copy-visual-qa-2026-09-25/build.json).

Updated package: [`Redline.app`](../src-tauri/target/release/bundle/macos/Redline.app).

The existing development app was left running; these changes are frontend-only. Native UI automation could not start (`Sky Computer Use service startup request failed`), so the macOS WKWebView interaction remains unverified directly. Clipboard and pointer checks ran in the isolated Chrome fixture. No production data or installation was changed.
