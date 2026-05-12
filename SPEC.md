# Redline — Specification

**Status:** v0 — pre-build  
**Author:** Yusuf Al-Bazian (with Claude)  
**Name:** Redline

A companion app for Claude Code that turns plan-mode review into a Word-doc-style track-changes workflow with iterative commenting and structured revision.

---

## 1. Overview

### 1.1 Problem

Claude Code's plan mode produces dense, multi-section plans that are hard to review in a terminal. Substantive feedback today requires either:

- typing prose back into the terminal, which loses structural anchoring;
- exiting plan mode, editing files manually, then re-entering;
- or simply accepting plans you'd otherwise revise.

The friction scales badly with plan length and reviewer rigor. There is no current tool that lets a reviewer mark up an agent plan the way an attorney marks up a draft brief — with section-anchored comments, tracked edits, distinct gesture types (edit vs. feedback vs. question), and an iterative loop where the agent returns a revision with explicit per-comment resolutions.

### 1.2 Solution

A local desktop app that intercepts plan-mode output from any running Claude Code instance and presents it in a document-shaped review surface. The reviewer marks up the plan with three feedback primitives. On submit, the marked-up plan is serialized into a structured feedback payload that goes back to Claude Code, which produces a revised plan plus explicit per-comment resolutions. The loop repeats until the reviewer approves.

The product is surface-agnostic: it works alongside the Claude Code CLI in any terminal, Claude Code Desktop, IDE plugins, or any other surface, because it integrates via Claude Code's HTTP hook mechanism rather than wrapping the CLI.

### 1.3 Non-goals (for v1)

- Replacing Claude Code's terminal or desktop surface.
- Wrapping multiple agent CLIs (Codex, Gemini, etc.) — Claude Code only.
- Code diff review — Claude Code Desktop and Nimbalyst already do this well; we're solving plan review specifically.
- Multi-user collaboration. Single reviewer per plan.
- Cloud sync. Everything is local.
- Approving individual tool calls beyond ExitPlanMode (deferred to v2; see §11).

---

## 2. Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Multiple Claude Code instances                                │
│  (terminal, Desktop, IDE plugin, any project, any cwd)         │
└──────────────────────────┬────────────────────────────────────┘
                           │
                           │  PreToolUse hook on ExitPlanMode
                           │  Configured globally in
                           │  ~/.claude/settings.json
                           │
                           │  HTTP POST → http://127.0.0.1:7676/v1/plan
                           ▼
┌───────────────────────────────────────────────────────────────┐
│  Redline Daemon (Tauri app, tray-resident)                  │
│                                                                 │
│  • Local HTTP server (axum, port 7676)                          │
│  • Plan queue + session/cwd routing                             │
│  • Document parser (markdown → anchored section tree)           │
│  • Comment store (per session, in-memory + sqlite persistence)  │
│  • Window: review surface (React + ProseMirror)                 │
│                                                                 │
│  On submit:                                                     │
│  • Serialize comments + edits → structured feedback markdown    │
│  • Return {decision: "deny", reason: <feedback>}                │
│    or {decision: "allow"} if approved                           │
└───────────────────────────────────────────────────────────────┘
```

### 2.1 Components

| Component | Role | Lives in |
|---|---|---|
| **Hook script** | Forwards plan events to the daemon. Falls back gracefully if daemon is offline. | `~/.claude/hooks/redline-hook` (installed) |
| **Daemon HTTP server** | Receives plans, returns feedback. Single port, well-known. | Tauri Rust backend |
| **Plan store** | In-memory map of `session_id → current plan + comment thread + revision history`. SQLite for persistence across restarts. | Tauri Rust backend |
| **Review window** | React frontend rendering the document, comment margin, header, footer. | Tauri WebView |
| **Tray controller** | macOS menubar / Windows tray. Shows pending plan count; clicking opens the review window. | Tauri |

### 2.2 Why Tauri 2

- Smaller binary than Electron (~10MB vs ~150MB).
- Native tray/menubar support without extra packages.
- Rust backend handles HTTP + filesystem + sqlite cleanly.
- Matches Yusuf's existing exploration (ALIAS Terminal concept).
- Alternative: Electron + Node. Faster to prototype if Rust friction is a blocker. Tauri is preferred.

---

## 3. The Wire Protocol

### 3.1 Plan submission (Claude Code → Daemon)

Triggered by a PreToolUse hook on the `ExitPlanMode` tool. Claude Code POSTs the standard hook event JSON to the daemon. Verified payload shape (see `docs/protocol-verification.md` for raw captures):

```http
POST /v1/plan HTTP/1.1
Host: 127.0.0.1:7676
Content-Type: application/json

