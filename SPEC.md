# Redline — Specification

**Status:** v0.1 (as-built)
**Author:** Yusuf Al-Bazian
**License:** Apache-2.0 (code) + trademark reserved; CLA-gated contributions.

A Tauri 2 desktop companion for Claude Code that intercepts plan-mode tool calls,
holds the agent's terminal, and surfaces the plan in a Word-style track-changes
editor alongside an embedded shell — so a reviewer can mark up the plan inline
and round-trip structured feedback (or questions) back into the same Claude Code
session.

This document describes Redline *as it is built today*, not as it was originally
scoped. For the historical pre-build design, see git history.

---

## 1. What Redline is

A reviewer fires up `claude` inside Redline's embedded terminal. When the agent
calls `ExitPlanMode`, a `PreToolUse` HTTP hook POSTs the plan to a local daemon
running inside the same app. The daemon parses the plan, stably ID's every
section and paragraph, persists the session, and surfaces a Tiptap document with
a comment margin. The reviewer can:

- **Approve** — releases the hook with `allow`. Claude proceeds.
- **Continue revising** — releases the hook with `deny` plus a structured
  feedback payload assembled from the reviewer's comments. Claude returns a v(n+1)
  plan with a `<!-- REDLINE_RESOLUTIONS … -->` block at the top, which the daemon
  strips, parses, and attaches to the v(n) comments.
- **Ask Claude** — questions-only submission. The daemon expects an unchanged
  plan back; if the plan body matches the prior revision the round-trip is
  classified as an "Ask" and resolutions attach to the *current* revision with
  no version bump. If Claude edits the plan anyway, the UI surfaces an
  `ask_mode_violated` warning and proceeds as a normal revise.

The app also runs a real PTY-backed shell (one per tab) so the reviewer never
leaves Redline to drive the agent. Sessions, revisions, and comments persist in
SQLite across restarts.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Redline (Tauri 2 desktop app)                                       │
│                                                                       │
│  ┌──────────────────────────────┐    ┌─────────────────────────────┐ │
│  │  React frontend (Vite)        │    │  Rust backend               │ │
│  │  • Tiptap editor + redline    │    │  • axum on 127.0.0.1:7676   │ │
│  │  • xterm.js terminal tabs     │◀──▶│  • portable-pty shells      │ │
│  │  • Comment composer/margin    │    │  • SessionStore + SQLite    │ │
│  │  • Mode toggle, theme picker  │    │  • Plan parser (pulldown)   │ │
│  │  • Hook setup modal           │    │  • Tray + interception mode │ │
│  └──────────────────────────────┘    └────────────▲────────────────┘ │
│         ▲ Tauri commands / events                  │                  │
└─────────┼──────────────────────────────────────────┼──────────────────┘
          │                                          │ HTTP POST
          │                                          │ /v1/plan
          │                                          │ (held open)
          │                              ┌───────────┴───────────────┐
          │                              │  Claude Code               │
          │                              │  (running in Redline's     │
          │                              │   embedded PTY, or any     │
          │                              │   other surface on this    │
          └─────────────────────────────▶│   machine)                 │
                                         └────────────────────────────┘
