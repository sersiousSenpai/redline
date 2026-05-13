# Redline v0.2 — "AI edits as tracked redlines"

## Context

After shipping M0–M5 (plan-review companion app: hook → daemon → review surface → revision loop), the lived-with version revealed that the *plan-review* framing was too narrow. The right product is broader and has a sharper anchor:

**A Cursor-style IDE for people who want a lawyer-style review workflow: every AI-proposed edit appears as a tracked-change redline that must be explicitly accepted or rejected before it touches the file.**

This inverts Cursor's default (apply, undo if wrong) into a model that matches how lawyers mark up documents (propose, accept-or-reject, then clean). Same loop, applied to code + markdown + plans.

What this gives us that doesn't exist today:
- vs. Cursor: edits are proposals, never silent
- vs. Warp: editor-first, not terminal-first
- vs. VS Code with Copilot: review-first workflow, not edit-first
- vs. Word: handles code, terminals, project structure

The user's daily flow becomes: open a project folder → talk to Claude (via embedded terminal initially) → Claude's `Edit`/`Write`/`MultiEdit`/`ExitPlanMode` tool calls all surface as redlines in Redline → accept / reject / comment-and-redirect → loop until clean. Plan review (the original M0–M5 use case) is a special case where the "file" is the plan markdown.

## Decision summary (from user answers during the pivot session)

1. **Anchor**: Cursor-shaped IDE with a lawyer's workflow — track-changes first.
2. **Scope of editor**: any file in the project (code + markdown), with different surfaces per file type.
3. **AI wiring**: extend the M0 hook pattern. Intercept `Edit` / `Write` / `MultiEdit` / `ExitPlanMode`. User runs `claude` in an embedded terminal (or external, both work). Native API chat is deferred to a later phase.
4. **M0–M5 work**: TBD — let the new design force the answer. The plan below identifies what's directly reusable and what gets restructured.

## What carries over from M0–M5 (reuse map)

Reusable as-is or with small tweaks:

- `src-tauri/src/lib.rs` — the `AppState` / `PendingResponses` / `handle_plan` pattern is exactly what's needed for every tool intercept. Extend the matcher list from `["ExitPlanMode"]` to `["ExitPlanMode", "Edit", "Write", "MultiEdit"]` and dispatch by tool name.
- `src-tauri/src/state.rs` — `SessionStore`, oneshot-blocking pattern, `Comment` lifecycle (draft → submitted → resolved → accepted / reopened) all map to file-edit proposals with renaming.
- `src-tauri/src/db.rs` — schema is forward-additive via `ALTER TABLE`. Add a `file_edit_proposals` table; sessions/revisions/comments tables stay.
- `src-tauri/src/hook.rs` — installer extends the `PreToolUse` matcher list to include `Edit`/`Write`/`MultiEdit`.
- `src-tauri/src/parser.rs` — pulldown-cmark walker stays the primary engine for markdown files.
- `src-tauri/src/feedback.rs` + `src-tauri/src/resolutions.rs` — still drive `ExitPlanMode` plan-review specifically (which becomes one mode of the IDE).
- `src/components/CommentCard.tsx`, `CommentComposer.tsx`, `AnchorPill.tsx` — comment primitives are reusable for file-edit comments (anchored to lines/ranges instead of section anchors).
- `src/components/SessionSidebar.tsx` — repurpose into the project/sessions sidebar; same shape, broader content.
- `src/diff.ts` — paragraph-level diff becomes one of multiple diff modes; line-level diff is needed for code.

Restructured:

- `src/App.tsx` — currently a single review window; becomes the IDE shell (file tree + tabs + editor + terminal pane + comment margin).
- `src/components/Document.tsx` — current Tiptap-style markdown renderer becomes one of several editor surfaces, used when the file being viewed is a plan/markdown.

## New architecture additions

