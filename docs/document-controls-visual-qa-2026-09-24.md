# Document controls visual verification — 2026-09-24

The actual `DrafterToolbar`, Tiptap editor, `DocWidthToggle`, and application theme CSS passed **142 checks** in an isolated headless Chrome profile. The fixture performs no daemon calls and changes no user documents or settings. Run it with `node scripts/document-controls-visual-qa.mjs`.

[Structured results](document-controls-visual-qa-2026-09-24/results.json) record component source hashes, measured geometry, and all checks. The output directory contains 25 screenshots.

- All ten ribbon menus have their intended content widths at 1600, 900, and 520 pixels. Native-overlay registrations balance, Escape closes the panel, and opening each menu preserves the live editor selection.
- Both color menus show seven swatch columns. Table shows all 80 cells in ten columns and eight rows inside the **scroll viewport's client bounds**, including the last column.
- Visual inspection found an extra classic-scrollbar issue: a 205px Table panel still lost part of its tenth column to the scrollbar. The ribbon now measures that gutter once and includes it in both positioning and rendered width. On the tested browser the panel is 220px: 205px content/chrome plus a 15px scrollbar. The shared popover helper is unchanged. [Narrow Table screenshot](document-controls-visual-qa-2026-09-24/520px-table.png).
- A width drag changed the article from 1000px to 1252px while recording no commit. Releasing recorded exactly one commit, with no geometry jump or accidental toggle. Tap restored the saved measure; Escape restored the committed width; holding without movement did nothing; the full-width endpoint preserved the saved measure; a narrow pane disabled dragging while keeping the normal toggle. [Live drag](document-controls-visual-qa-2026-09-24/width-live-drag.png), [committed width](document-controls-visual-qa-2026-09-24/width-committed-measure.png).

The screenshots were visually inspected. This verifies browser layout and pointer interactions in component fixtures. Native WKWebView compositing, macOS window controls, and the complete running app were not exercised by this harness; the native computer-use service could not start in this session.