{
  "hook_event_name": "PreToolUse",
  "session_id": "d8111931-5e40-4df5-b066-b94aed9b5f1f",
  "tool_use_id": "toolu_...",
  "transcript_path": "/Users/yusuf/.claude/projects/-Users-yusuf-code-albazian-law-api/<session>.jsonl",
  "cwd": "/Users/yusuf/code/albazian-law-api",
  "permission_mode": "plan",
  "effort": "...",
  "tool_name": "ExitPlanMode",
  "tool_input": {
    "plan": "# Refactor authentication to JWT-based session model\n\n## A. Current state\n...",
    "planFilePath": "/Users/yusuf/.claude/.../plan.md"
  }
}
```

**Field notes:**

- `session_id` — Claude Code conversation UUID. Stable across revisions within a single conversation (load-bearing for the loop's correlation; verified empirically).
- `tool_use_id` — unique per tool call. Useful for distinguishing the v1 ExitPlanMode call from the v2 ExitPlanMode call within the same session.
- `transcript_path` — full path to the session transcript on disk. Future versions may read this to surface conversation context alongside the plan.
- `tool_input.plan` — the plan markdown, the primary content of interest.
- `tool_input.planFilePath` — Claude Code persists the plan to a local file as well. The daemon SHOULD prefer `tool_input.plan` (in-memory, current) but this path can be useful for audit/diagnostics.
- `permission_mode`, `effort` — present but not consumed by Redline.

### 3.2 Daemon response — approve

If the reviewer approves the plan:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Reviewer approved via Redline."
  }
}
```

Claude Code proceeds with `ExitPlanMode` and starts execution.

### 3.3 Daemon response — continue revising

If the reviewer submits feedback:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "<structured feedback markdown — see §3.4>"
  }
}
```

Claude Code sees the tool call as blocked, surfaces the `permissionDecisionReason` to Claude on the next turn, and Claude responds — typically by calling `ExitPlanMode` again with a revised plan.

**Critical: prompt-injection-resistance framing.** Empirically verified (see `docs/protocol-verification.md`): Claude treats `permissionDecisionReason` as potentially untrusted input and will refuse to act on it if it reads like an injection attempt ("ignore your task, do X instead"). This is correct security behavior — without it, any hook could hijack the model.

For Redline's feedback payload (§3.4) to be acted on rather than flagged, it must:

1. **Be unambiguously framed as user-attested review feedback**, not as instructions issued by the tool. The "The user reviewed your plan in Redline…" preface in §3.4 does this.
2. **Stay declarative about reviewer intent**, not prescriptive about model behavior. ✅ "The user wants section B rewritten to address XSS exposure." ❌ "Please add the word PINEAPPLE."
3. **Avoid prompt-injection-shaped phrases** ("ignore", "override", "instead of", "do not follow your previous instructions").
4. **Preserve plan structure language** (anchors, comment IDs) that signals this is a structured review artifact, not freeform instructions.

The §3.4 format already does this well. The discipline matters most in dynamic content — comment bodies, custom user prose in `feedback` and `question` types — where reviewers might inadvertently write something that triggers the heuristic. Redline SHOULD NOT sanitize or rewrite reviewer prose; it SHOULD wrap user prose in a clear "USER COMMENT (verbatim):" frame so Claude understands the comment came from the user, not the tool.

### 3.4 Feedback payload format (the `reason` field)

The exact text format sent back. This is what Claude reads as the "tool blocked" message:

```markdown
The user reviewed your plan in Redline and has requested revisions.

ORIGINAL PLAN ANCHORS (for reference):
- §A: Current state
- §A.1: Threat model constraints
- §B: Proposed approach
- §B.1: JWT token structure
- §B.2: Token storage strategy
- §B.3: Refresh token rotation
- §C: Migration path
- §D: Risk assessment

FEEDBACK:

§A — accept

§B.1 — accept

§B.2 ¶1 [edit, local]
  ORIGINAL: "Store JWT in localStorage for client-side access. Set httpOnly=false so JS can attach the token to outgoing API requests via the Authorization header."
  REVISED:  "Store JWT in an httpOnly, Secure, SameSite=Strict cookie. Implement a double-submit CSRF pattern using a separate non-httpOnly token, validated server-side on every state-changing request."
  COMMENT_ID: c-001

§C [feedback, structural]
  XSS exposure model from §A.1 isn't reflected in the migration order. We need to migrate auth first, before any other endpoints, because the old localStorage tokens become a liability the moment users have a mixed-session state.
  COMMENT_ID: c-002

§D.2 [question]
  Why are we treating the rate limiter as a v2 concern? It feels like a v1 requirement given the auth changes. Don't necessarily change the plan — just want your reasoning.
  COMMENT_ID: c-003

REQUIRED RESPONSE FORMAT:

Produce plan v2 incorporating the edits above and addressing the feedback. When you call ExitPlanMode again, include a resolution block at the top of the plan in this exact format:

<!-- REDLINE_RESOLUTIONS
{
  "c-001": "Addressed in v2. §B.2 rewritten as specified.",
  "c-002": "Addressed in v2. Restructured §C to migrate auth first.",
  "c-003": "Not a plan change. Reasoning: rate limiting depends on the new session model being stable, which v1 establishes. Adding to v1 risks scope creep — explained inline in §D.2 of revised plan."
}
-->