| Concern | Choice | Why |
|---|---|---|
| Code editor | CodeMirror 6 | Modern, light, extension-friendly; established track-changes-style decorations |
| Markdown editor | Tiptap (still planned in SPEC §6.6) | Track-changes UX matches the design tokens already in `styles.css` |
| Embedded terminal | xterm.js + `tauri-plugin-shell` | Standard pairing; Tauri 2 supports sidecar shell |
| File tree / project FS | `tauri-plugin-fs` with workspace scoping | Tauri's permission model is fine for opt-in workspace reads |
| Open-folder dialog | `tauri-plugin-dialog` | Standard, used everywhere |

## New data model (Phase 1 minimum)

```rust
// New: a single AI-proposed edit to a specific file in a project.
struct FileEditProposal {
    id: ProposalId,                   // uuid
    session_id: SessionId,            // Claude Code session that proposed it
    tool_name: String,                // "Edit" | "Write" | "MultiEdit"
    tool_use_id: String,
    project_path: PathBuf,            // workspace root
    file_path: PathBuf,               // absolute path
    original_content: Option<String>, // file's current content on disk (None if Write to new file)
    proposed_content: String,         // what Claude wants to write
    diff_hunks: Vec<DiffHunk>,        // pre-computed for UI
    status: ProposalStatus,           // pending | accepted | rejected | superseded
    created_at: i64,
    decided_at: Option<i64>,
    reject_reason: Option<String>,
    comments: Vec<Comment>,           // reuse Comment model, anchored to line ranges
}

enum ProposalStatus { Pending, Accepted, Rejected, Superseded }
```

`Comment.anchor_id` extends to two shapes: section anchors (markdown / plans) and line-range anchors (`L12-15` for code).

## Phased build

