# Document preview

[Back to Redline](../../../README.md) · [View the mockup](redline-workspace.html) · [Full-size PNG](document.png)

The README uses **one Document mockup**, rendered from Redline's current React components in the **Terminal theme with San Francisco text**. The session, comments, agent responses, and terminal output are sample content. This is a component preview, not a capture of a live agent session.

The image shows:

- Sessions on the left, with the intercepted plan selected and its revision history expanded.
- The plan in the document editor.
- The discussion sidecar with **Action items**, an agent resolution, **Accept / Reopen**, and a follow-up thread.
- The open terminal drawer with a short `/updated plan` exchange and the app's red **“plan intercepted by redline”** strip.

## How it is rendered

The fixture mounts [App.tsx](../../../src/App.tsx), including the real Header, SessionSidebar, PlanEditor, CommentCard, CommentThread, TerminalTabs, and TerminalView. It imports [styles.css](../../../src/styles.css) and applies the Terminal theme and San Francisco font using [applyTheme.ts](../../../src/theme/applyTheme.ts). The terminal is rendered by the app's xterm component. The red intercept strip comes directly from [TerminalTabs.tsx](../../../src/components/TerminalTabs.tsx).

Only the native service boundary is replaced: [source/native.ts](source/native.ts) returns sample sessions and discussion history, feeds static output into the terminal channel, and emits a sample plan-interception event. It does not connect to the Redline daemon, execute commands, or launch an agent. [source/data.ts](source/data.ts) contains the example plan and comments. No application component styles are overridden.

## Preview locally

From the repository root, after `npm ci`:

```bash
node docs/assets/readme/source/serve.mjs
```

Open `http://127.0.0.1:8848/`. Allow the sample intercepted plan to arrive; the discussion and terminal drawers open with it. This fixture uses a dedicated local origin and resets its own `redline.*` browser preferences on reload. It covers the Document view only; other surface controls are not part of this mockup.

Capture that view as `document.png` to update the README image. The checked-in PNG is 1375 × 993. Open [redline-workspace.html](redline-workspace.html) for the fixed image preview without starting a server.

To rebuild the GitHub-style README layout preview:

```bash
node docs/assets/readme/render-preview.mjs
```
