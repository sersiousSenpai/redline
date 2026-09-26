# Browser simplification — 2026-09-25

Implemented the supplied **Simplify the Redline browser v2** plan against the existing working tree. The original source was copied to `/tmp/redline-browser-baseline-20260925` before editing; unrelated changes were preserved. Nothing was stashed or committed.

## Behavior

- Each tab has its own page chat. Panel visibility persists across tab switches; page/Cart selection remains per-tab. Linked retains the current conversation while its page target follows the active tab, and switching Linked off returns to that tab's thread.
- The chat header has Linked, a three-row menu (Start a research mission, text size, Clear history), and Close. Mission labels now describe their purpose.
- One workspace Cart replaces list templates. Replies and highlights can add items without first opening it. It keeps page groups, checkboxes, editing, reordering, location pointers, quoting, and the Drafter/Claude Code handoffs. Legacy list records are untouched.
- The new-tab button follows the tab strip. Pointer-driven tab dragging moves the tab and shifts siblings before committing order on release, without text selection.
- Arrange Pages uses themed tile pickers, numbered tab/header badges, hover highlighting, header swaps, tab-to-tile drops, and previews of actual assignments. Mosaics and mission pins remain available.
- Selecting an element opens page chat with the capture already attached. Picking has a cancel hint, unsupported-page errors, a delivery timeout, and visible backend rejection handling.
- The separate Linked agent, branching/second-conversation machinery, Focus mode, Tandem controls/prompts, obsolete native menus, and legacy browser view mode were removed. Linked's skill is retired, its seat is removed, and the generated API reference reflects the deleted endpoint.

## Verification

| Check | Result |
|---|---|
| TypeScript | `npx tsc --noEmit` passed |
| Frontend suite | 206 files, 2,201 tests passed |
| Dock/boot boundary follow-up | 66 tests passed after the final import adjustment |
| Rust workspace suite | 1,398 passed, 15 ignored, zero failed |
| Rust lint | `cargo +1.98.1 clippy` passed with warnings |
| Production frontend | Built successfully |
| Packaged macOS app | `npm run tauri build -- --bundles app` passed; helper and release identity included |
| Signature | Local `Redline Dev` signature passed `codesign --verify --strict --deep` |
| Native boot probe | Passed: disposable database, daemon, frontend IPC, representative reads, clean exit |
| Size budgets | `node scripts/check-size.mjs --strict` passed on fresh artifacts |
| Visual fixture | 118 checks, 34 screenshots, zero errors |
| Whitespace | `git diff --check` passed |

The [visual results](browser-simplification-visual-qa-2026-09-25/results.json) include real Chrome pointer input for tab motion, commit-on-release, tile swaps, tab-to-tile assignment, and cross-highlighting. They also exercise menus, layout previews, resizing, bounded chat scrolling, light/dark themes, and Mosaics.

The inspector failure was reproduced before editing in a DOM fixture: clicking without a preceding pointer move produced no signal and left picking active. A missing transport was also silent. Regression tests cover both, immediate chat seeding, page ownership, cancellation, and timeout errors.

## Size comparison

Built the saved pre-change frontend source separately with the same Vite configuration and dependencies, then compared uncompressed artifacts:

| Artifact | Before | After | Change |
|---|---:|---:|---:|
| Boot JavaScript | 600,673 B | 600,006 B | −667 B |
| Total frontend assets | 8,988,503 B | 8,969,573 B | −18,930 B |

The empty dock descriptor now lives with the app's dock mapping, keeping browser-only state helpers out of the boot import path. Size ceilings were not changed.

The fresh release executable is **38,215,248 B / 38,500,000 B**; the separately built activation helper is **546,112 B / 800,000 B**. The signed executable inside the package is 38,234,336 B. Exact [artifact measurements](browser-simplification-visual-qa-2026-09-25/sizes.json) distinguish the build outputs from the signed package.

The prepared app is at [`src-tauri/target/release/bundle/macos/Redline.app`](../src-tauri/target/release/bundle/macos/Redline.app), release identity `rel-1790403456-f96e167`. Its [isolated native probe](browser-simplification-visual-qa-2026-09-25/native-probe.json) reached frontend interaction in 2,367 ms and exited successfully after checking storage and settings. It was not installed.

## Verification limits

The visual run uses real React components and theme CSS with synthetic page images and mocked Tauri/agent services. It does not verify WKWebView hit testing or live agent responses. No development app was running for the requested pre-change native reproduction; the full interactive native browser walkthrough remains unverified. No production installation or user database was changed.