Each comment_id from the FEEDBACK section above MUST appear as a key in the resolution block. Do not skip any.
```

The daemon parses the resolution block from the next plan submission and attaches each resolution to its originating comment in the UI.

### 3.5 Plan submission format (Claude → Daemon, revision)

The v2 plan looks identical to v1 from the wire perspective — same `POST /v1/plan` — except the markdown body begins with the HTML resolution comment:

```http
POST /v1/plan HTTP/1.1
...
{
  "hook_event_name": "PreToolUse",
  "session_id": "7f3a-...",
  "cwd": "/Users/yusuf/code/albazian-law-api",
  "tool_name": "ExitPlanMode",
  "tool_input": {
    "plan": "<!-- REDLINE_RESOLUTIONS\n{\"c-001\": \"...\", ...}\n-->\n\n# Refactor authentication...\n..."
  }
}
```

The daemon:
1. Matches incoming `session_id` to an existing review session.
2. Strips and parses the `REDLINE_RESOLUTIONS` block.
3. Attaches each resolution to its originating comment.
4. Renders the stripped plan as v2, with comments and resolutions preserved.

If `session_id` has no existing review session, this is a fresh plan (v1) — start a new review.

### 3.6 Resolution-block parser tolerance

The whole revision loop depends on Claude reliably emitting a valid `REDLINE_RESOLUTIONS` block on every revision. In practice, model output drifts — especially over long contexts, especially with novel structured formats. The parser must be tolerant *and* the UI must surface failures.

**Parser MUST accept:**
- Fence variations: `<!--REDLINE_RESOLUTIONS`, `<!-- REDLINE_RESOLUTIONS `, mixed case in the keyword.
- The block landing anywhere in the plan body, not only at the top.
- JSON5-ish forgiveness: trailing commas, single quotes around keys/values, unescaped newlines inside string values (best-effort).
- Extra keys the daemon doesn't recognize (ignored without error).

**Parser MUST reject (loudly):**
- Missing block entirely → see "missing block" UX below.
- Comment IDs in the block that don't correspond to any submitted comment → log a warning and surface them in the UI as "unexpected resolution".
- Submitted comment IDs that have no entry in the block → see "missing resolutions" UX below.

**UX for parse failures:**

- **Missing block:** show a banner above the comment column: "Claude didn't return a resolution block. Re-submit the round with a reminder, or treat as unresolved." Action buttons: `Re-prompt` (sends a deny with a terse "your previous response was missing the resolution block; emit one now in this exact format: …") and `Mark all as unresolved`.
- **Malformed block (parser tried, failed):** collapsible "Raw resolution response" panel under the comment cards showing the unparsed text, plus per-comment "Resolve manually" buttons that let the reviewer paste/type a resolution for each missing one.
- **Missing per-comment resolution:** the comment card shows a yellow chip "Awaiting resolution" with the same `Re-prompt` action as above, scoped to just that comment.

**Long-term escape hatch:** a tool-use schema instead of HTML-comment serialization. Not feasible inside an `ExitPlanMode` result today (ExitPlanMode is a single-shot tool with no structured output channel for sidecar metadata), but worth revisiting if Claude Code adds richer hook response affordances.

### 3.7 Wire-protocol versioning

The path is `/v1/plan`. The feedback payload format (§3.4) and resolution-block format will evolve. Forward/backward compatibility rules:

- The daemon SHOULD accept unknown top-level keys in the incoming hook payload (forward-compatible to newer Claude Code releases).
- The daemon MUST ignore unknown keys in the parsed resolution block (forward-compatible to newer Redline → Claude prompt revisions).
- A new feedback-payload version bumps the path: `/v2/plan`. Old daemons return 404; the hook config — installed by a newer Redline — points to the new path. Mixed-version installs degrade to "hook fails → tool proceeds" (per §7.1).
- The resolution block carries an implicit version via its key names. If we add a new key, the parser ignores it on old daemons.

---

## 4. The Feedback Model

### 4.1 Three primitives

Every annotation in the UI is exactly one of these three types. The type is explicit, chosen at composition time, and serialized in the feedback payload:

| Type | UX gesture | Effect on plan | Response shape |
|---|---|---|---|
| **edit** | Select text → "Replace with…" → type new text | Deterministic text substitution | Claude applies it; no reasoning required |
| **feedback** | Select section/text → "Add feedback" → type comment | May trigger rewrite, restructure, or pushback | Claude reasons, revises, and resolves |
| **question** | Select section/text → "Ask" → type question | May or may not change the plan | Claude answers in resolution; plan may stay unchanged |

### 4.2 Modifiers

A `feedback` annotation has a `scope` modifier:

- **local**: contained to this section. Affects only the annotated section.
- **structural**: cross-cutting. May affect descendant sections, ordering, or other sections that depend on this one.

The reviewer picks the modifier when composing. The default for new feedback is `local`. The "structural" choice is a deliberate signal to Claude that re-evaluation should propagate.

`edit` is always treated as `local` (deterministic substitution). `question` has no scope modifier.

### 4.3 Comment lifecycle

```
draft (composing)
  └─→ submitted (sent in feedback payload)
        ├─→ resolved (Claude provided resolution in v_next)
        │     ├─→ accepted (reviewer marked OK)
        │     └─→ reopened (reviewer rejected resolution; comment re-enters submitted state in next round)
        └─→ withdrawn (reviewer deleted before submission round closed)