```

### 2.1 Components

| Component | Lives in | Role |
|---|---|---|
| Tauri shell | `src-tauri/src/main.rs`, `lib.rs` | App lifecycle, tray, command/event wiring |
| HTTP daemon | `src-tauri/src/hook.rs` | Receives plans on `:7676`, holds POSTs, returns allow/deny |
| Plan parser | `src-tauri/src/parser.rs` | Markdown → section/paragraph tree; anchor + block-ID assignment |
| Session store | `src-tauri/src/state.rs` + `db.rs` | In-memory + SQLite persistence |
| Feedback serializer | `src-tauri/src/feedback.rs` | Comments → `permissionDecisionReason` markdown |
| Resolution parser | `src-tauri/src/resolutions.rs` | `<!-- REDLINE_RESOLUTIONS … -->` → `{comment_id: text}` |
| PTY backend | `src-tauri/src/pty.rs` | Spawn/read/write shells via `portable-pty` |
| Editor | `src/editor/` (Tiptap) | Plan rendering, comment marks, track changes |
| Terminal UI | `src/components/Terminal*.tsx` (xterm.js) | Embedded shell tabs |
| Review surface | `src/App.tsx`, `src/components/*` | Sidebar, composer, comment margin, banners, footer |

### 2.2 Why Tauri 2

Tauri is what shipped. Rationale: small bundle, native tray, rusqlite-friendly
backend, and a clean home for the axum HTTP server inside the same process as
the UI (no separate daemon to manage).

---

## 3. The wire protocol

### 3.1 Plan submission (Claude Code → Redline)

A `PreToolUse` hook on `ExitPlanMode`, installed at
`~/.claude/settings.json`, POSTs the standard Claude Code hook event:

```http
POST /v1/plan HTTP/1.1
Host: 127.0.0.1:7676
Content-Type: application/json

{
  "hook_event_name": "PreToolUse",
  "session_id": "d8111931-…",
  "tool_use_id": "toolu_…",
  "transcript_path": "/Users/…/<session>.jsonl",
  "cwd": "/Users/…/some-project",
  "permission_mode": "plan",
  "tool_name": "ExitPlanMode",
  "tool_input": {
    "plan": "# Refactor authentication…\n\n## A. Current state\n…",
    "planFilePath": "/Users/…/plan.md"
  }
}
```

The daemon:

1. Strips any leading `<!-- REDLINE_RESOLUTIONS … -->` block from `tool_input.plan`.
2. Parses the remaining markdown into a section tree with stable block IDs.
3. Routes by `session_id`:
   - **New session** → create `ReviewSession`, store as v1, set `thread_start = true`.
   - **Existing session, plan body changed** → store as v(n+1), classify as either
     fresh-plan (`thread_start = true`) or a feedback revision attaching to v(n).
   - **Existing session, plan body unchanged AND expected mode was Ask** → no
     version bump; attach resolutions to the current revision.
4. Emits `plan-received` to the frontend.
5. Routes the held POST per interception mode (§4).

### 3.2 Allow response

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Reviewer approved via Redline."
  }
}
```

### 3.3 Deny response (revise or ask)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "<feedback markdown — see §5>"
  }
}
```

### 3.4 Resolution block (Claude → Redline, on the next plan)

Prepended (or located anywhere) in the v(n+1) plan markdown:

```html
<!-- REDLINE_RESOLUTIONS
{
  "c-001": "Addressed in v2. §B.2 rewritten as specified.",
  "c-002": "Restructured §C to migrate auth first.",
  "c-003": "Not a plan change — reasoning provided inline in §D.2."
}
-->
```

The parser (`resolutions.rs`) is tolerant: it accepts fence-case variations,
trailing commas, non-string JSON values (coerced to strings), and any position
in the document. Unknown keys are surfaced as `unmatched`, missing keys as
`missing`; both flow into a `ResolutionWarningBanner` in the UI.

### 3.5 Versioning

The path is `/v1/plan`. Future protocol breaks bump the path. Unknown top-level
keys in the hook payload and unknown keys in the resolution block are ignored.

---

## 4. Interception modes

Set by the user from the header `ModeToggle` or the tray menu; persisted in
`app_settings` (SQLite). Killing a mode releases any currently-held POSTs.

| Mode | Behavior |
|---|---|
| **Active** (default) | Every plan blocks until the reviewer explicitly approves or submits. The POST is held open. |
| **Ambient** | Plan is captured and surfaced; a `DecisionWindowBanner` counts down 20 s. If the reviewer doesn't claim it via `claim_review`, the daemon auto-approves. If they do, it behaves like Active for that session. |
| **Paused** | Killswitch. Plans are auto-approved immediately; nothing is captured. |

Mode transitions broadcast a `mode-changed` event and sync the tray's radio
group. Switching out of Active mid-review releases every held POST with an
`allow` and a "Superseded — Redline interception mode changed" reason.

---

## 5. The feedback model

Comments are session-scoped (`c-001`, `c-002`, …) and live on a specific
revision. Each comment carries:

- `type` — `edit | feedback | question | block-insert | block-delete | block-move`
- `scope` — only on `feedback`: `local | structural`
- `anchor_id` — positional anchor (e.g. `B.2`, `B.2.p1`)
- `block_id` — stable, sidecar-backed ID (e.g. `blk-7f2a…`) for cross-revision joining
- `body` — reviewer prose
- `edit?` — `{ original, revised }` for `edit` type
- `status` — `draft | submitted | resolved | accepted | reopened | withdrawn`
- `resolution?` — `{ body, appeared_in_version, accepted_at }`

### 5.1 Submission modes

`submit_review` infers the submission mode from the pending comments
(`SubmissionMode::infer`):

- **Revise** — any `edit`, `feedback`, or block-structural comment present.
- **Ask** — only `question`s.

Mode determines which feedback template is used (`feedback::serialize_payload`):

- **Revise payload** — preface ("The user reviewed your plan in Redline and has
  requested revisions."), plan anchors for reference, edits/feedback sorted by
  anchor, optional structural changes block, then mandatory
  `REDLINE_RESOLUTIONS` instructions.
- **Ask payload** — same preface, plan anchors, questions only, response
  instructions that explicitly forbid plan changes and require a
  `REDLINE_RESOLUTIONS` block answering each question.

After a submission, the daemon records `ExpectedModes[session_id] = mode`. The
next `handle_plan` consumes it to classify the response.

### 5.2 Ask round-trip detection

`plan_text_signature()` walks the section tree concatenating heading levels +
titles + paragraph plain text. If the next plan's signature equals the prior
revision's and the expected mode was Ask:

- No new revision is created.
- The resolution block is parsed and attached to the current revision's
  questions.
- Status flips to `resolved` for each answered question.

If the expected mode was Ask but the body changed, the daemon proceeds as
Revise but emits `ask_mode_violated` in the `plan-received` event so the
`AskModeViolationBanner` can warn the reviewer.

### 5.3 Comment lifecycle

```
draft ─► submitted ─► resolved ─► accepted
                         │
                         └─► reopened (re-submitted on next round)
draft ─► withdrawn (deleted before submission round)
```

Resolutions are never auto-accepted. The reviewer must mark each one
`accepted` (or `reopen` it).

### 5.4 Resolution parse warnings

The frontend renders a `ResolutionWarningBanner` whenever the daemon reports any
of:

- `parse_error` — the block existed but JSON failed to decode.
- `unmatched_ids` — Claude returned resolutions for IDs the daemon doesn't know.
- `missing_ids` — submitted comments had no entry in the block.
- `missing_block` — block absent entirely (only on revise submissions, which
  require it).

---

## 6. Data model

### 6.1 Stable anchors and block IDs

Two parallel identifiers per parsed block:

- **Anchor** — positional, derived from heading hierarchy + paragraph index.
  Format: `A`, `A.1`, `A.1.p1`. Recomputed every parse; may shift between
  revisions if structure changes.
- **Block ID** — stable, opaque (`blk-` + hex). Embedded into the markdown as
  an HTML comment sidecar (`<!-- rl:blk-… -->`) when persisted. Survives parse
  cycles and is the join key for cross-revision diffs and comment attachment.

When a plan first arrives, the parser assigns fresh block IDs to every node
without one, then writes the IDs back into `raw_plan_markdown` as sidecars so
subsequent reparses recover them. Sidecar maintenance lives in
`src/editor/markdown/sidecar.ts` (frontend serializer) and the Rust parser.

### 6.2 Persistence (SQLite)

Database file: `<app_data_dir>/redline.db`.

```
sessions(session_id PK, project_path, project_name, created_at, status)
revisions(session_id, version_number, received_at, raw_plan_markdown,
          PRIMARY KEY (session_id, version_number))
comments(id, session_id, version_number, type, scope, anchor_id, body,
         edit_original, edit_revised, created_at, status,
         resolution_body, resolution_version, resolution_accepted_at,
         PRIMARY KEY (session_id, id))
app_settings(key PK, value)
```

`migrate()` is idempotent and includes one corrective migration: legacy
databases declared `comments.id` as the sole primary key (globally unique),
which broke as soon as a second session tried to allocate `c-001`. The
migration rebuilds the table with `PRIMARY KEY (session_id, id)`.

Plan markdown is stored verbatim (with sidecar IDs). Section trees are reparsed
on read.

### 6.3 In-memory state

- `SessionStore` — sessions + revisions + comments cache backed by SQLite.
- `PendingResponses` — `session_id → tokio::oneshot::Sender<HookResponse>`. One
  entry per held POST.
- `ExpectedModes` — `session_id → SubmissionMode` set on submit, consumed on
  next `handle_plan`.
- `ClaimFlags` — `session_id → bool` for Ambient-mode "claimed for full review".
- `Settings` — current `InterceptionMode`, persisted via `app_settings`.
- `PtyState` — `tab_id → PtyChild + reader handle`.

---

## 7. Tauri command/event surface

### 7.1 Commands (frontend → backend)

| Command | Purpose |
|---|---|
| `list_sessions` | All sessions (with `held` flag computed from `PendingResponses`) |
| `get_session(id)` | Full session detail |
| `delete_session(id)` | Rejected while a POST is held; otherwise drops the session |
| `add_comment(session_id, request)` | Create comment |
| `update_comment(session_id, comment_id, update)` | Edit comment in place |
| `delete_comment(session_id, comment_id)` | Drop comment |
| `submit_review(session_id)` | Build payload from drafts/reopens, release POST with `deny` |
| `approve_plan(session_id)` | Release POST with `allow`, mark session approved |
| `accept_resolution(session_id, comment_id)` | Mark resolution accepted |
| `reopen_resolution(session_id, comment_id)` | Send the resolution back next round |
| `get_interception_mode` / `set_interception_mode` | Read / write current mode |
| `claim_review(session_id)` | Ambient-mode "I want the full review window" |
| `get_hook_status` / `install_hook` | Inspect/install `~/.claude/settings.json` entry |
| `pty_spawn / pty_write / pty_resize / pty_kill / pty_kill_all / pty_cwd` | Embedded terminal lifecycle |

### 7.2 Events (backend → frontend)

| Event | Payload |
|---|---|
| `plan-received` | `{ session_id, version, ask_mode_violated, resolution_warnings }` |
| `plan-decision-window` | `{ session_id, expires_at }` (Ambient mode) |
| `session-status-changed` | `{ session_id }` |
| `comments-changed` | `{ session_id }` |
| `mode-changed` | `{ mode }` |
| `pty-output` | `{ tab_id, base64_bytes }` |
| `pty-exit` | `{ tab_id, code }` |

---

## 8. The editor

ProseMirror via Tiptap (`@tiptap/react`, `@tiptap/starter-kit`, table extensions).
Owns the plan rendering, comment composition, and track-changes display.

### 8.1 Schema and extensions

- `src/editor/markdown/schema.ts` — ProseMirror schema with `blockId` and
  `anchorId` attributes on every block node.
- `src/editor/markdown/parser.ts` / `serializer.ts` — markdown ↔ doc, preserving
  sidecar IDs across the round trip (`markdown/roundtrip.test.ts`).
- `src/editor/extensions/BlockIdAttribute.ts`,
  `AnchorIdAttribute.ts` — node-attribute extensions that surface stable IDs to
  the editor.
- `src/editor/extensions/TrackChanges.ts` — `rl_ins` / `rl_del` marks for
  word-level inserts/deletes (green / struck red).
- `src/editor/extensions/TrackChangesInput.ts` — input rules feeding the
  `changeLedger` from user edits.
- `src/editor/extensions/RedlineDecorations.ts` — per-block decorations for
  revision diff status (`added | removed | modified | unchanged`).
- `src/editor/extensions/planExtensions.ts` — aggregates the above.

### 8.2 Track-changes pipeline

- `wordDiff.ts` — word-level diff (whitespace-split) for `edit` comments.
- `changeLedger.ts` — accumulator of `{ blockId, original, revised }` overrides.
- `applyCommentsToDoc.ts` — applies the ledger and structural comments onto the
  live doc.
- `useTrackChangesSync.ts` — React hook that keeps the editor and the comment
  store in lockstep.
- `docModel.ts` — `redlineStatusByBlockId`, `anchorByBlockId`,
  `revisionEditByBlockId` — projects revision diffs onto stable block IDs so the
  editor paints redline marks across versions.

### 8.3 Diff between revisions

`src/diff.ts` computes a `Map<AnchorId, ParagraphDiff>` between two revisions
using rendered plain text per block. Used by `RedlineDecorations` to colour
added / removed / modified / unchanged blocks.

---

## 9. The UI

Window default: 1100×800, resizable. Three primary regions stacked vertically:
**top** (header), **middle** (sidebar | editor + comment margin | terminal),
**bottom** (footer).

### 9.1 Components (`src/components/`)

| Component | Role |
|---|---|
| `Header` | App title, `ThemePicker`, `ModeToggle`, hook-setup button |
| `SessionSidebar` | Sessions list with project name, last-updated, pending counts, delete button (hidden while a POST is held) |
| `PlanEditor` (lazy) | Tiptap editor with redline marks, anchor pills, selection menu |
| `SelectionMenu` | Floating action menu on text selection: pick type + scope |
| `CommentComposer` | Inline form for the active comment in composition |
| `CommentCard` | Rendered comment with edit/structural payload, resolution UI |
| `AnchorPill` | Small monospace anchor chip (`§B.2.p1`) |
| `Footer` | Comment tally, **Continue revising** / **Ask Claude** / **Approve plan** buttons, collapsed-terminal peek |
| `DecisionWindowBanner` | Ambient countdown ("auto-approving in 18 s") with Open / Approve actions |
| `AskModeViolationBanner` | "Claude modified the plan during an Ask; proceeding as revise" |
| `ResolutionWarningBanner` | Unmatched / missing / parse-error warnings on resolution blocks |
| `ApproveToast` | Brief confirmation after `approve_plan` |
| `HookSetupModal` | Walks the user through installing the `~/.claude/settings.json` hook entry |
| `TerminalView` | Single xterm.js bound to one PTY, base64 decoder, Fit addon, theme sync |
| `TerminalTabs` / `TerminalTabBar` | Tab management: spawn, close, unseen-activity dot |
| `PaneDivider` | Draggable divider for sidebar / comment-pane / terminal heights |
| `ThemePicker` | Theme selector dropdown |
| `ModeToggle` | Segmented control: Active / Ambient / Paused |

### 9.2 Composing a comment

1. Reviewer selects text inside the editor. `useTextSelection` opens
   `SelectionMenu` at the cursor.
2. Reviewer picks `Edit`, `Feedback`, `Question`, or one of the block-structural
   options. For `Feedback`, a scope toggle picks `local` vs `structural`.
3. `CommentComposer` appears in the right margin, pre-anchored. Edits get
   `original` (pre-filled) and `revised` text areas; other types get a single
   body field.
4. ⌘+Enter (or the Save button) adds the comment as `draft` and emits
   `comments-changed`. Track-changes marks paint immediately for `edit` /
   block-structural comments via the `changeLedger`.

### 9.3 Submitting

Footer shows the comment tally. **Continue revising** is shown when at least
one non-question comment exists; **Ask Claude** when only questions are
pending. Either button triggers `submit_review`, which:

1. Pulls drafts + reopened comments.
2. Infers the mode.
3. Builds the payload via `feedback::serialize_payload`.
4. Marks the comments `submitted`.
5. Releases the held POST with `deny` + payload.
6. Stores the expected mode for the next `handle_plan`.

**Approve plan** calls `approve_plan`, which releases the POST with `allow`,
marks the session `Approved`, and surfaces `ApproveToast`.

---

## 10. The embedded terminal

`pty.rs` + `src/components/Terminal*.tsx` + xterm.js.

- One PTY per tab, spawned with `portable-pty`. Shell selection:
  `$SHELL` → fallback `/bin/zsh`. `TERM=xterm-256color`.
- New tabs inherit the cwd of the most recently active PTY child via
  `pty_cwd`, so opening a tab while Claude is `cd`'d into a project lands the
  new shell in the same directory.
- PTY output is base64-encoded and emitted as `pty-output`; xterm.js decodes
  and writes.
- Closing a tab kills the shell; quitting the app calls `pty_kill_all`.
- The terminal is the intended home for `claude` itself, which is why
  session-delete is blocked while a POST is held — deleting the session while
  Claude is mid-tool-call would orphan the terminal.

The terminal collapses into a peek strip in the footer when not needed; the
divider between editor and terminal is draggable.

---

## 11. Hook installation

`HookSetupModal` triggers `install_hook`, which writes to
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          { "type": "http", "url": "http://127.0.0.1:7676/v1/plan", "timeout": 600 }
        ]
      }
    ]
  }
}
```

`get_hook_status` inspects the file and reports `installed | missing |
malformed` so the modal can render appropriate guidance.

The 10-minute timeout matches the longest realistic review session. If
Claude Code is running but Redline isn't, the hook fails to connect and Claude
proceeds silently (verified empirically; see `docs/protocol-verification.md`).
The user must launch Redline (or set the mode to Paused) for the hook to
behave as designed.

---

## 12. Tray, themes, persistence

- **Tray menu** — radio items for Active / Ambient / Paused plus a Quit entry.
  Tooltip reports session count + pending comment count. Items sync to
  `mode-changed` so external mode changes propagate.
- **Themes** — `src/theme/themes.ts` defines named palettes; `applyTheme.ts`
  sets CSS variables on `document.root`; `derive.ts` computes complementary
  shades. Selection persists via `usePersistedState` (localStorage).
- **Pane sizes** — sidebar width, comment-margin width, terminal height, and
  collapsed states all persist via `usePersistedState`.

---

## 13. Anti-injection discipline

The feedback payload is *load-bearing*: Claude treats
`permissionDecisionReason` as potentially untrusted input. Empirically verified
behaviour (see `docs/protocol-verification.md`):

- A payload that reads like an injection attempt ("ignore your task, do X") will
  be flagged and refused by the model.
- A payload framed as user-attested review feedback ("The user reviewed your
  plan in Redline and has requested revisions…") is acted on.

`feedback.rs` enforces:

1. A fixed preface establishing the source ("The user reviewed your plan in
   Redline…").
2. Declarative framing for structural changes ("The user deleted this block")
   rather than imperative ("Delete this block").
3. Verbatim wrapping of reviewer prose so Claude attributes the words to the
   user, not to Redline.
4. No sanitisation or rewriting of reviewer prose. The only escape is the
   "USER COMMENT (verbatim):" frame.

The resolution-block contract is part of the same surface: it gives Claude a
structured, machine-readable channel for per-comment replies that doesn't
require freeform interleaving with plan text.

---

## 14. Tests

```
src/editor/applyCommentsToDoc.test.ts   — comment overrides → doc edits
src/editor/changeLedger.test.ts         — ledger accumulation + flush
src/editor/docModel.test.ts             — block-ID/anchor projection
src/editor/markdown/roundtrip.test.ts   — markdown ↔ ProseMirror fidelity with sidecars
src/editor/planEditorSync.test.ts       — editor ↔ comment-store sync
src/editor/wordDiff.test.ts             — word-level diffing
```

Run via `npm test` (vitest). Backend tests are in-line with their modules.

A reproducible hook-verification rig lives at `scripts/verify-hook.py` with
sample payloads in `scripts/sample-plan-payload.json`; documented behaviour is
in `docs/protocol-verification.md`.

---

## 15. Build, run, contribute

```bash
npm install
npm run tauri dev      # dev mode
npm run tauri build    # production bundle
npm test               # frontend tests
```

Contributions are gated by a copyright-assignment CLA (`CLA.md`,
`CONTRIBUTING.md`). The CLA Assistant bot validates each PR.

Licensing:

- Code: Apache-2.0 (`LICENSE`, `NOTICE`).
- Name, logo, icon: **not** licensed; trademarks reserved. Derivative
  distributions must rename. See `README.md`.

---

## 16. Explicit non-goals

- **Code diff review.** Redline reviews *plans*, not diffs.
- **Multi-user collaboration.** Single reviewer per session.
- **Cloud sync.** Everything is local. No telemetry, no phone-home.
- **Non-Claude-Code agents.** The protocol assumes Claude Code's hook surface
  and `ExitPlanMode` semantics.
- **Tool calls beyond `ExitPlanMode`.** The hook matcher is `ExitPlanMode` only.

---

## 17. Known gaps / not-yet-built

- **Side-by-side revision diff view.** Diff is implicit in the editor's redline
  marks; there is no v1↔v2 split pane.
- **Comment threading.** Comments are flat — no replies, no nested discussion.
- **Search / filter on comments.** No way to find a comment by keyword or type.
- **Reject-and-redirect gesture.** No first-class "scrap this plan and start
  over" action; reviewers approximate with a feedback comment.
- **Edit-only fast path.** Pure-edit submissions still go through the full
  resolution round-trip.
- **Desktop notifications.** Tauri's notification plugin is not wired up.
- **Daemon auto-start.** No login-item / `launchd` integration; the user must
  launch Redline manually (or leave it tray-resident).
- **Export.** No PDF / DOCX / HTML export of the plan + comments.
- **Custom anchoring.** Anchors are auto-generated; no UI override.

These are tracked informally and may move into v0.2.
