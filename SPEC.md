# Redline — Specification

**Status:** v0.1 (as-built)
**Author:** Yusuf Al-Bazian
**License:** Apache-2.0 (code) + trademark reserved; CLA-gated contributions.

A Tauri 2 desktop app that turns the **document** — a Claude Code plan, a spec, a
research brief — into the center of an IDE. It began (and its spine remains) as a
plan-review companion: it intercepts Claude Code's plan-mode tool call, holds the
agent's session open, and surfaces the plan in a Word-style track-changes editor,
so a reviewer can mark it up inline and round-trip structured feedback (or
questions) back into the same session. Around that loop it has grown the rest of
the arc *before the code* — an embedded web browser with per-tab AI page
agents, cross-tab research missions, a prompt drafter, and a voice agent — each
surface paired with the user's own local Claude Code.

This document describes Redline *as it is built today*, not as it was originally
scoped. For the historical pre-build design, see git history; for the strategic
direction, see [docs/document-ide-northstar.md](docs/document-ide-northstar.md).

---

## 1. What Redline is

### 1.1 The plan-review spine

A reviewer fires up `claude` inside Redline's embedded terminal. When the agent
calls `ExitPlanMode`, a `PreToolUse` HTTP hook POSTs the plan to a local daemon
running inside the same app. The daemon parses the plan, stably ID's every
section and paragraph, persists the session, and surfaces a Tiptap/Yjs document
with a comment margin. The reviewer can:

- **Approve** — releases the hook with `allow`. Claude proceeds.
- **Continue revising** — releases the hook with `deny` plus a structured
  feedback payload assembled from the reviewer's comments. Claude returns a v(n+1)
  plan with a `<!-- REDLINE_RESOLUTIONS … -->` block, which the daemon strips,
  parses, and attaches to the v(n) comments.
- **Ask Claude** — questions-only submission. The daemon expects an unchanged
  plan back; if the plan body matches the prior revision the round-trip is
  classified as an "Ask" and resolutions attach to the *current* revision with
  no version bump. If Claude edits the plan anyway, the UI surfaces an
  `ask_mode_violated` warning and proceeds as a normal revise.

The app also runs a real PTY-backed shell (one per tab) so the reviewer never
leaves Redline to drive the agent. Sessions, revisions, and comments persist in
SQLite across restarts; the live editor document persists in Yjs + IndexedDB.

### 1.2 The surfaces around the document

Beyond plan review, Redline arranges a set of surfaces around the document, each
driven by the user's own local Claude Code:

- **Embedded browser + page agents** — a tabbed browser built on native Tauri
  child webviews. Each tab has its own headless Claude agent that can read *and*
  drive the page (navigate, click, extract, download) through a local HTTP bridge.
- **Research missions** — an orchestrator agent a tier above the tabs that holds
  a goal, reads across every open tab and the user's pinned findings, and
  synthesizes a Drafter-ready brief.
- **Prompt Drafter** — a second rich-text surface where research becomes the
  prompt or spec that seeds a plan.
- **Agent-in-document** — a Claude Code session (e.g. one running in a terminal)
  can read the live plan's block structure and post its own edits as tracked
  suggestions the reviewer accepts or rejects.
- **Voice, dictation, and TTS** — a persistent voice agent, on-device dictation,
  and read-aloud text-to-speech.