**Phase 1 — Hook on Edit/Write surfaces redlines (the smallest demonstrable slice)**
- Extend `hook::install` to add matchers for `Edit`, `Write`, `MultiEdit` alongside `ExitPlanMode`.
- Extend `handle_plan` (or split into a generic `handle_tool_intercept`) to switch on `tool_name`. For Edit/Write/MultiEdit, read the existing file from disk, build a `FileEditProposal`, store it, emit `proposal-received`, block on a oneshot.
- New Tauri commands: `list_proposals`, `get_proposal`, `accept_proposal`, `reject_proposal` (with optional reject_reason).
- Accept → apply change to disk → resolve POST with `deny` + `permissionDecisionReason: "User reviewed and approved this edit in Redline. The edit has been applied to disk; continue from this state."` Claude sees the file is now in the post-edit state next time it reads it.
- Reject → resolve POST with `deny` + reject reason framed as user feedback.
- A minimal "Proposed edits" panel in the existing window: list pending proposals, click to expand → unified diff view (CodeMirror's `@codemirror/merge` view). Accept / Reject buttons.
- Existing plan-review window stays untouched but moves to the right pane.

**Phase 2 — Project folder + tabbed editor**
- `tauri-plugin-dialog` for "Open Folder"; persist the workspace root in app state.
- Left sidebar: file tree (lazy directory listing via Tauri command).
- Editor area: tabbed CodeMirror 6 panes (one tab per open file). When a proposal exists for an open file, inline redlines render via decorations; accept/reject from the gutter.
- Markdown files open in the Tiptap surface (with the same track-changes overlay model).

**Phase 3 — Embedded terminal**
- `tauri-plugin-shell` + xterm.js. One default terminal at the bottom; can split.
- Default the shell to the workspace root.
- Running `claude` inside this terminal routes its tool calls through the hook → editor surfaces the redlines.

**Phase 4 — Multi-document / multi-session orchestration**
- Sidebar grows to: Workspaces (folders open) > Sessions (claude instances) > Pending proposals.
- Reuse the existing session-summary plumbing; add a parallel `proposal-summary` shape.

**Phase 5 — Native chat panel (deferred / optional)**
- Claude API SDK directly inside Redline. Right-side chat panel as an alternative to running `claude` in the terminal. Same redline approval model; the agent loop runs in-process.

## Files to modify in Phase 1 (concrete)

- `src-tauri/Cargo.toml` — `similar` already present for line-level diff. Maybe `notify` later for filesystem watch; not needed in Phase 1.
- `src-tauri/src/lib.rs` — split `handle_plan` into `handle_tool_intercept` switching on `tool_name`. ExitPlanMode keeps its existing path; new tools route to a new `handle_file_edit_proposal` function.
- `src-tauri/src/hook.rs` — extend matcher list. Today writes a single `PreToolUse` entry with matcher `ExitPlanMode`; new version writes one entry per matched tool (or one entry with a regex matcher if Claude Code supports it — verify in Phase 1 protocol-check).
- `src-tauri/src/state.rs` — add `FileEditProposal` type, `ProposalStore`, `PendingProposals` analogous to `PendingResponses`.
- `src-tauri/src/db.rs` — add `file_edit_proposals` table.
- `src/types.ts` — TS mirror.
- `src/components/ProposalsPanel.tsx` (new) — list pending proposals.
- `src/components/ProposalDiffView.tsx` (new) — unified diff (CodeMirror merge view in a modal or side panel).
- `src/App.tsx` — add the proposals panel; gate plan-review surface behind a "this proposal is for a plan markdown" check.

## Protocol verification needed before Phase 1 build

Before writing code, confirm these hook contracts experimentally (a-la `docs/protocol-verification.md` for M0):

1. Does `PreToolUse` actually fire on `Edit`/`Write`/`MultiEdit` with the expected payload shape (`tool_input.file_path`, `tool_input.old_string`, `tool_input.new_string`, etc.)?
2. Does `deny` + a "user approved manually, file is now in state X" reason work for these tools — i.e., does Claude continue gracefully from the post-edit file state without retrying the same tool call?
3. Does `MultiEdit` deliver a single tool call with multiple edits inside, or many tool calls? (Affects whether one proposal can hold multiple file edits.)

These are 30-minute experiments analogous to M0; bake into `docs/protocol-verification-v2.md`.

## Bugs / spec gaps surfaced during M5 dogfooding

- **Orphaned held POST when Claude Code cancels the tool call upstream**: SPEC §8.4 covers window-close abandonment, but not the case where Claude Code itself drops the tool call before the reviewer acts (e.g., user rejects the tool-permission prompt). The hook's oneshot stays pending until the Redline app quits or another mechanism clears it. Fix: on a duplicate-POST detection with a *stale* prior oneshot, take the prior sender and drop it. Or: add a "Pause Redline" toggle (see below) that flushes the pending map.
- **Need a "Pause Redline" toggle in the tray**: without one, the only way to use Claude Code in another project without routing plans through Redline is to quit the whole app (which is fine but blunt). A tray-menu pause that makes the daemon return immediate-allow on every POST would be a 30-line addition.

## What gets shelved (explicitly)

- M6 ship work (bundle / signing / landing page) — moot until v0.2 vision stabilizes.
- Reject-and-redirect button (§4.5 of old SPEC).
- Edit-only fast-path (§4.6) — the new model makes every edit explicit anyway; "fast-path" is just "click Accept fast."
- Inline word-level diff — paragraph-level is fine for prose; line-level for code is the new bar.
- Multi-user / cloud sync — still no, still won't.

## Verification

Phase 1 verification:
- `cargo test` green (will need new tests for `FileEditProposal` lifecycle).
- `npm run build` green.
- Manually: in an embedded terminal (or external), run `claude` in any project, ask it to edit a file. Confirm: hook fires → proposal shows in Redline → click Accept → file changes on disk → Claude sees the new state and continues. Then ask Claude to make a bad edit, click Reject with a reason, confirm Claude redirects.

## Open questions to answer mid-build

- Editor library: CodeMirror 6 vs. Monaco. CodeMirror is lighter and easier to embed in Tauri; Monaco is VS Code's editor (richer, heavier). Recommendation: CodeMirror 6 unless a feature forces Monaco.
- Whether the Tauri shell + xterm.js path is robust enough on macOS in Tauri 2, or whether we ship without an embedded terminal in v0.2.0 and ask users to `claude` in their normal terminal next to Redline.
- Whether multi-edit `MultiEdit` should appear as one proposal with N hunks (better UX) or N proposals (simpler data model). Decide after the protocol experiment.