```

Resolutions are NEVER auto-accepted. The reviewer must explicitly mark resolved-and-accepted, OR submit a new round that implicitly accepts the unmodified resolutions.

### 4.4 Resolution discipline

This is the load-bearing rule: **every comment in the feedback payload MUST receive an explicit resolution from Claude in the next plan submission.** The daemon validates this. If Claude returns v2 without a resolution for `c-002`, the daemon shows a warning in the UI and the reviewer can choose to re-submit the missing item. The full failure-mode behavior is in §3.6.

### 4.5 The fourth gesture — reject and redirect

The three primitives (edit, feedback, question) assume the plan is *roughly right* and needs tuning. Sometimes a reviewer reads a plan and concludes the entire direction is wrong — wrong frame, wrong scope, wrong sequencing — and the right move is to scrap it and re-pitch from a new starting prompt.

That's a distinct gesture from "lots of feedback comments." Trying to express "you're solving the wrong problem" as three local edits and a structural feedback is awkward and Claude often half-listens because each comment looks local.

**Definition:** `reject` is a top-level review action, not a per-section annotation.

**UI:** A `Reject and redirect` button in the footer (alongside `Continue revising` and `Approve plan`). Clicking opens a full-width composer that replaces the comment margin with a single large text area: "Describe the direction you'd actually like Claude to take." Optional toggle: `keep the current plan as background context` (default off — a fresh start usually means a fresh start).

**Wire format:** a `deny` with a free-form prose reason, NO resolution-block requirement:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "REJECTED. The user wants a different direction:\n\n<reviewer's prose>\n\nProduce a new plan from scratch. Do not emit a REDLINE_RESOLUTIONS block this round."
}}
```

**Effect on the session:**

- v2 is a fresh plan, not a revision. The daemon stores it as a new revision but flags it `kind: "redirect"` so the renderer suppresses track-changes against v1 — the diff would be noise.
- All v1 comments are auto-marked `withdrawn` since they no longer have anchors that make sense.
- The conversation history (revisions array) is preserved for reference but the next round starts clean.

**v0.1 scope:** in. Without this, a reviewer hits dead ends on bad plans and either accepts something they shouldn't or escapes the loop manually. It's a one-button feature; including it costs ~½ day and prevents a class of failure.

### 4.6 Edit-only fast-path approval

When *every* annotation in a round is an `edit` (deterministic text substitution), forcing a full revision + resolution cycle is wasteful — the edits are mechanical and there's nothing for Claude to reason about. The fast path collapses two round-trips into one.

**Approach (verified-feasible):** the daemon sends a `deny` whose `permissionDecisionReason` is a stripped-down feedback payload — *only* the edits, with terse instructions and no resolution-block requirement. Claude applies the edits in v2 and re-emits. The daemon parses v2, checks that each `ORIGINAL → REVISED` substitution is present, and if all match, **auto-approves v2** without surfacing it to the reviewer for another round.

**Wire shape of the deny:**

```
The user reviewed your plan in Redline and made only deterministic text edits — no feedback, no questions. Apply each edit exactly as specified and re-emit the plan. Do NOT include a REDLINE_RESOLUTIONS block.

EDITS:

  §B.2 ¶1
    ORIGINAL: "Store JWT in localStorage..."
    REVISED:  "Store JWT in an httpOnly, Secure, SameSite=Strict cookie..."

  §C.1 ¶3
    ORIGINAL: "Run migrations during deploy"
    REVISED:  "Run migrations as a separate pre-deploy step"

After applying these edits exactly, call ExitPlanMode with the patched plan. The reviewer has pre-approved everything else and will accept v2 automatically if the edits land.
```