Every agent surface runs the user's local `claude` binary as a subprocess. Redline
never calls a model API directly.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Redline (Tauri 2 desktop app)                                       │
│                                                                       │
│  ┌──────────────────────────────┐    ┌─────────────────────────────┐ │
│  │  React 19 frontend (Vite)     │    │  Rust backend               │ │
│  │  • Tiptap + Yjs editor        │    │  • axum on 127.0.0.1:7676   │ │
│  │  • xterm.js terminal tabs     │◀──▶│  • portable-pty shells      │ │
│  │  • Native browser webviews    │    │  • SessionStore + SQLite    │ │
│  │  • Mission / Drafter / Voice  │    │  • Plan parser (pulldown)   │ │
│  │  • Mode toggle, theme/font    │    │  • Agent spawners (claude)  │ │
│  └──────────────────────────────┘    └────────────▲────────────────┘ │
│         ▲ Tauri commands / events / Channels       │                  │
└─────────┼──────────────────────────────────────────┼──────────────────┘
          │                                          │ HTTP
          │                                          │ /v1/plan (held open)
          │                                          │ /v1/sessions/* (agent-in-doc)
          │                                          │ /v1/browser/*  /v1/mission/*
          │                              ┌───────────┴───────────────┐
          │                              │  Claude Code (local)       │
          │                              │  • plan-mode session in    │
          │                              │    the embedded PTY        │
          └─────────────────────────────▶│  • headless agents Redline │
                                         │    spawns for forks,       │
                                         │    browse, mission, voice  │
                                         └────────────────────────────┘
```

### 2.1 Components

| Component | Lives in | Role |
|---|---|---|
| Tauri shell | `src-tauri/src/main.rs`, `lib.rs` | App lifecycle, tray, menus, command/event wiring, axum server |
| HTTP daemon | `lib.rs` `run_server()` + `hook.rs` | Receives plans on `:7676`, holds POSTs, serves the agent/browser/mission bridge |
| Plan parser | `parser.rs` | Markdown → section/paragraph tree; anchor + block-ID assignment |
| Session store | `state.rs` + `db.rs` | In-memory cache backed by SQLite |
| Feedback serializer | `feedback.rs` | Comments → `permissionDecisionReason` markdown |
| Resolution parser | `resolutions.rs` | `<!-- REDLINE_RESOLUTIONS … -->` → `{comment_id: text}` |
| Agent-in-doc | `agent.rs` | External-agent plan reads + tracked-suggestion / feedback writes |
| PTY backend | `pty.rs` | Spawn/read/write shells via `portable-pty` (output over a per-tab Channel) |
| Fork agent | `fork.rs` | Read-only per-comment discussion threads (forked `claude`) |
| Browse agent | `browse.rs` | Per-tab page-discussion agent (headless `claude` per turn) |
| Mission agent | `mission.rs` | Cross-tab research orchestrator (resumable `claude` session) |
| Voice / TTS / dictation | `voice.rs`, `tts.rs`, `dictation.rs` | Persistent voice agent, text-to-speech, on-device speech-to-text |
| Filesystem | `fsbrowse.rs`, `fswatch.rs`, `highlight.rs` | File tree, dir watching, off-thread syntax highlighting |
| Skill installer | `skill.rs` | Embeds + installs bundled skills via `include_str!` |
| Editor | `src/editor/` (Tiptap + Yjs) | Plan rendering, CRDT doc, comment marks, track changes |
| Browser UI | `src/components/BrowserPane.tsx`, `BrowserChat.tsx` | Native webview tabs + per-tab discussion |
| Mission / Drafter / Voice UI | `MissionChat.tsx`, `PromptDrafter.tsx`, `VoicePanel.tsx` | The non-plan surfaces |
| Terminal UI | `src/components/Terminal*.tsx` (xterm.js) | Embedded shell tabs |
| Review surface | `src/App.tsx`, `src/components/*` | Sidebar, composer, comment margin, banners, footer |

### 2.2 Why Tauri 2

Tauri is what shipped. Rationale: small bundle, native tray, rusqlite-friendly
backend, a clean home for the axum HTTP server inside the same process as the UI
(no separate daemon to manage), and — increasingly load-bearing — native child
webviews for the embedded browser (`@tauri-apps/api/webview`), which behave like
real browser tabs rather than sandboxed `<iframe>`s.

---

## 3. The plan wire protocol

### 3.1 Plan submission (Claude Code → Redline)

A `PreToolUse` **HTTP** hook on `ExitPlanMode`, installed at
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

1. Strips any `<!-- REDLINE_RESOLUTIONS … -->` block from `tool_input.plan`.
2. Parses the remaining markdown into a section tree with stable block IDs.
3. Routes by `session_id`:
   - **New session** → create `ReviewSession`, store as v1, set `thread_start = true`.
   - **Existing session, plan body changed** → store as v(n+1), classify as either
     fresh-plan (`thread_start = true`) or a feedback revision attaching to v(n).
   - **Existing session, plan body unchanged AND expected mode was Ask** → no
     version bump; attach resolutions to the current revision.
   - **`session_id` is a known fork/browse/voice session** → ignored, so an
     agent that Redline itself spawned can never post a phantom revision.
4. Emits `plan-received` to the frontend.
5. Routes the held POST per interception mode (§5).

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
    "permissionDecisionReason": "<feedback markdown — see §6>"
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

### 3.5 The agent-in-document bridge (external Claude Code → Redline)

A Claude Code session that is *not* the held plan-mode session — for example one
running in a terminal — can read and contribute to a live review over HTTP. These
routes back the agent-in-document feature (§6.6):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/sessions/:session_id/plan` | The published plan + a flat block index, so an agent can anchor to real `blk-` IDs |
| `POST` | `/v1/sessions/:session_id/suggestions` | Post a tracked `edit` suggestion (rejected with a conflict if the target block no longer matches the supplied original) |
| `POST` | `/v1/sessions/:session_id/comments` | Post a feedback comment |
| `GET` | `/v1/sessions/:session_id/feedback` | Read back the assembled feedback |

### 3.6 Versioning

The path prefix is `/v1`. Future protocol breaks bump the prefix. Unknown
top-level keys in the hook payload and unknown keys in the resolution block are
ignored.

---

## 4. The bridge for spawned agents

The browser page agents (§9) and the mission orchestrator (§10) do not call Tauri
commands — they are headless `claude` subprocesses, so they reach Redline the same
way any local script would: `curl` against the daemon on `127.0.0.1:7676`. On hook
install Redline pre-authorizes those curl calls in `permissions.allow` (§13.1) so
the agents run without permission prompts.

| Method | Path | Used by |
|---|---|---|
| `GET` | `/v1/browser/active` | browse / mission — the active tab |
| `GET` | `/v1/browser/tabs` | mission — the full tab map (number, url, title, active) |
| `GET` | `/v1/browser/thread` | mission — a tab's prior discussion (`?tab=<n>`) |
| `GET` | `/v1/browser/snapshot` | browse / mission — a tab's live DOM snapshot (`?tab=<n>`) |
| `POST` | `/v1/browser/query` | browse — query the page DOM |
| `POST` | `/v1/browser/navigate` | browse — drive a tab to a URL |
| `POST` | `/v1/browser/click` | browse — click within a tab |
| `POST` | `/v1/browser/open` | browse / mission — open a new tab |
| `POST` | `/v1/browser/focus` | browse / mission — switch the user into a tab |
| `POST` | `/v1/browser/download` | browse — save the page or a linked file to disk |
| `GET` | `/v1/mission/active` | mission — the current mission + goal |
| `GET` | `/v1/mission/findings` | mission — the user's pinned findings |

Tabs are addressed by their 1-based strip number (`?tab=<n>`).

---

## 5. Interception modes

Set by the user from the header `ModeToggle` or the tray menu; persisted in
`app_settings` (SQLite). Killing a mode releases any currently-held POSTs.

| Mode | Behavior |
|---|---|
| **Active** (default) | Every plan blocks until the reviewer explicitly approves or submits. The POST is held open. |
| **Ambient** | Plan is captured and surfaced; a `DecisionWindowBanner` counts down `AMBIENT_WINDOW_SECS = 20 s`. If the reviewer doesn't claim it via `claim_review`, the daemon auto-approves. If they do, it behaves like Active for that session. |
| **Paused** | Killswitch. Plans are auto-approved immediately; nothing is captured. |

Mode transitions broadcast a `mode-changed` event and sync the tray's radio
group. Switching out of Active mid-review releases every held POST with an
`allow` and a "Superseded — Redline interception mode changed" reason. The hold
itself is bounded by the hook timeout (§13.1, 12 h).

---

## 6. The feedback model

Comments are session-scoped (`c-001`, `c-002`, …) and live on a specific
revision. Each comment carries:

- `type` — `edit | feedback | question | block-insert | block-delete | block-move`
- `scope` — only on `feedback`: `local | structural`
- `anchor_id` — positional anchor (e.g. `B.2`, `B.2.p1`)
- `block_id` — stable, sidecar-backed ID (e.g. `blk-7f2a…`) for cross-revision joining
- `body` — reviewer prose
- `edit?` — `{ original, revised }` for `edit` type
- `structural?` — JSON payload for block insert/delete/move
- selection anchor — `sel_char_start`, `sel_char_end`, `sel_quoted_text`,
  `sel_sub_block_id` for sub-block (sentence/word) addressing
- `status` — `draft | submitted | resolved | accepted | reopened | withdrawn`
- `resolution?` — `{ body, appeared_in_version, accepted_at }`
- `reopen_note?`, `reopen_history?` — carried across rounds when a resolution is reopened
- `author?` — `null` for reviewer comments; `"claude-code"` or `"voice"` for
  agent-authored ones (§6.6)
- `agent_state?` — lifecycle for agent-authored suggestions (e.g. `"accepted"`)

### 6.1 Submission modes

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

### 6.2 Ask round-trip detection

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

### 6.3 Comment lifecycle

```
draft ─► submitted ─► resolved ─► accepted
                         │
                         └─► reopened (re-submitted on next round)
draft ─► withdrawn (deleted before submission round)
```

Resolutions are never auto-accepted. The reviewer must mark each one
`accepted` (or `reopen` it, optionally with a `reopen_note`).

### 6.4 Resolution parse warnings

The frontend renders a `ResolutionWarningBanner` whenever the daemon reports any
of: `parse_error`, `unmatched_ids`, `missing_ids`, `missing_block` (the last only
on revise submissions, which require a resolution block).

### 6.5 Fork-agent discussion threads

Every comment can host a multi-turn **discussion thread** with a Claude Code
session *fork* — a context-aware sub-agent that answers inline without disturbing
the held plan-mode session. This is the "discuss" verb, distinct from "revise"
(§6.1): a thread never round-trips into the plan.

**Mechanism.** A turn runs a headless `claude` process (`fork.rs`):

- First turn — `claude -p "<prompt>" --resume <main_session_id> --fork-session
  --output-format stream-json --include-partial-messages --verbose
  --permission-mode default --tools "Read,Grep,Glob" --strict-mcp-config`.
  `--fork-session` writes the turn to a *new* session id, leaving the main
  transcript untouched.
- Follow-up turns — the same, resuming `<fork_session_id>` with no
  `--fork-session`.

The fork is **read-only**: built-in tools are limited to `Read`/`Grep`/`Glob`,
MCP servers are stripped, and it never runs in plan mode. `fork.rs` parses the
`stream-json` stdout (`text_delta` chunks → `fork-delta` events; the `result`
line → the authoritative final text) and keys a process registry by
`(session_id, comment_id)`.

**Persistence.** `thread_messages` holds *terminal* turns only (a row per finished
turn); live streaming text is frontend-only. `comments.fork_session_id` records
the comment's fork so later turns resume rather than re-fork.

**Coexistence.** A fork inherits the user's hooks, so one that called
`ExitPlanMode` would POST to `:7676`. Three guards prevent a phantom revision:
the tool restriction makes `ExitPlanMode` unavailable; the turn prompt forbids
it; and `handle_plan` ignores any POST whose `session_id` is a known fork id
(`is_known_fork_session`).

Commands: `fork_thread_send`, `get_thread`, `fork_thread_cancel`,
`fork_thread_discard`, `fork_kill_all`. Events: `fork-delta`, `fork-done`,
`fork-error`, `fork-cancelled`. Verified empirically in
`docs/protocol-verification.md` Experiment (i).

### 6.6 Agent-in-document suggestions (M4)

A Claude Code session can contribute to a live review through the HTTP bridge
(§3.5) — read the plan's block structure, then post its own edits as tracked
suggestions the reviewer accepts or rejects. `agent.rs`:

- `get_latest_plan` (`GET /v1/sessions/:id/plan`) returns the published plan and
  a flat block index.
- `agent_suggest_edit` (`POST …/suggestions`) lands a **draft `edit` comment**
  carrying an `author` (`"claude-code"`). If the target block no longer matches
  the supplied `original`, the write is rejected as a stale-block conflict.
- Feedback (`POST …/comments`) lands a draft `feedback` comment (author
  `"claude-code"`, or `"voice"` when it originates from the voice agent).
- `accept_agent_suggestion` records `agent_state = "accepted"`.

The reviewer sees these as ordinary tracked suggestions with Accept / Reject in
the margin; they emit `comments-changed`. There is no separate agent-suggestion
event.

---

## 7. Data model

### 7.1 Stable anchors and block IDs

Two parallel identifiers per parsed block:

- **Anchor** — positional, derived from heading hierarchy + paragraph index.
  Format: `A`, `A.1`, `A.1.p1`. Recomputed every parse; may shift between
  revisions if structure changes.
- **Block ID** — stable, opaque (`blk-` + hex). Embedded into the markdown as
  an HTML comment sidecar (`<!-- rl:blk-… -->`) when persisted. Survives parse
  cycles and is the join key for cross-revision diffs and comment attachment.
  Sidecar maintenance lives in `src/editor/markdown/sidecar.ts` and the Rust
  parser.

### 7.2 Persistence (SQLite)

Database file: `<app_data_dir>/redline.db`. `migrate()` is idempotent: it creates
base tables `IF NOT EXISTS` and applies additive `ALTER TABLE … ADD COLUMN`
migrations for columns added since v0.1. Current effective schema:

```
sessions(session_id PK, project_path, project_name, created_at,
         status DEFAULT 'in_review', attach_state DEFAULT 'idle')

revisions(session_id, version_number, received_at, raw_plan_markdown,
          thread_start DEFAULT 1, restored DEFAULT 0,
          PRIMARY KEY (session_id, version_number))

comments(id, session_id, version_number, type, scope, anchor_id, body,
         edit_original, edit_revised, created_at, status,
         resolution_body, resolution_version, resolution_accepted_at,
         block_id, structural_json,
         sel_char_start, sel_char_end, sel_quoted_text, sel_sub_block_id,
         fork_session_id, reopen_note, reopen_history,
         actionable DEFAULT 0, author, agent_state,
         PRIMARY KEY (session_id, id))

app_settings(key PK, value)

thread_messages(id PK, session_id, comment_id, role, body, status, created_at)

browse_threads(browse_id PK, claude_session_id)
browse_messages(id PK, browse_id, role, body, status, created_at)

voice_sessions(session_id PK, fork_session_id)

missions(mission_id PK, title, goal, status DEFAULT 'active',
         claude_session_id, tabs_json, created_at, updated_at)
mission_findings(id PK, mission_id, browse_id, source_url, source_title,
                 body, note, created_at)
mission_messages(id PK, mission_id, role, body, status, created_at)
```

`migrate()` includes one corrective migration: legacy databases declared
`comments.id` as the sole primary key (globally unique), which broke as soon as a
second session tried to allocate `c-001`. The migration rebuilds the table with
`PRIMARY KEY (session_id, id)`.

Browser tabs are **not** a table — they are frontend-persisted UUIDs (`browse_id`);
a mission's tab set is serialized into `missions.tabs_json`. Plan markdown is
stored verbatim (with sidecar IDs); section trees are reparsed on read; the live
editor document lives in Yjs + IndexedDB, not SQLite (§8).

(The database also carries `loop_*` tables for the in-progress loop orchestrator;
that feature is not yet wired — see §21.)

### 7.3 In-memory state

- `SessionStore` — sessions + revisions + comments cache backed by SQLite.
- `PendingResponses` — `session_id → tokio::oneshot::Sender<HookResponse>`. One
  entry per held POST.
- `ExpectedModes` — `session_id → SubmissionMode` set on submit, consumed on
  next `handle_plan`.
- `ClaimFlags` — `session_id → bool` for Ambient-mode "claimed for full review".
- `Settings` — current `InterceptionMode`, persisted via `app_settings`.
- PTY, fork, browse, mission, and voice process registries key their child
  `claude`/shell processes by their respective ids.

---

## 8. The editor

ProseMirror via Tiptap (`@tiptap/react`, `@tiptap/starter-kit`, table extensions),
made collaborative with **Yjs** (`yjs`, `y-prosemirror`, `y-indexeddb`,
`@tiptap/extension-collaboration`). The document model is the crown jewel: an
addressable, CRDT-backed doc that outlives crashes and is the substrate for the
document-IDE direction.

### 8.1 CRDT document (M3)

- `src/editor/yjs/planYDoc.ts` — one `Y.Doc` per revision, seeded from the plan
  markdown (`prosemirrorJSONToYDoc`) into the `PLAN_FRAGMENT` fragment, and
  persisted through `IndexeddbPersistence` (key `DB_PREFIX + revisionKey`). This
  is what makes review state survive a crash mid-round.
- The editor binds to the `Y.Doc` via the Collaboration extension in
  `src/components/PlanEditor.tsx`.

### 8.2 Track-changes as an authored suggestion layer

Track-changes are **marks inside the persisted Y.Doc**, not a base-vs-current
diff (`src/editor/suggestions.ts`):

- `rl_ins` / `rl_del` marks carry `authorId`, a `suggestionId` (`cmt:<id>:<mark>`),
  and `status: "pending"`.
- `materializeSuggestions` paints a comment's edit as pending marks;
  `rejectBlockSuggestions` removes them; accept-all serializes marks → clean
  markdown for export.

This models multi-author, individually-acceptable suggestions (reviewer edits and
agent-in-doc suggestions alike) and is the hardest original engineering in the
editor.

### 8.3 Schema, extensions, and cross-revision diff

- `src/editor/markdown/schema.ts` — ProseMirror schema with `blockId` /
  `anchorId` attributes on every block node.
- `src/editor/markdown/parser.ts` / `serializer.ts` — markdown ↔ doc, preserving
  sidecar IDs (`markdown/roundtrip.test.ts`).
- `src/editor/extensions/*` — `BlockIdAttribute`, `AnchorIdAttribute`,
  `TrackChanges`, `TrackChangesInput`, `RedlineDecorations`, aggregated by
  `planExtensions.ts`.
- `src/diff.ts` computes a `Map<AnchorId, ParagraphDiff>` between two revisions
  from rendered per-block plain text; `RedlineDecorations` colours each block
  `added | removed | modified | unchanged`. `docModel.ts` projects those diffs
  onto stable block IDs.

### 8.4 Export adapters

Export goes through format adapters on the frontend (the "format socket"):

- **Markdown** — `export_revision_markdown` strips `<!-- rl:blk-… -->` sidecars
  and writes clean markdown.
- **DOCX** — `src/editor/adapters/docx/exporter.ts` (+ `nodeToDocx.ts`) builds a
  `.docx` with the `docx` npm package and hands the bytes to
  `export_revision_docx`, which only resolves the filename, shows the save
  dialog, and writes the file. No Rust docx crate is involved.

---

## 9. The embedded browser & page agents

A tabbed web browser built on **native Tauri child webviews** — not `<iframe>`s.
`src/components/BrowserPane.tsx` creates each tab as `new Webview(win,
"browser-<id>", opts)` (`@tauri-apps/api/webview`), tracks them in a `Map`, and
mirrors the set into the backend. Native webviews mean real navigation, cookies,
and DOM access a sandboxed iframe can't provide.

**Native control commands** (`lib.rs`): `browser_navigate`, `browser_eval`,
`browser_close`, `browser_url`, `browser_eval_result`, `browser_snapshot`,
`browser_cache_snapshot`, `browser_cached_snapshot`, `browser_consume_scroll`,
`browser_can_suspend`, `browser_suspend`, `browser_set_active`, `browser_set_tabs`,
`browser_enable_gestures`, `browser_enable_autoresize`, `browser_set_view`,
`browser_install_shims`, plus `show_bookmarks_menu` / `show_view_menu` /
`prompt_text`. Suspended tabs are re-materialized on demand.

**Per-tab page agent** (`browse.rs` + `BrowserChat.tsx`): each tab has its own
headless `claude` agent spawned **per turn**:

```
claude -p "<prompt>" --output-format stream-json --include-partial-messages
  --verbose --permission-mode default
  --tools Read,Grep,Glob,WebFetch,WebSearch,Bash
  --allowedTools WebSearch WebFetch "Bash(curl -s http://127.0.0.1:7676/*)"
  --strict-mcp-config
```

The first turn is fresh; follow-ups `--resume <session_id>` (persisted in
`browse_threads`). The agent both discusses and *drives* the live tab through the
`/v1/browser/*` curl bridge (§4), and can reach the wider web with WebSearch /
WebFetch. It follows the bundled `browse` skill. Commands: `browse_send`,
`get_browse_thread`, `browse_cancel`, `browse_discard`, `browse_kill_all`. Events:
`browse-delta`, `browse-done`, `browse-error`, `browse-cancelled`, plus tab-control
`browse-wake-tab`, `browse-focus-tab`, `browse-open-tab`.

---

## 10. Research missions

An orchestrator a tier above the per-tab agents (`mission.rs` + `MissionChat.tsx`).
The user sets one **goal**; the orchestrator reads across every open tab and its
discussion, folds in the user's **pinned findings**, and synthesizes a
Drafter-ready brief.

Unlike the per-turn browse agent, the mission runs a **resumable** headless
`claude` session — one per mission, `--resume <claude_session_id>` (stored on the
`missions` row) across turns — with the same tool/allow shape as browse. It reads
the tab map, per-tab threads, and live snapshots via `/v1/browser/*`, and its goal
and pins via `/v1/mission/active` and `/v1/mission/findings`. It follows the
bundled `mission` skill.

**Findings/pins** (`mission_findings`): user-curated highlights pulled from any
tab (`browse_id`, `source_url`, `source_title`, `body`, `note`) — the mission's
spine. Chat turns persist in `mission_messages`.

Commands: `mission_create`, `mission_list`, `mission_set_goal`, `mission_delete`,
`mission_set_tabs`, `mission_get_tabs`, `mission_add_finding`,
`mission_list_findings`, `mission_remove_finding`, `mission_send`,
`get_mission_thread`, `mission_cancel`, `mission_kill_all`, `mission_set_active`.
Events: `mission-delta`, `mission-done`, `mission-error`, `mission-cancelled`. The
synthesized brief is handed to the Prompt Drafter (§11), not written to disk.

---

## 11. Prompt Drafter

A second Tiptap rich-text surface (`PromptDrafter.tsx`, `DrafterToolbar.tsx`,
`DrafterFindBar.tsx`) for turning research into the prompt or spec that seeds a
plan. It is the target of a mission's synthesis brief and a general-purpose
composing space distinct from the plan-review editor.

---

## 12. Voice, dictation, and text-to-speech

- **Voice agent** (`voice.rs` + `VoicePanel.tsx`) — a **persistent** headless
  `claude` session per plan, driven over `--input-format stream-json` (contrast
  the per-turn browse/fork agents). It forks the plan's session
  (`--resume <id> --fork-session`) on a fresh start and resumes its own fork
  thereafter; memory persists in `voice_sessions.fork_session_id`. Voice-authored
  feedback lands via the agent-in-doc path with `author = "voice"`. Commands:
  `voice_session_start`, `voice_send`, `voice_clean`, `voice_session_stop`,
  `voice_forget`, `voice_kill_all`, `voice_session_probe`. Events: `voice-delta`,
  `voice-done`, `voice-error`, `voice-ready`, `voice-exit`.
- **Dictation** (`dictation.rs`) — on-device macOS speech-to-text via
  `SFSpeechRecognizer` + `AVAudioEngine` (`#[cfg(target_os = "macos")]`).
  Commands: `dictation_start`, `dictation_stop`, `dictation_kill_all`. Events:
  `dictation-partial`, `dictation-final`, `dictation-error`.
- **TTS** (`tts.rs`) — three engines: `system` (frontend `speechSynthesis`),
  `openai` (cloud `gpt-4o-mini-tts`), and `kokoro` (Kokoro-82M, a free local ONNX
  model via a Python sidecar, `resources/kokoro_sidecar.py`, downloaded and kept
  warm on first use). Commands: `tts_get_settings`, `tts_set_settings`,
  `tts_synth`, `tts_kokoro_status`, `tts_kokoro_install`, `tts_kokoro_warm`. Event:
  `kokoro-setup`.

The `openai` TTS engine is the one place a surface may send text to a cloud
provider; `kokoro` and `system` keep it on-device.

---

## 13. Redline integration installation

Redline integrates with Claude Code through an installed **hook** and the bundled
**skills**. `HookSetupModal` ("Install Redline integration") drives both.

### 13.1 The plan-intercept hook

`install_hook` writes to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          { "type": "http", "url": "http://127.0.0.1:7676/v1/plan", "timeout": 43200 }
        ]
      }
    ]
  }
}
```

- `HOOK_TIMEOUT_SECS = 43_200` (12 hours) — matches the longest realistic review
  hold.
- It is an **HTTP hook** (`type: "http"`), not a command hook.
- The write is a JSON merge — every other key in `settings.json` is preserved.
- It also adds three `permissions.allow` rules so the spawned browse/mission
  agents can call the local bridge without a prompt:
  `Bash(curl -s http://127.0.0.1:7676/*)` plus single- and double-quoted variants.
- `get_hook_status` reports `installed | missing | malformed`, plus any conflicting
  `ExitPlanMode` URL.

If Claude Code is running but Redline isn't, the hook fails to connect and Claude
proceeds silently (verified empirically; see `docs/protocol-verification.md`). The
user must launch Redline (or set the mode to Paused) for the hook to behave as
designed.

### 13.2 The bundled skills

`install_skill` writes the review-protocol skill to
`~/.claude/skills/redline/SKILL.md`. The canonical sources live under `skills/` in
the repo (`redline`, `browse`, `mission`, `sidecar`), mirrored to
`.claude/skills/` and `.agents/skills/`; `skill.rs` embeds the `redline` skill at
compile time with `include_str!`. `get_skill_status` reports
`installed | missing | outdated`, where `outdated` means a present `SKILL.md`
differs from the shipped version; installing overwrites it. A unit test keeps
`SKILL_VERSION` in `skill.rs` in lockstep with the `version:` frontmatter.

The `redline` skill teaches the plan-revision contract: presentation-aware plan
markdown (never raw HTML), `<!-- rl:blk-… -->` sidecar preservation, the
`REDLINE_RESOLUTIONS` block, the `[edit]`/`[feedback]`/`[question]` payload
semantics with Ask vs Revise, and fork-thread etiquette. It **enriches** the
contract — the `feedback.rs` payload (§6, §17) stays fully self-contained and is
the reliable fallback when the skill is absent. The `browse`, `mission`, and
`sidecar` skills govern the corresponding agent surfaces.

---

## 14. Tauri command & event surface

### 14.1 Commands (frontend → backend)

Registered in `generate_handler!` (`lib.rs`). Grouped by area:

- **Plan review** — `list_sessions`, `get_session`, `delete_session`,
  `add_comment`, `update_comment`, `delete_comment`, `submit_review`,
  `approve_plan`, `accept_resolution`, `reopen_resolution`, `attach_discussion`,
  `claim_review`, `arm_restore`, `show_main_window`
- **Export** — `export_revision_markdown`, `export_revision_docx`
- **Agent-in-doc** — `get_latest_plan`, `agent_suggest_edit`,
  `accept_agent_suggestion`
- **Modes / daemon** — `get_interception_mode`, `set_interception_mode`,
  `get_daemon_status`
- **Setup** — `get_hook_status`, `install_hook`, `get_skill_status`,
  `install_skill`
- **Terminals** — `pty_spawn`, `pty_ack`, `pty_write`, `pty_resize`, `pty_kill`,
  `pty_kill_all`, `pty_cwd`
- **Filesystem** — `list_dir`, `read_text_file`, `read_file_base64`,
  `save_text_file`, `ensure_dir`, `home_dir`; `open_doc`, `doc_lines`
  (highlighting); `watch_dir`, `unwatch_dir`
- **Fork threads** — `fork_thread_send`, `get_thread`, `fork_thread_cancel`,
  `fork_thread_discard`, `fork_kill_all`
- **Browse** — `browse_send`, `get_browse_thread`, `browse_cancel`,
  `browse_discard`, `browse_kill_all`
- **Mission** — `mission_create`, `mission_list`, `mission_set_goal`,
  `mission_delete`, `mission_set_tabs`, `mission_get_tabs`, `mission_add_finding`,
  `mission_list_findings`, `mission_remove_finding`, `mission_send`,
  `get_mission_thread`, `mission_cancel`, `mission_kill_all`, `mission_set_active`
- **Voice / TTS / dictation** — `voice_session_start`, `voice_send`,
  `voice_clean`, `voice_session_stop`, `voice_forget`, `voice_kill_all`,
  `voice_session_probe`; `tts_get_settings`, `tts_set_settings`, `tts_synth`,
  `tts_kokoro_status`, `tts_kokoro_install`, `tts_kokoro_warm`;
  `dictation_start`, `dictation_stop`, `dictation_kill_all`
- **Native browser** — `browser_navigate`, `browser_eval`, `browser_close`,
  `browser_url`, `browser_eval_result`, `browser_snapshot`,
  `browser_cache_snapshot`, `browser_cached_snapshot`, `browser_consume_scroll`,
  `browser_can_suspend`, `browser_suspend`, `browser_set_active`,
  `browser_set_tabs`, `browser_enable_gestures`, `browser_enable_autoresize`,
  `browser_set_view`, `browser_install_shims`, `show_bookmarks_menu`,
  `show_view_menu`, `prompt_text`

### 14.2 Events (backend → frontend)

| Area | Events |
|---|---|
| Plan / review | `plan-received`, `plan-decision-window`, `mode-changed`, `session-status-changed`, `session-detached`, `comments-changed`, `daemon-bind-failed` |
| Fork threads | `fork-delta`, `fork-done`, `fork-error`, `fork-cancelled` |
| Browse | `browse-delta`, `browse-done`, `browse-error`, `browse-cancelled`, `browse-wake-tab`, `browse-focus-tab`, `browse-open-tab` |
| Mission | `mission-delta`, `mission-done`, `mission-error`, `mission-cancelled` |
| Voice | `voice-delta`, `voice-done`, `voice-error`, `voice-ready`, `voice-exit` |
| Dictation / TTS | `dictation-partial`, `dictation-final`, `dictation-error`, `kokoro-setup` |
| Filesystem / menus | `fs-change`, `bookmark-menu-action`, `view-menu-action`, `menu-close-tab` |
| Terminal | `pty-exit` |

**Note:** PTY *output* is not a Tauri event — it streams over a per-terminal
`tauri::ipc::Channel` of raw bytes (one subscriber per tab). Only `pty-exit` is an
emitted event.

---

## 15. The embedded terminal

`pty.rs` + `src/components/Terminal*.tsx` + xterm.js.

- One PTY per tab, spawned with `portable-pty`. Shell selection:
  `$SHELL` → fallback `/bin/zsh`. `TERM=xterm-256color`.
- New tabs inherit the cwd of the most recently active PTY child via `pty_cwd`.
- PTY output streams over a per-tab `Channel` (raw bytes); xterm.js writes it.
  `pty_ack` provides backpressure. Closing a tab kills the shell; quitting calls
  `pty_kill_all`.
- The terminal is the intended home for `claude` itself, which is why
  session-delete is blocked while a POST is held.

The terminal collapses into a peek strip in the footer when not needed; the
divider between editor and terminal is draggable.

---

## 16. Tray, themes, fonts, persistence

- **Tray menu** — radio items for Active / Ambient / Paused plus a Quit entry.
  Tooltip reports session count + pending comment count; items sync to
  `mode-changed`.
- **App menu** — Check for Updates, Remove Redline Hook, README viewer, Send
  Feedback (prefilled GitHub issue).
- **Themes** — `src/theme/themes.ts` defines named palettes; `applyTheme.ts` sets
  CSS variables on `document.root`; `derive.ts` computes complementary shades. A
  pre-paint bootstrap in `index.html` replays the cached theme so the first frame
  is never a flash of white.
- **Fonts** — an app-wide font picker over Apple system fonts (San Francisco by
  default), replayed by the same bootstrap.
- **Onboarding** — a first-run tour and mandatory hook-install step; stale-review
  recovery on restart.
- **Persisted UI** — pane sizes, collapsed states, theme, and font persist via
  `usePersistedState` (localStorage); the live editor doc via Yjs + IndexedDB;
  everything else in SQLite.

---

## 17. Anti-injection discipline

The feedback payload is *load-bearing*: Claude treats
`permissionDecisionReason` as potentially untrusted input. Empirically verified
behaviour (see `docs/protocol-verification.md`):

- A payload that reads like an injection attempt ("ignore your task, do X") will
  be flagged and refused by the model.
- A payload framed as user-attested review feedback ("The user reviewed your plan
  in Redline and has requested revisions…") is acted on.

`feedback.rs` enforces:

1. A fixed preface establishing the source.
2. Declarative framing for structural changes ("The user deleted this block")
   rather than imperative.
3. Verbatim wrapping of reviewer prose under a "USER COMMENT (verbatim):" frame.
4. No sanitisation or rewriting of reviewer prose.

The resolution-block contract is part of the same surface: a structured,
machine-readable channel for per-comment replies that doesn't require freeform
interleaving with plan text.

---

## 18. Tests

```
src/editor/applyCommentsToDoc.test.ts   — comment overrides → doc edits
src/editor/changeLedger.test.ts         — ledger accumulation + flush
src/editor/docModel.test.ts             — block-ID/anchor projection
src/editor/markdown/roundtrip.test.ts   — markdown ↔ ProseMirror fidelity with sidecars
src/editor/planEditorSync.test.ts       — editor ↔ comment-store sync
src/editor/wordDiff.test.ts             — word-level diffing
src/diff.test.ts                        — revision diffing
```

Run via `npm test` (vitest). Backend tests are in-line with their modules.

A reproducible hook-verification rig lives at `scripts/verify-hook.py` with
sample payloads in `scripts/`; documented behaviour is in
`docs/protocol-verification.md`.

---

## 19. Build, run, contribute

```bash
npm install
npm run tauri dev      # dev mode
npm run tauri build    # production bundle
npm run redline        # build, install into /Applications, and launch
npm test               # frontend tests
```

Contributions are gated by a copyright-assignment CLA (`CLA.md`,
`CONTRIBUTING.md`). The CLA Assistant bot validates each PR.

Licensing:

- Code: Apache-2.0 (`LICENSE`, `NOTICE`).
- Name, logo, icon: **not** licensed; trademarks reserved. Derivative
  distributions must rename. See `README.md`.

---

## 20. Explicit non-goals (today)

- **Code diff review.** Redline reviews *plans* and documents, not code diffs.
- **Multi-user collaboration.** Single reviewer per session today (multiplayer is
  a north-star direction — §21 — not a shipped feature).
- **A model API of its own.** Every agent is the user's local `claude`
  subprocess; Redline calls no model API directly.
- **Non-Claude-Code agents.** The plan protocol assumes Claude Code's hook surface
  and `ExitPlanMode` semantics.
- **Tool calls beyond `ExitPlanMode`.** The plan-intercept hook matcher is
  `ExitPlanMode` only.

On data egress: Redline is local-first — no account, no telemetry, the daemon
binds to `127.0.0.1`, and documents live in a local database. The only network
egress is inherent to a surface: the embedded browser, WebSearch/WebFetch used by
the browse/mission agents, and cloud TTS if the `openai` engine is selected.

---

## 21. Known gaps / roadmap

Shipped since the original v0.1 spec: DOCX export, CRDT (Yjs) persistence with
track-changes as suggestion marks, agent-in-document suggestions, the embedded
browser + page agents, research missions, the Prompt Drafter, and voice /
dictation / TTS.

Not yet built:

- **Loop orchestrator.** Turning an approved plan into parallel,
  individually-verified subtasks — each executed in an isolated git worktree and
  graded by an independent reviewer. Design + WIP code exist in the tree
  (`looporch.rs`, `worktree.rs`, the `loop_*` tables, the `loop-orchestrator`
  skill) but the engine is **not wired** — no registered commands, no UI. Treat
  as roadmap.
- **Multiplayer.** Several reviewers in one document at once, each with their own
  agent, over the CRDT (Yjs / Hocuspocus). See the north-star doc.
- **Documents beyond plans.** A born-in-app Word-class editor and, later,
  high-fidelity import of arbitrary `.docx` files behind the format-adapter socket
  (§8.4). Born-in-app `.docx` *export* ships today; arbitrary *import* does not.
- **Side-by-side revision diff view.** Diff is implicit in the editor's redline
  marks; there is no v1↔v2 split pane.
- **Search / filter on comments.**
- **Desktop notifications** and **daemon auto-start** (login-item / `launchd`).
- **Custom anchoring.** Anchors are auto-generated; no UI override.
- **Windows / Linux.** macOS only today (dictation is macOS-native).

For the strategic arc behind these, see
[docs/document-ide-northstar.md](docs/document-ide-northstar.md).
```