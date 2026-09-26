# Browser refresh: component visual QA

The isolated headless Chrome run passed **102 checks with zero browser errors**, producing 33 screenshots at 1200×800, 900×640 and 1600×900. The tested source hashes and exact element bounds are in [results.json](browser-refresh-visual-qa-2026-09-13/results.json). No production files were changed by this QA task.

The fixture imports the actual `BrowserChrome`, `BrowserPopover`, `BrowserDialog`, `BrowserLayoutDialog`, `BrowserBookmarksDialog`, `BrowserTileStage`, `PersistentPortalSlot`, `ChatRoom`, `BrowserChat` and `BrowserThreadPicker` components, production styles and `applyTheme`. Agent history, audio/dictation hooks and Tauri transport are synthetic. Forty messages, a long streaming reply, and twelve-line drafts exercise the real chat rendering. Native pages are explicitly labeled synthetic local SVG images.

| Viewport | Carried-chat composer bottom | Browser-chat composer bottom | Long dialog bounds | Outcome |
|---|---:|---:|---|---|
| 1200×800 | 789 px | 789 px | y=48–752 px | Contained |
| 900×640 | 629 px | 629 px | y=48–592 px | Contained |
| 1600×900 | 889 px | 889 px | y=48–852 px | Contained |

All three sizes kept messages in their own scrolling area, the composer visible, and document scroll dimensions equal to the viewport. Menus and dialogs stayed inside the window. Menu navigation wrapped correctly; Escape restored the menu trigger; dialog Tab and Shift-Tab wrapped within the dialog. Bookmarks and deliberately long dialog content scrolled while their footer remained visible.

The final fixture supplies the integrated conversation prop shape: the real thread picker, New/Branch actions, follow/pin, an existing linked conversation, second-conversation toggle, Page notes and Research. At 900×640 the complete settings dialog fits with all controls reachable through real CDP Tab navigation; its body remains scroll-capable and its footer visible. The 31-entry conversation picker scrolls within the viewport and focuses its search input. These callbacks are synthetic and do not create threads, launch research or call a backend.

Switching from browser to an unrelated surface detached the portal host. Moving into the full chat room and back preserved the exact textarea DOM node and its unsent draft. Real CDP pointer dragging changed tile column ratios to 65%. Live resizing from 1600 to 900 pixels projected four pages down to one without altering the saved arrangement; expanding restored all four. An open page menu repositioned within the smaller viewport.

Representative screenshots, visually inspected after the automated checks:

- [900×640 workspace and carried chat](browser-refresh-visual-qa-2026-09-13/900x640-workspace-chat.png)
- [900×640 Arrange pages](browser-refresh-visual-qa-2026-09-13/900x640-arrange-pages.png)
- [900×640 long scrolling dialog](browser-refresh-visual-qa-2026-09-13/900x640-long-dialog.png)
- [900×640 conversation menu](browser-refresh-visual-qa-2026-09-13/900x640-conversation-actions.png)
- [900×640 scrolling conversation picker](browser-refresh-visual-qa-2026-09-13/900x640-conversation-picker.png)
- [900×640 full conversation settings](browser-refresh-visual-qa-2026-09-13/900x640-conversation-settings.png)
- [900×640 menu after live resizing](browser-refresh-visual-qa-2026-09-13/900x640-live-resize-menu.png)
- [1600×900 four pages and browser chat](browser-refresh-visual-qa-2026-09-13/1600x900-page-conversation.png)
- [1600×900 light theme and resized columns](browser-refresh-visual-qa-2026-09-13/1600x900-light-theme.png)

The default screenshot theme is Studio; the light screenshot uses Basic. Chrome's native textarea/dialog scrollbars appear light against Studio because the fixture uses the production styles without adding a `color-scheme` override. This is recorded as a Chrome rendering observation, not a verified WKWebView issue.

Reproduce from the repository root:

```sh
node scripts/browser-visual-qa.mjs
```

An optional first argument changes the artifact directory. The script starts a loopback-only Vite server and `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` with a new temporary profile. It drives Chrome using Node's native WebSocket CDP support, writes screenshots and structured results, stops its own processes and removes its temporary profile/cache. No Playwright or Puppeteer installation is needed. The measured run used Chrome 152.0.7977.83.

This verifies component layout and browser DOM interaction, not the complete `BrowserPane` controller, native WKWebView z-order, screenshot-cover timing, native focus/keyboard input, agent actions or the running Redline app. The fixture never opens the user's Chrome profile, launches Redline, changes capture settings or accesses the application database. Native Computer Use remained unavailable, so these screenshots do not replace the pending native walkthrough or establish UI latency.