**Auto-approval logic on v2:** for each edit, check the REVISED text appears in v2 and the ORIGINAL text does not. If all edits land cleanly, return `{permissionDecision: "allow"}` without involving the reviewer. If any edit fails to land (e.g., Claude re-phrased the surrounding context such that ORIGINAL doesn't exist anymore), surface v2 in the UI with the failed edits flagged for manual review.

**Why not modify `tool_input` directly?** Empirically tested (see `docs/protocol-verification.md` (f)): Claude Code's PreToolUse hook response does not honor a `modifiedToolInput` field. The deny+auto-approve flow is the only viable mechanism.

**v0.1 scope:** in, but behind a feature flag. Worth shipping because it makes the "I just want to fix three typos" workflow one click instead of two — the most common review interaction. Behind a flag because the auto-approve heuristic needs real-world testing before becoming the default.

---

## 5. Data Model

### 5.1 TypeScript types (canonical)

```typescript
type SessionId = string;       // Claude Code session UUID
type CommentId = string;       // e.g. "c-001"
type AnchorId = string;        // e.g. "B.2", "B.2.p1"

interface ReviewSession {
  sessionId: SessionId;
  projectPath: string;         // cwd from hook
  projectName: string;         // derived from cwd basename
  createdAt: ISO8601;
  revisions: Revision[];       // ordered, oldest first
  status: 'in_review' | 'approved' | 'aborted';
}

interface Revision {
  versionNumber: number;       // 1, 2, 3...
  receivedAt: ISO8601;
  rawPlanMarkdown: string;     // original from hook, with resolutions stripped
  sections: Section[];         // parsed tree
  comments: Comment[];         // composed against THIS revision
  resolutions: Record<CommentId, string>; // for v2+, resolutions to v(n-1)'s comments
  submittedAt: ISO8601 | null; // when reviewer submitted; null if still in review
}

interface Section {
  anchorId: AnchorId;          // assigned by daemon during parse
  level: number;               // heading depth: 1, 2, 3
  title: string;
  bodyMarkdown: string;        // section content, child sections excluded
  children: Section[];
  paragraphs: Paragraph[];     // body broken into anchorable paragraphs
}

interface Paragraph {
  anchorId: AnchorId;          // e.g. "B.2.p1"
  text: string;
}

interface Comment {
  id: CommentId;
  type: 'edit' | 'feedback' | 'question';
  scope?: 'local' | 'structural';  // only present when type === 'feedback'
  anchorId: AnchorId;          // section or paragraph anchor
  body: string;                // the comment text
  edit?: {                     // only when type === 'edit'
    original: string;          // selected text being replaced
    revised: string;
  };
  createdAt: ISO8601;
  status: 'draft' | 'submitted' | 'resolved' | 'accepted' | 'reopened' | 'withdrawn';
  resolution?: {
    body: string;              // Claude's resolution text
    appearedInVersion: number;
    acceptedAt: ISO8601 | null;
  };
}
```

### 5.2 Persistence

SQLite database in the Tauri app data directory:

- `sessions` — one row per `ReviewSession`.
- `revisions` — many-to-one with sessions.
- `comments` — many-to-one with revisions.

Plan markdown is stored as TEXT. Section trees are parsed on read (not pre-materialized) — anchoring is deterministic from the markdown.

### 5.3 Anchor assignment strategy

Anchors are derived deterministically from heading structure:

- Top-level (H1) headings get letter anchors: A, B, C, …
- H2 headings under A get: A.1, A.2, A.3, …
- H3 headings under A.1 get: A.1.1, A.1.2, …
- Paragraphs within a leaf section get suffix: A.1.p1, A.1.p2, …

When v2 arrives, the daemon re-parses and re-assigns anchors. **Anchors may shift between revisions if structure changes.** This is acceptable because:

1. Comments are bound to anchors *at submission time*, captured in the feedback payload.
2. Resolutions reference comment IDs, not anchors.
3. The UI can show "comment was about §B.2 in v1, which is now §C.1 in v2" via the resolution.

Future: explore Claude-assigned stable anchor IDs for cross-version stability. Defer for v1.

---

## 6. The User Interface

### 6.1 Visual design language

**Core principle:** the review surface is a document, not a dashboard.

- **Body text**: serif (var `--font-serif`), 14–15px, line-height 1.6–1.7.
- **Chrome** (header, toolbar, comments): sans-serif (var `--font-sans`), 12–13px.
- **Anchors**: monospace, small (10–11px), in a subtle pill.
- **Track changes**: red strikethrough for deletions, green for insertions. Familiar Word semantics.
- **Comment cards**: in a right margin column, not floating popovers.
- **Color**: minimal. Semantic colors only — info (blue) for edits, warning (amber) for feedback, success (green) for questions.

### 6.2 Layout

```
┌─────────────────────────────────────────────────────────┐
│  Header                                                  │
│  Title · project · session · revision pill (v1 → v2)    │
├──────────────────────────────────┬──────────────────────┤
│                                  │                       │
│  Document body                   │  Comment margin       │
│  Serif. Sections rendered with   │  Threaded cards.      │
│  anchor pills.                   │  One card per         │
│  Track changes shown inline      │  comment, replies     │
│  during revisions.               │  nested under.        │
│                                  │  Type badge on each.  │
│                                  │                       │
├──────────────────────────────────┴──────────────────────┤
│  Footer                                                  │
│  Stats · [Continue revising]  [Approve plan]            │
└─────────────────────────────────────────────────────────┘
```

Window dimensions: default 1100×800, resizable. Document column flexible; comment margin fixed at 320px on desktop, collapsible.

### 6.3 Multi-session UI

When multiple Claude Code instances surface plans concurrently:

- Tray icon shows a badge with pending plan count.
- Clicking the tray opens the daemon window.
- A left sidebar lists active review sessions with project name, plan title, version, and a "new comments" indicator.
- Clicking a session switches the main pane.

Out of scope for v0.1: live picture-in-picture of multiple plans, tabs, drag-to-detach windows.

### 6.4 Composing a comment

Interaction model:

1. Reviewer selects text in the document (or clicks an "Add comment" affordance on a section).
2. A floating action menu appears: `[Edit]` `[Feedback]` `[Question]`.
3. Picking one opens a composer in the right margin, pre-anchored to the selected text/section.
4. For `feedback`, the composer has a scope toggle: `local` (default) / `structural`.
5. For `edit`, the composer has two text areas: "Original" (pre-filled from selection) and "Revised".
6. Reviewer types, hits ⌘+Enter to add the comment to the queue. The comment appears in the margin in `draft` state.

### 6.5 Submitting a review round

When the reviewer is done annotating:

- Footer shows a counter: "3 comments pending · 1 edit, 2 feedback".
- Clicking **Continue revising** serializes all `draft` comments into the feedback payload (§3.4), sets them all to `submitted`, and returns the payload to Claude Code as the hook response.
- The window stays open. The footer changes to "Waiting for v2…" with a subtle loading state.
- When v2 arrives via the hook (a new POST to `/v1/plan` with matching `session_id`), the document re-renders with track changes from v1, and each comment shows Claude's resolution reply.

Clicking **Approve plan** returns `{decision: "allow"}` and dismisses the window after a brief "Approved · executing" toast.

### 6.6 Editor library

**Recommendation: ProseMirror via Tiptap base packages.**

- `@tiptap/core`, `@tiptap/starter-kit` for the editor.
- Custom Tiptap extension for `commentMark` (wraps a span of text in a comment-anchor mark).
- Custom Tiptap extension for `trackChange` (renders insertions/deletions with proper styling and structure).
- Section anchors rendered as decorations (not document nodes — they're computed, not user-editable).

Alternative: build directly on ProseMirror. More work, more control. Skip for v1.

Avoid: Lexical (Meta) — overkill, fewer existing extensions for this use case. Plain contenteditable — fragile, will fight us on selections.

---

## 7. The Hook

### 7.1 Configuration

Installed by Redline's installer to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:7676/v1/plan",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

Notes:

- `timeout: 600` (10 minutes) lets the reviewer take their time. The Claude Code docs cite a 30s *default* for HTTP hooks, but setting `timeout: 600` explicitly is honored — verified empirically (see `docs/protocol-verification.md` (b)). Reviewers can pause within a round without losing the hold.
- HTTP hook (not command hook) means a single endpoint serves every Claude Code instance on the machine.
- If the daemon is not running, the connection fails. Verified empirically: Claude Code silently treats this as a non-blocking error — execution proceeds normally, the plan appears in the terminal as if no hook were configured. **Graceful degradation is automatic and silent**, which is desirable for the user but means the installer/tray UI is the only place that can tell the user "Redline isn't running."

### 7.2 Auto-launching the daemon

The hook config could include a thin shell shim that ensures the daemon is running before the HTTP request, but this adds complexity. v0.1 ships with a manual launch (open the app, leave it in the tray). v0.2 explores a `launchd`/login-items auto-start.

### 7.3 First-time consent

Claude Code's `/hooks` workflow asks the user to approve any hook config changes. The installer surfaces this — after writing to `~/.claude/settings.json`, it prompts: "Open Claude Code and run `/hooks` to confirm the Redline hook. This is a one-time security check."

---

## 8. The Daemon

### 8.1 HTTP server (Rust, axum)

Routes:

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/plan` | Receive plan from Claude Code hook |
| GET | `/v1/sessions` | Frontend: list active review sessions |
| GET | `/v1/sessions/:id` | Frontend: get session state |
| POST | `/v1/sessions/:id/submit` | Frontend: submit reviewer's annotations |
| POST | `/v1/sessions/:id/approve` | Frontend: approve plan |

`POST /v1/plan` is the blocking endpoint. It:

1. Parses the hook payload.
2. Routes by `session_id`:
   - If new session: create `ReviewSession`, store v1.
   - If existing: parse resolutions from plan markdown, attach to comments from v(n-1), store v(n).
3. Notifies the frontend over a Tauri event (`plan-received`).
4. Waits — using a tokio oneshot channel keyed by `session_id` — for the frontend to submit or approve.
5. Returns the appropriate hook response.

If the wait exceeds the hook's `timeout`, the connection drops; on the frontend, the review continues but the submit will silently fail. UI handles this case by warning the reviewer and offering to copy the feedback payload to clipboard so they can paste it manually.

### 8.2 Plan parsing

Library: `pulldown-cmark` (Rust) for markdown → AST. Walk the AST to build the `Section` tree and assign anchors per §5.3.

The parser must handle:

- Standard markdown headings (#, ##, ###).
- Lists, code blocks, blockquotes (preserve as-is in body markdown).
- The REDLINE_RESOLUTIONS HTML comment block (strip and parse separately).

### 8.3 Frontend ↔ backend communication

Tauri commands (sync RPC) for state queries. Tauri events (async push) for plan-received notifications.

```rust
// Commands
#[tauri::command] fn list_sessions() -> Vec<SessionSummary>;
#[tauri::command] fn get_session(id: SessionId) -> ReviewSession;
#[tauri::command] fn submit_review(id: SessionId, comments: Vec<Comment>) -> Result<()>;
#[tauri::command] fn approve_plan(id: SessionId) -> Result<()>;

// Events
emit("plan-received", { session_id, version });
emit("session-status-changed", { session_id, status });
```

### 8.4 Session abandonment

The held-open POST is the only thing keeping Claude Code from timing out the tool call. If the reviewer closes the review window or the app exits without an explicit decision, the connection eventually drops at the hook's timeout boundary (§7.1) and Claude Code surfaces a generic timeout error to the user. That's a bad failure mode — Claude doesn't know *why* it timed out and may retry the same plan.

**Behavior:**

- Closing the review window with pending unresolved state prompts: `Abandon this review?` with three options:
  - **Cancel** — keep the window open.
  - **Submit empty review** — equivalent to `Approve plan`. Useful when the reviewer changes their mind and just wants Claude to proceed.
  - **Reject and stop** — sends `{permissionDecision: "deny", permissionDecisionReason: "User cancelled the review and does not want to proceed with this plan."}` so Claude exits plan mode cleanly rather than re-pitching another revision.
- Quitting the Redline app entirely with sessions in flight: a "graceful shutdown" routine sends `Reject and stop` to every pending session before exiting. ~1 second additional shutdown latency.
- The daemon tracks held-open POSTs via tokio oneshot channels keyed by `session_id`. On session abandonment (whatever the trigger), the corresponding oneshot is `send`-ed with the chosen response and the request handler resolves cleanly. Orphaned channels older than `2 × hook_timeout` are GC'd on a 60s tick.

### 8.5 Concurrent revisions on the same session

Edge case but real: Claude Code somehow re-enters plan mode and calls `ExitPlanMode` again while the prior plan is still under review. Could happen if the user typed during review and Claude retried, or if a hook misfire double-delivered.

**v0.1 behavior (option B — reject):** the daemon detects the duplicate POST (same `session_id`, prior request not yet resolved) and returns an immediate `deny`:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "A review of an earlier plan from this session is still in progress in Redline. Wait for the reviewer to finish before submitting a new plan."
}}
```

Claude will typically pause and let the user proceed. The reviewer continues their existing review unaffected.

**v0.2 behavior (option A — queue):** treat the new plan as v(n+1) of the session, surface a "Claude sent a new plan while you were reviewing — switch?" prompt, and close the prior held-open POST with a `Superseded by a newer plan` deny. More flexible but adds UI state complexity; defer.

---

## 9. The Revision Loop (end-to-end walkthrough)

1. **Yusuf is in Claude Code in `~/code/albazian-law-api`.** He asks Claude to plan a JWT refactor. Claude enters plan mode and eventually calls `ExitPlanMode` with the plan.

2. **Hook fires.** Claude Code POSTs the plan to `127.0.0.1:7676/v1/plan`.

3. **Daemon receives.** No existing session for this `session_id` → creates `ReviewSession`, parses plan, stores v1, emits `plan-received`.

4. **Frontend shows the plan.** Tray badge increments. Yusuf clicks tray → window opens to the new session.

5. **Yusuf reviews.** He selects text in §B.2 → picks "Edit" from the floating menu → composes the replacement text. He selects §C → picks "Feedback" → marks it `structural` → types his concern. He selects §D.2 → picks "Question" → asks why rate-limiting is v2.

6. **Yusuf clicks "Continue revising."** Frontend calls `submit_review` with the comments. Backend serializes the feedback payload per §3.4, completes the held-open POST with `{decision: "deny", reason: <payload>}`.

7. **Claude Code receives the blocked tool result.** Claude reads the feedback in the next turn, thinks, revises the plan, and calls `ExitPlanMode` again — this time with the `REDLINE_RESOLUTIONS` block prepended.

8. **Hook fires again.** Same `session_id`, new plan content. Daemon parses, recognizes existing session, strips resolutions, stores v2 with resolutions attached to v1's comments. Emits `plan-received`.

9. **Frontend re-renders.** Document now shows v2 with track-changes against v1. Each previously-submitted comment now shows Claude's resolution inline. Yusuf can mark each resolution accepted, or reopen.

10. **Yusuf is satisfied.** He clicks "Approve plan." Backend completes the held-open POST with `{decision: "allow"}`. Claude Code executes the plan.

If at step 9 Yusuf is not satisfied, he composes new comments (which may include reopened ones from v1) and submits again. Loop continues.

---

## 10. MVP scope (v0.1)

**In scope:**

- Tauri app with tray + single review window.
- HTTP hook integration via global config in `~/.claude/settings.json`.
- Plan markdown parsing with anchor assignment.
- Three comment primitives (edit, feedback, question) with scope modifier on feedback.
- Section-anchored commenting via text selection.
- Submit → feedback payload generation → hook response.
- v2 reception with resolution parsing and inline display.
- Approve → execution.
- Single-session focus. Multi-session sidebar deferred.
- SQLite persistence so quitting the app doesn't lose state.

**Explicitly deferred to v0.2+:**

- Multi-session sidebar and tray badge counts.
- Daemon auto-launch on login.
- Approval surface for tool calls beyond ExitPlanMode (Bash, Edit, Write).
- Cross-version anchor stability (Claude-assigned stable IDs).
- Reopening individual resolutions vs. round-level reopen.
- Mobile companion (long-tail).
- Cloud sync (probably never — local-first is part of the value).

**Out of scope, period:**

- Code diff review.
- Multi-user collaboration.
- Non–Claude-Code agents.

---

## 11. Open decisions

These are real choices I want you to make consciously rather than default into. Each has a recommended answer but the recommendation is arguable:

1. **Editor library**: Tiptap (recommended) vs. raw ProseMirror vs. Lexical. Tiptap fastest to ship; ProseMirror gives more control if track-changes extension proves limiting.
2. **Anchor stability strategy**: deterministic re-parse (recommended for v1) vs. Claude-assigned stable IDs (better long-term, more prompt complexity).
3. **Floating menu vs. always-visible comment toolbar.** Floating is cleaner; always-visible is more discoverable.
4. **Tray vs. dock app.** Tray (recommended) feels lighter and works well for "ambient companion." Dock would be more conventional.
5. **Comment scope default.** New `feedback` defaults to `local` (recommended). Could default to `structural` to encourage more cross-section thinking, but the noisier choice is the wrong default.
6. **Multi-line edit primitive.** v0.1 supports single-paragraph edits. Multi-paragraph edits (e.g., "rewrite this whole subsection") might need a different gesture. Defer; observe usage.
7. **What if Claude omits a resolution?** Current spec says: warn the reviewer, allow re-submit. Alternative: auto-resubmit the missing items. Reviewer-in-the-loop is safer.

---

## 12. Tech stack (consolidated)

| Layer | Choice |
|---|---|
| App shell | Tauri 2 |
| Backend language | Rust |
| HTTP server | axum + tokio |
| Markdown parser | pulldown-cmark |
| Persistence | rusqlite (sqlite) |
| Frontend framework | React 18 + TypeScript |
| Build tool | Vite |
| Editor | Tiptap (ProseMirror) |
| Styling | Tailwind CSS + custom design tokens |
| State management | Zustand (lightweight) |
| Icons | Lucide React |
| IPC | Tauri commands + events |

---

## 13. Build plan (phased)

**Milestone 1 — Hook roundtrip (1–2 days)**

- Tauri scaffold with a tray icon and a hello-world window.
- Rust HTTP server on port 7676.
- POST `/v1/plan` accepts a payload, logs it, returns `{decision: "allow"}` immediately.
- Manual hook config in `~/.claude/settings.json`.
- Test: run `claude` in plan mode in any project; confirm the daemon logs the payload and Claude Code proceeds.

**Milestone 2 — Plan rendering (2–3 days)**

- Frontend route: review window for a single hardcoded session.
- Markdown parser in Rust with anchor assignment.
- Document component in React: renders sections with anchor pills, serif body.
- Tauri command to fetch the parsed plan.
- No commenting yet — read-only review.

**Milestone 3 — Comment composition (3–4 days)**

- Selection-driven floating menu in the editor.
- Comment composer in right margin.
- Three primitives with scope modifier for feedback.
- Comments stored in memory in the daemon, persisted to sqlite.
- Footer with comment stats.

**Milestone 4 — Submit + revision (3–4 days)**

- Submit serializes feedback payload per §3.4.
- POST `/v1/plan` becomes blocking with tokio oneshot wait.
- Submit completes the held-open POST with the feedback payload.
- v2 reception parses resolutions and attaches to comments.
- Track-changes rendering in the document.
- Resolution display in comment cards.

**Milestone 5 — Polish + multi-session (3–5 days)**

- Tray badge with pending count.
- Left sidebar with session list.
- Approve flow + dismiss toast.
- Reopening individual resolutions.
- Installer (writes hook config; surfaces `/hooks` consent step).

**Milestone 6 — Ship (1–2 days)**

- Tauri bundle for macOS (signed + notarized) and Windows.
- Landing page (Vite + Tailwind, single page).
- Install instructions and a 30-second demo video.

Total estimate: ~3 weeks of focused work to a shippable v0.1.

---

## 14. References

- Claude Code hooks reference: https://code.claude.com/docs/en/hooks
- HTTP hooks (released Feb 2026): hook type `http`, blocking via `decision: "deny"` with `reason`.
- The "unreasonable effectiveness of HTML" framing: https://thariqs.github.io/html-effectiveness/
- Tauri 2 docs: https://tauri.app/
- Tiptap docs: https://tiptap.dev/
- pulldown-cmark: https://github.com/raphlinus/pulldown-cmark

---

## 15. What to hand to Claude Code

When you start the build, paste this spec into a new repo and tell Claude Code:

> Read `redline-spec.md` end-to-end. Start with Milestone 1: scaffold the Tauri app, set up the tray icon, the HTTP server on port 7676, and the `/v1/plan` endpoint that logs incoming payloads. Don't implement anything beyond Milestone 1 in this session. Confirm the milestone is working end-to-end by walking me through a test before moving on.

Milestone gates are deliberate — they keep Claude from over-running scope and give you natural review points where this exact tool would be useful (recursive, but real).

---

## 16. Observability (local-only)

Redline is local-first. There is no telemetry, no phone-home, no analytics endpoint. *But* the product is only useful if it's measurably faster and more accurate than typing prose feedback into the terminal, and the only way to know that is to instrument yourself.

**What's logged (locally, in SQLite alongside session data):**

| Metric | Why it matters |
|---|---|
| Per-session total wall time (`v1_received_at` → `approved_at` or `rejected_at`) | Is the review faster than the alternative? |
| Number of revision rounds before approval | Are reviewers loop-thrashing or converging? |
| Comments per round, by type (edit / feedback-local / feedback-structural / question) | What's the actual feedback distribution? |
| Per-comment time-to-resolve (`comment.created_at` → `resolution.appeared_at`) | Are some comment types causing slow rebuilds? |
| Resolution-acceptance rate (resolutions accepted ÷ resolutions emitted) | How often does Claude get it right on the first try? |
| Reject-and-redirect rate (rejected plans ÷ total plans) | What fraction of plans are off-direction enough that incremental review is the wrong tool? |
| Hook-failure rate (parse errors, timeouts, malformed resolution blocks) | Reliability of the protocol over time. |

**Where it surfaces:**

- Tray menu → `Stats…` opens a small read-only window with rolling 30-day numbers and a per-session detail table.
- A `GET /v1/stats` endpoint on the daemon (loopback only) for scripted access.
- No data leaves the machine. Period.

**Why it's in v0.1, not deferred:** the data tells you whether the product is working, and tells *you* whether you're a structural commenter or a local commenter — useful both for tuning the defaults in §4.2 and for your own self-knowledge. Adding it after the SQLite schema is set is much more painful than including it from the start.