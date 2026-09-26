# Tab destination and focus correction — 2026-09-25

The reported “drag tab 1 to position 3 to reach position 2” was a destination-contract mismatch. The drag preview returned the final array slot, but `BrowserPane.reorderTabs` interpreted it as an insert-before target and subtracted one for rightward moves. Adjacent rightward drops therefore did nothing; longer rightward drops landed one position early.

The shared `reorderTabs` function now inserts at the requested final index in either direction. Both BrowserPane and the browser fixture import it from `browserTabDrag.ts`. The earlier fixture had its own correct implementation and therefore missed the production error. New integration tests drive pointer events through BrowserPane and check the committed order in both directions, including a two-tab strip.

Tab presses explicitly transfer focus out of the address input before pointer capture prevents the browser's default focus change. Tabs use the normal arrow cursor on hover and during dragging. Inactive tabs receive a restrained background on hover instead of a blue outline; keyboard focus indicators and tile correspondence remain available.

The new-tab + button now lives directly after the final tab inside the scrolling row, with a 3 px gap. It sticks to the right edge when tabs overflow. Geometry checks cover one, two, and four tabs with short and long titles at three window widths, plus overflow visibility. This replaces the earlier check that only established the button's DOM position outside the strip.

Verification:

- Four regression cases failed before the fix, reproducing the rightward index error and stale address focus.
- All 56 focused tests passed across tab dragging, BrowserChrome, BrowserPane, pane lifecycle, and tile controls.
- TypeScript and `git diff --check` passed.
- The [browser fixture](browser-tab-position-visual-qa-2026-09-25/results.json) passed 145 checks with 36 screenshots and no console errors, using the same reorder function as production. It also rechecked full/partial address copying and captured [tab selection without address highlighting](browser-tab-position-visual-qa-2026-09-25/1600x900-tab-selected.png) and [new-tab spacing](browser-tab-position-visual-qa-2026-09-25/1600x900-new-tab-spacing.png).
- The final macOS build includes all four tab corrections, its activation helper, and release identity `rel-1790406390-f96e167`. Strict code-signature verification and all size budgets passed. [Build measurements](browser-tab-position-visual-qa-2026-09-25/build.json): executable 38,231,792 B; boot JavaScript 600,006 B; frontend assets 8,972,246 B.

Updated package: [`Redline.app`](../src-tauri/target/release/bundle/macos/Redline.app).

The interactive checks use isolated Chrome with synthetic native services. Native macOS WKWebView interaction was not directly automated.
