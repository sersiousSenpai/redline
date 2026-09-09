// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Activity, TurnMeter } from "./lib/turnMeter";

export type SessionId = string;
export type AnchorId = string;

export type SessionStatus = "in_review" | "approved" | "aborted";

export interface Paragraph {
  anchorId: AnchorId;
  /** Structure-independent identity, stable across reparse within a revision.
   *  Join key for track-changes / comments / diff; anchorId stays positional. */
  blockId: string;
  /** Verbatim markdown source for this block — rendered faithfully by the UI. */
  markdown: string;
  /** Plain-text rendering, used for revision diffing. */
  text: string;
}

export interface Section {
  anchorId: AnchorId;
  /** Structure-independent identity for the heading block (see Paragraph.blockId). */
  blockId: string;
  level: number;
  title: string;
  bodyMarkdown: string;
  children: Section[];
  paragraphs: Paragraph[];
}

export interface Revision {
  versionNumber: number;
  receivedAt: number;
  rawPlanMarkdown: string;
  sections: Section[];
  comments: Comment[];
  /** Begins a new review thread (fresh plan) rather than a revision
   *  answering feedback. Diff/comments are scoped within a thread. */
  threadStart: boolean;
  /** A restore of an already-reviewed plan (see RevisionSummary.restored). */
  restored: boolean;
}

export type CommentType =
  | "edit"
  | "feedback"
  | "question"
  | "block-insert"
  | "block-delete"
  | "block-move";

export interface StructuralPayload {
  /** "insert" | "delete" | "move". */
  op: string;
  blockId: string;
  fromAnchor?: string;
  toAnchor?: string;
  /** Inserted / deleted block body (verbatim markdown). */
  markdown?: string;
}
export type CommentScope = "local" | "structural";
export type CommentStatus =
  | "draft"
  | "submitted"
  | "resolved"
  | "accepted"
  | "reopened"
  | "withdrawn";

export interface EditPayload {
  original: string;
  revised: string;
}

export interface Resolution {
  body: string;
  appearedInVersion: number;
  acceptedAt: number | null;
}

/** One archived reopen round — the prior resolution and the note that drove it,
 *  surfaced under a collapsed "earlier rounds" trail on the card. */
export interface RoundHistoryEntry {
  resolutionBody: string;
  reopenNote?: string;
  version: number;
}

/** Character-range anchor inside a single block's plain textContent, captured
 *  at comment creation. Renders as a Word-style highlight; click-bridges
 *  the comment card and the in-doc selection. Block-relative so it piggybacks
 *  on the stable `blockId` identity (positions per-doc would drift on every
 *  transaction). `quotedText` is the self-healing fallback when offsets
 *  shift inside the block. `subBlockId` is the precision tier above offsets
 *  — `blk-X.s3.w2-w4` names the range structurally (sentence 3, words 2..4
 *  of block X) and survives any revise where the parent block's text is
 *  unchanged. Set only when the selection lands on clean unit boundaries. */
export interface CommentSelection {
  /** Inclusive, in block textContent units. */
  charStart: number;
  /** Exclusive. */
  charEnd: number;
  quotedText: string;
  subBlockId?: string;
}

/** A file the reviewer attached to a comment — a screenshot of the UI they
 *  mean, a mock, a log.
 *
 *  `path` is an ABSOLUTE local path, and that is the whole transport: the
 *  revise payload goes as plain text to the user's real Claude Code session,
 *  which has full tool access and can simply `Read` it. The file is COPIED into
 *  app data at capture time (`save_attachment` / `import_attachment`) so the
 *  path stays valid — submit can happen long after capture, and a source the
 *  user has since moved would break the payload silently. */
export interface CommentAttachment {
  path: string;
  name: string;
  /** Best-effort content type from the extension, e.g. "image/png". */
  mime: string;
  bytes: number;
}

export interface Comment {
  id: string;
  type: CommentType;
  scope?: CommentScope;
  anchorId: AnchorId;
  /** Stable join key to the plan block (D1). Set for editor-originated
   *  comments; absent for legacy / sidebar-only comments. */
  blockId?: string;
  body: string;
  edit?: EditPayload;
  structural?: StructuralPayload;
  createdAt: number;
  status: CommentStatus;
  resolution?: Resolution;
  /** Optional character-range inside the comment's block. Drives the in-doc
   *  highlight and bidirectional focus with the comment card. */
  selection?: CommentSelection;
  /** Pending follow-up attached on reopen — re-sent to Claude next Submit. */
  reopenNote?: string;
  /** Archived prior reopen rounds, oldest-first. */
  reopenHistory?: RoundHistoryEntry[];
  /** A question the reviewer promoted into a directive ("Make this a change").
   *  Flips it from answer-only to a plan driver — rendered to Claude as a
   *  [decision]. Always false/absent for non-question kinds. */
  actionable?: boolean;
  /** Agent-in-doc (M4): the agent id that proposed this comment via
   *  agent_suggest_edit. Absent for every user-originated comment. */
  author?: string;
  /** In-place resolution of a still-draft agent suggestion: "accepted" once
   *  the reviewer applied it in the editor. The comment stays draft (it keeps
   *  owning its block and rides the submit payload as a normal [edit]);
   *  this field only drives the card chip and unlocks the block. */
  agentState?: string;
  /** Human attribution for comments that arrived from another person — a
   *  live-room collaborator or an async Review Request return ("John Doe").
   *  Distinct from `author` (an AGENT id, drives the M4 block-lock); absent
   *  for every comment the session owner wrote themselves. */
  reviewer?: string;
  /** When the external reviewer actually wrote this comment (the return
   *  payload's `createdAt`) — `createdAt` above is when the import landed it
   *  here. Absent for every owner-originated comment. */
  externalCreatedAt?: number;
  /** The Review Request (share `requestId`) this comment arrived on — the
   *  back-link from an imported comment to its share. Absent unless imported. */
  shareRequestId?: string;
  /** Files the reviewer attached. Absent for every comment without one, which
   *  keeps the serialized shape identical to the pre-attachment contract.
   *  NOTE: this rides the Yjs collab mirror for free, but the mesh carries the
   *  JSON metadata only — never the files, which are local to their author. */
  attachments?: CommentAttachment[];
}

export interface NewCommentRequest {
  /** Live collab: caller-minted id so one comment keeps one identity across
   *  the mesh (collaborator format `c-{client}-{ts}`). The backend honors it
   *  when unique and it never perturbs the owner's `c-NNN` sequence. Normal
   *  frontend paths omit it. */
  id?: string;
  type: CommentType;
  scope?: CommentScope;
  anchorId: AnchorId;
  blockId?: string;
  body: string;
  edit?: EditPayload;
  structural?: StructuralPayload;
  selection?: CommentSelection;
  /** Human attribution for imported/collaborator comments (see
   *  `Comment.reviewer`). Sent by the Review Request import path and the
   *  live-collab mirror; omitted on every owner-originated comment. */
  reviewer?: string;
  /** Provenance for imported Review Request returns (see the matching fields
   *  on `Comment`); omitted on every owner-originated comment. */
  externalCreatedAt?: number;
  shareRequestId?: string;
  /** Files captured by the composer before Save (see `Comment.attachments`). */
  attachments?: CommentAttachment[];
}

export interface UpdateCommentRequest {
  body?: string;
  scope?: CommentScope;
  blockId?: string;
  edit?: EditPayload;
  structural?: StructuralPayload;
  selection?: CommentSelection;
}

/** Whether Claude Code is wired to this review right now. "held" = a hook
 *  POST is blocked waiting; "detached" = the held POST died before a decision
 *  (timeout, terminal closed, app restart) and the session needs a restore;
 *  "idle" = nothing held, nothing unresolved. Persisted backend-side so
 *  detachment survives restarts and background sessions. */
export type AttachState = "idle" | "held" | "detached";

export interface ReviewSession {
  effort?: string | null;
  sessionId: SessionId;
  projectPath: string;
  projectName: string;
  createdAt: number;
  revisions: Revision[];
  status: SessionStatus;
  attachState: AttachState;
  /** Which harness authored the plan: "claude-code" | "codex". See
   *  `SessionSummary.backend` — RESTORE branches on this. */
  backend?: string | null;
  model?: string | null;
}

/** Lightweight per-revision projection for the sidebar's revisions tree —
 *  version, timestamp, and the thread-boundary flag, without the heavy
 *  rawPlanMarkdown / sections / comments payload. */
export interface RevisionSummary {
  versionNumber: number;
  receivedAt: number;
  threadStart: boolean;
  /** True when this row is a *restore* of an already-reviewed plan (same body,
   *  re-presented via "Restore plan session"). Labeled "vN restored" and
   *  skipped when numbering subsequent genuine revisions. */
  restored: boolean;
}

export interface SessionSummary {
  sessionId: SessionId;
  projectName: string;
  projectPath: string;
  /** First `# heading` of the latest revision's plan — the session's display
   *  name. Null/absent when the plan has no heading. */
  planTitle?: string | null;
  latestVersion: number;
  /** Every revision of this session, oldest-first — drives the sidebar tree. */
  revisions: RevisionSummary[];
  createdAt: number;
  /** Last activity (revision/comment/discussion/status) — sidebar sort key. */
  updatedAt: number;
  status: SessionStatus;
  pendingCount: number;
  awaitingReview: boolean;
  /** A POST is held for this session — its terminal is active; not deletable. */
  held: boolean;
  /** The dock terminal tab whose `claude` the held POST came from — scopes the
   *  in-terminal "plan intercepted" strip to that tab. Null while not held or
   *  when the plan was intercepted from a terminal outside the dock. */
  heldTerminalId?: string | null;
  /** Persisted attach state; "detached" needs a restore before submit/approve. */
  attachState: AttachState;
  /** Orchestrated-run lifecycle (orchestrating | running | in_code_review |
   *  landed | stalled); null for plain Approves. Drives the run chip. */
  runState?: string | null;
  /** How the run actually executed — "workflow" | "sequential" — joined from
   *  the orchestrations row; null until the watcher settles it. `sequential`
   *  is a DEGRADATION (no Workflow run was found), so the sidebar chip marks
   *  it rather than letting it read as the run that was asked for. */
  runMode?: string | null;
  /** Which harness authored the plan: "claude-code" | "codex". Null/absent on
   *  every pre-backend row, and read as claude-code everywhere. RESTORE
   *  branches on it — `claude --resume` handed a Codex thread id falls back to
   *  a *fresh* session instead of erroring. */
  backend?: string | null;
  /** The model behind the latest revision, when known. */
  model?: string | null;
  effort?: string | null;
}

/** Mirrors Rust's `db::PlanRunRow` — one orchestrated run's durable record:
 *  the orchestrator's exit report (claims), the workflow script path, and the
 *  human resolution that closes the run. */
export interface PlanRun {
  planSessionId: string;
  /** The verbatim report body (JSON: {summary, subtasks:[{title, planSection,
   *  verified, skipped, notes}], ...}). Parsed by the RunReport GUI. */
  reportJson: string;
  scriptPath: string | null;
  workflowRan: boolean;
  /** resolved | needs_follow_up | abandoned; null = awaiting the human mark. */
  resolution: string | null;
  resolutionNote: string | null;
  resolvedAt: number | null;
  createdAt: number;
}

/** Mirrors Rust's `db::OrchestrationRow` — one orchestrated launch's
 *  live-monitor anchor, written at the ingest-claim beacon. Discovery fields
 *  are null until the run watcher finds them on disk. */
export interface OrchestrationRow {
  planSessionId: string;
  claudeSessionId: string;
  transcriptPath: string;
  cwd: string | null;
  startedAt: number;
  runId: string | null;
  transcriptDir: string | null;
  scriptPath: string | null;
  /** 'workflow' | 'sequential'; null until the watcher knows. */
  mode: string | null;
  /** The dock terminal tab the run was launched into (captured at launch,
   *  folded in at the ingest claim); null for pre-column rows. */
  terminalId: string | null;
  /** Joined from sessions.run_state (never stored on the row itself). */
  runState: string | null;
}

/** Mirrors Rust's `runwatch::PhaseInfo`. */
export interface RunPhase {
  title: string;
  detail: string | null;
}

/** Mirrors Rust's `runwatch::RunTotals`. */
export interface RunTotals {
  /** Upper bound from script call sites — "~N planned", not a promise. */
  plannedAgents: number | null;
  running: number;
  done: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  toolCalls: number;
  filesChanged: string[];
  /** Agents whose observed model is the seat's configured FALLBACK rather
   *  than its primary — the run kept going degraded instead of failing. */
  degraded?: number;
}

/** Mirrors Rust's `runwatch::AgentTile` — one subagent's live card. */
export interface AgentTile {
  agentId: string;
  label: string | null;
  /** "manifest" (authoritative) | "script" (heuristic) | "preview". The UI
   *  shows a `~` marker whenever this is not "manifest". */
  labelSource: string;
  phase: string | null;
  model: string | null;
  effort: string | null;
  /** The observed model is the seat's configured FALLBACK, not its primary
   *  (`--fallback-model` kicked in) — graceful degradation, surfaced. */
  degraded?: boolean;
  /** running | done | failed | cached. */
  state: string;
  startedAt: number | null;
  lastActivityAt: number | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolCalls: number;
  lastToolName: string | null;
  promptPreview: string | null;
  resultPreview: string | null;
  filesChanged: string[];
  transcriptBytes: number;
}

/** Mirrors Rust's `runwatch::ManifestInfo` — completion-time authority. */
export interface RunManifestInfo {
  status: string;
  durationMs: number | null;
  summary: string | null;
  agentCount: number | null;
  totalTokens: number | null;
  totalToolCalls: number | null;
}

/** Mirrors Rust's `runwatch::RunSnapshot` — the Orchestration Monitor's one
 *  data shape, folded live from the Workflow artifact set. */
export interface RunSnapshot {
  planSessionId: string;
  claudeSessionId: string;
  runState: string | null;
  startedAt: number;
  updatedAt: number;
  seq: number;
  /** "pending" (no Workflow launch seen yet) | "workflow" | "sequential". */
  mode: string;
  runId: string | null;
  workflowName: string | null;
  workflowDescription: string | null;
  phases: RunPhase[];
  scriptPath: string | null;
  transcriptDir: string | null;
  totals: RunTotals;
  agents: AgentTile[];
  manifest: RunManifestInfo | null;
  reportFiled: boolean;
  dirsMissing: boolean;
  /** Honest degradation trail, rendered as muted lines. */
  notes: string[];
}

/** Mirrors Rust's `work::WorkItem` — one row of the durable work graph.
 *  Provenance (`originKind`/`originId`) is a breadcrumb, never ownership;
 *  `projectPath` is a filterable facet. */
export interface WorkItem {
  id: string;
  title: string;
  body: string | null;
  /** open | claimed | closed | held. */
  status: string;
  /** P0-style: 0 = drop everything, larger = calmer; 2 = normal. */
  priority: number;
  /** task | bug | question | message. */
  kind: string;
  assignee: string | null;
  claimedAt: number | null;
  leaseExpiresAt: number | null;
  closedAt: number | null;
  closeReason: string | null;
  deferUntil: number | null;
  originKind: string | null;
  originId: string | null;
  projectPath: string | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Mirrors Rust's `work::WorkEdge` — one typed edge between items. */
export interface WorkEdge {
  fromId: string;
  toId: string;
  /** blocks | parent-child | discovered-from | relates-to | duplicates |
   *  supersedes | replies-to. */
  type: string;
  createdBy: string | null;
  createdAt: number;
}

/** Mirrors Rust's `work::WorkGraphRollup` — the `get_work_graph` command's
 *  one read: every non-closed item, deduped edges, and the unfiltered ready
 *  frontier's ids. Read-only: the graph is consumed by agents over the
 *  routes; this shape only makes it visible. */
export interface WorkGraph {
  items: WorkItem[];
  edges: WorkEdge[];
  readyIds: string[];
}

/** One event from `orchestration_agent_tail` (thinking elided). */
export type AgentTailEvent =
  | { kind: "text"; text: string }
  | { kind: "toolUse"; name: string; summary: string }
  | { kind: "toolResult"; summary: string };

/** Mirrors Rust's `runwatch::AgentTailResult`. */
export interface AgentTailResult {
  events: AgentTailEvent[];
  nextCursor: number;
  truncated: boolean;
}

/** One entry in a directory listing from the `list_dir` command. `path` is
 *  absolute so the file tree can recurse without rebuilding it. */
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** A file's contents from `read_text_file`. Exactly one of `content` /
 *  `isBinary` / `tooLarge` carries the answer: text files set `content`;
 *  binaries and oversized files set their flag with no content. */
export interface FileContent {
  content: string | null;
  isBinary: boolean;
  tooLarge: boolean;
  size: number;
}

/** A file's raw bytes from `read_file_base64`, base64-encoded for a data URL.
 *  `data` is null when the file exceeded the size cap (`tooLarge`). */
export interface BinaryFile {
  data: string | null;
  tooLarge: boolean;
  size: number;
}

/** Metadata for a document opened in the viewer (`open_doc`). Tokenization
 *  happens in Rust off the UI thread, before lines are returned, so the viewer
 *  never shows an uncolored frame. */
export interface DocMeta {
  lineCount: number;
  /** Tokens can be produced for this doc (text, within the highlight size cap),
   *  so `open_doc`/`doc_lines` return colored lines. False for too-large / binary
   *  docs (and a doc whose grammar simply doesn't exist pages plain text). */
  highlightable: boolean;
  tooLarge: boolean;
  isBinary: boolean;
  size: number;
}

/** One colored run within a line. `c` is a highlight.js class (absent = plain). */
export interface HlToken {
  c?: string;
  t: string;
}

/** One line from `doc_lines`: `tokens` when highlighted, else raw `text`. */
export interface DocLine {
  tokens?: HlToken[];
  text?: string;
}

/** `open_doc` result: metadata, plus — for normal-sized docs (≤ the backend's
 *  inline cap) — every line inline so the viewer paints in one round-trip with no
 *  blank frame. `lines` is absent for docs the viewer pages via `doc_lines`
 *  (huge files) and for binary / too-large docs. */
export interface DocOpen {
  meta: DocMeta;
  lines?: DocLine[];
}

/** A project folder opened in the explorer, shown as a sidebar tab. `id` is
 *  stable for the session; `path` is the absolute folder, `name` its basename. */
export interface FolderTab {
  id: string;
  path: string;
  name: string;
}

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  matcherFound: boolean;
  conflictingUrl: string | null;
}

/** How far the daemon's bind of 127.0.0.1:7676 has got.
 *
 *  Three states, not a boolean, because the boolean conflated "we have not
 *  tried yet" with "another process owns the port" — which is why the shell
 *  defaulted it to `true` and nothing could legitimately *wait* for
 *  readiness. Rendering ignores this; a launch awaits `"ready"`. */
export type DaemonState = "starting" | "ready" | "failed";

/** Everything the shell needs for its first actionable frame, in one
 *  consistent snapshot (`bootstrap_state`).
 *
 *  Split by QUESTION, not by cost: what lands here decides which surface
 *  renders and what is on it. Whether a *launch* will work — hooks, skills,
 *  binaries, curl — has a later deadline and lives in `preflight_status`,
 *  behind `lib/integrationHealth`. */
export interface BootstrapState {
  sessions: SessionSummary[];
  /** The one session Claude is paused mid-run on, if any. Picked from the
   *  `sessions` above, so routing to it can never miss. */
  heldSessionId: SessionId | null;
  mode: InterceptionMode;
  daemon: DaemonState;
  /** Raw `~/.redline/workspace.json`, or null. */
  workspace: string | null;
  harnessFlavor: string | null;
  harnesses: { id: string; json: string }[];
}

export interface CodexHookStatus {
  available: boolean;
  installed: boolean;
  hooksPath: string;
  stopFound: boolean;
  promptCaptureFound: boolean;
}

export interface SkillStatus {
  /** The skill file exists and matches the version Redline ships. */
  installed: boolean;
  /** Absolute path to ~/.claude/skills/redline/SKILL.md. */
  skillPath: string;
  /** A SKILL.md is present but its content differs from the shipped version. */
  outdated: boolean;
  /** Skill version Redline would install. */
  version: number;
}

/** "ask" = this plan is an answers-only round-trip; the body is unchanged
 *  and no new revision was created. "revise" = a normal new revision. */
export type PlanSubmissionMode = "ask" | "revise";

export interface PlanReceivedEvent {
  sessionId: SessionId;
  version: number;
  isNewSession: boolean;
  threadStart: boolean;
  resolutionsAttached: number;
  unmatchedResolutionIds: string[];
  unresolvedSubmittedIds: string[];
  resolutionParseError: string | null;
  mode: PlanSubmissionMode;
  /** Present (true) only when the user submitted an Ask batch but Claude
   *  returned a modified plan body anyway. Surface a warning banner. */
  askModeViolated?: boolean;
  /** This plan is a "Restore plan session" re-presentation (identical body) —
   *  drafts from before the detach were carried onto it; nudge the reviewer. */
  restored: boolean;
}

export type InterceptionMode = "active" | "ambient" | "paused";

export interface ModeEvent {
  mode: InterceptionMode;
}

export interface PlanDecisionWindowEvent {
  sessionId: SessionId;
  version: number;
  /** Absolute epoch-millis after which Ambient mode auto-approves. */
  deadlineMs: number;
  windowSecs: number;
}

/** One persisted turn in a comment's fork-agent discussion thread. Rows are
 *  terminal — written only when a turn finishes — so `status` is "complete"
 *  or "error". Live streaming text is frontend-only state. */
export interface ThreadMessage {
  id: string;
  sessionId: SessionId;
  commentId: string;
  /** "user" | "assistant". */
  role: string;
  body: string;
  /** "complete" | "error". */
  status: string;
  createdAt: number;
  /** Files the reviewer dropped into this follow-up. Always absent on
   *  assistant turns. */
  attachments?: CommentAttachment[];
}

// --- Shared turn contract (mirrors src-tauri/src/turn.rs) --------------------

/** One send waiting behind an in-flight turn. */
export interface QueuedTurn {
  messageId: string;
  text: string;
  queuedAt: number;
}

/** What a `*_send` resolves to: the turn started now, or queued behind the
 *  in-flight one. `messageId` is the persisted user row either way — the
 *  optimistic bubble reconciles onto it. */
export interface SendOutcome {
  started: boolean;
  queued: boolean;
  messageId: string;
}

/** What a remounting chat panel learns from a `*_turn_status` probe: whether a
 *  turn is streaming, since when, the reply text streamed so far, and how many
 *  deltas that text folds in (`seq`). The frontend drops any delta event with
 *  `seq <=` this watermark — the backend appends before it emits, so the
 *  probed text plus the surviving deltas is exactly the full stream. */
export interface TurnStatus {
  streaming: boolean;
  startedAt: number | null;
  partial: string | null;
  seq: number;
  queued: QueuedTurn[];
  /** What the in-flight turn has spent (`turn::TurnStatus.meter`). Null when
   *  idle or when nothing has been observed yet; OPTIONAL because a probe
   *  answered by an older backend build genuinely carries neither field, and
   *  the reducer already reads both defensively. */
  meter?: TurnMeter | null;
  /** The turn's activity ring — what it was doing while you waited. */
  activity?: Activity[];
}

// The `fork-*` wire payloads, mirroring `fork.rs`'s ForkDelta / ForkDone /
// ForkError / ForkCancelled. Since T3.2–T3.4 no component subscribes to these
// directly — `useAgentTurn` reads them structurally through its own
// DeltaPayload/DonePayload/ErrorPayload — so these stay as the TypeScript
// record of the contract the Rust side emits, and as the reference when a new
// field lands on it.

/** A chunk of streaming assistant text for a comment's fork thread. */
export interface ForkDeltaEvent {
  sessionId: SessionId;
  commentId: string;
  text: string;
  /** This delta's position in the turn's stream (see `TurnStatus.seq`). */
  seq: number;
}

/** A fork turn finished — `body` is the authoritative full reply. */
export interface ForkDoneEvent {
  sessionId: SessionId;
  commentId: string;
  messageId: string;
  body: string;
}

/** A fork turn failed; `error` is also persisted as a terminal message. */
export interface ForkErrorEvent {
  sessionId: SessionId;
  commentId: string;
  error: string;
}

/** A fork turn was cancelled — nothing was persisted for it. */
export interface ForkCancelledEvent {
  sessionId: SessionId;
  commentId: string;
}

/** One persisted turn in a browser tab's browse-agent discussion thread.
 *  Scoped to a per-tab `browseId` rather than a plan session/comment. Terminal
 *  rows only (status "complete" | "error"); live text is frontend-only. */
export interface BrowseMessage {
  id: string;
  browseId: string;
  /** "user" | "assistant". */
  role: string;
  body: string;
  /** "complete" | "error". */
  status: string;
  createdAt: number;
}

/** A browser tab's **working list** — the punch list built while clicking
 *  around a running dev server, then handed to Claude Code or the Drafter in
 *  one piece. Keyed on the same durable `browseId` as the tab's discussion.
 *
 *  `template` is a `ListTemplate["id"]` (src/lib/browseList.ts), stored as an
 *  opaque string so adding a template never touches Rust. Read it back through
 *  `templateFor`, which falls back rather than stranding a row. */
export interface BrowseList {
  browseId: string;
  template: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

/** One line of a `BrowseList`. `kind` is the template's own vocabulary.
 *
 *  `pageUrl` / `pageTitle` are the page the item was written ON, captured at
 *  add time — a list built during a GUI walkthrough spans many screens, and
 *  the list's own provenance line (one URL, from whenever the list was started)
 *  answers the wrong question. They are nullable because rows written before
 *  this existed have no page, and because a capture can fail.
 *
 *  `locator` is the resolved pointer to the component the note is about
 *  ("Search bar"), written deterministically at add time from the highlighted
 *  element and then refined in the background by the `browse_locator` seat.
 *  Null means the item was written without a highlight — the common case, and
 *  not a defect. */
export interface BrowseListItem {
  id: string;
  browseId: string;
  kind: string;
  body: string;
  done: boolean;
  sortIdx: number;
  pageUrl: string | null;
  pageTitle: string | null;
  locator: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A whole list in one payload — what `browse_list_get` returns. `null` from
 *  that command means "no list yet" (→ the template chooser), which is NOT the
 *  same as a list whose items are all gone. */
export interface BrowseListView {
  list: BrowseList;
  items: BrowseListItem[];
}

/** A chunk of streaming assistant text for a tab's browse thread. */
export interface BrowseDeltaEvent {
  browseId: string;
  text: string;
  /** This delta's position in the turn's stream (see `TurnStatus.seq`). */
  seq: number;
}

/** A browse turn finished — `body` is the authoritative full reply. */
export interface BrowseDoneEvent {
  browseId: string;
  messageId: string;
  body: string;
}

/** A browse turn failed; `error` is also persisted as a terminal message. */
export interface BrowseErrorEvent {
  browseId: string;
  error: string;
}

/** A browse turn was cancelled — nothing was persisted for it. */
export interface BrowseCancelledEvent {
  browseId: string;
}

/** One open browser tab, mirrored to the backend (`browser_set_tabs`) so the
 *  browse agent's `/v1/browser/tabs` registry + cross-tab routes can resolve a
 *  tab selector. Mirrors the Rust `TabInfo`. */
export interface BrowseTabInfo {
  id: string;
  label: string;
  url: string;
  title: string;
  browseId: string;
}

/** The browse agent asked to open a URL in a new tab (it can't create a native
 *  webview itself). `BrowserPane` foregrounds the new tab while keeping the
 *  discussion anchored to the conversation that opened it. */
export interface BrowseOpenTabEvent {
  url: string;
}

/** The browse agent asked to switch the user INTO an existing tab. `BrowserPane`
 *  foregrounds it and moves the discussion into its thread — a full switch, like
 *  the user clicking that tab. */
export interface BrowseFocusTabEvent {
  id: string;
}

/** The daemon needs a suspended tab's webview live to run a query/action.
 *  `BrowserPane` materializes it in the BACKGROUND — no foregrounding, no
 *  discussion-pane move (distinct from `browse-focus-tab`). */
export interface BrowseWakeTabEvent {
  id: string;
}

/** A research Mission: an orchestrator that holds one shared goal across the
 *  whole browser pane, a tier above the per-tab browse agents. Mirrors the Rust
 *  `Mission`. The orchestrator's resumable session lives backend-side. */
export interface Mission {
  missionId: string;
  title: string;
  goal: string;
  /** "active" | "archived". */
  status: string;
  createdAt: number;
  updatedAt: number;
}

/** One pin: a curated finding the user pulled into a mission. Mirrors the Rust
 *  `MissionFinding`; source fields tie it back to the tab it came from. */
export interface MissionFinding {
  id: string;
  missionId: string;
  browseId: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  body: string;
  note: string | null;
  createdAt: number;
}

/** One tab in a mission's saved workspace (mirrors the Rust `MissionTab`). `id`
 *  is informational — re-minted on reopen; `browseId` is the durable key that
 *  reattaches the tab's discussion thread. */
export interface MissionTab {
  id?: string | null;
  url: string;
  title: string;
  browseId: string;
}

/** One persisted turn in a mission's orchestrator discussion. Mirrors
 *  `BrowseMessage`, scoped to a `missionId`. */
export interface MissionMessage {
  id: string;
  missionId: string;
  /** "user" | "assistant". */
  role: string;
  body: string;
  /** "complete" | "error". */
  status: string;
  createdAt: number;
}

/** A chunk of streaming orchestrator text for a mission. */
export interface MissionDeltaEvent {
  missionId: string;
  text: string;
  /** This delta's position in the turn's stream (see `TurnStatus.seq`). */
  seq: number;
}

/** An orchestrator turn finished — `body` is the authoritative full reply. */
export interface MissionDoneEvent {
  missionId: string;
  messageId: string;
  body: string;
}

/** An orchestrator turn failed; `error` is also persisted as a terminal row. */
export interface MissionErrorEvent {
  missionId: string;
  error: string;
}

/** An orchestrator turn was cancelled — nothing was persisted for it. */
export interface MissionCancelledEvent {
  missionId: string;
}

/** A Linked discussion: ONE continuous conversation that follows the user across
 *  every browser tab (no goal, unlike a Mission). Mirrors the Rust `Linked`; the
 *  resumable session lives backend-side. */
export interface Linked {
  linkedId: string;
  title: string;
  /** "active" | "archived". */
  status: string;
  createdAt: number;
  updatedAt: number;
}

/** A Companion session — ONE global discussion that follows the user across
 *  every surface of the app. Mirrors the Rust `Companion`. */
export interface Companion {
  companionId: string;
  title: string;
  /** "active" | "archived". */
  status: string;
  createdAt: number;
  updatedAt: number;
  /** Per-conversation `--model` override on top of the `companion` seat.
   *  Absent means "the seat's own model". */
  model?: string;
  /** Per-conversation `--effort` override. Same contract as `model`. */
  effort?: string;
  /** The user renamed this chat, so the auto-titling pass leaves it alone. */
  titleIsUserSet?: boolean;
}

/** One persisted Companion turn, surface-tagged with where the user was. */
export interface CompanionMessage {
  id: string;
  companionId: string;
  /** "user" | "assistant". */
  role: string;
  body: string;
  /** "complete" | "error". */
  status: string;
  surfaceKind: string | null;
  surfaceId: string | null;
  surfaceLabel: string | null;
  createdAt: number;
}

/** A chunk of streaming Companion text. */
export interface CompanionDeltaEvent {
  companionId: string;
  text: string;
  /** This delta's position in the turn's stream (see `TurnStatus.seq`). */
  seq: number;
}

/** A Companion turn finished — `body` is the authoritative full reply. */
export interface CompanionDoneEvent {
  companionId: string;
  messageId: string;
  body: string;
}

export interface CompanionErrorEvent {
  companionId: string;
  error: string;
}

export interface CompanionCancelledEvent {
  companionId: string;
}

/** A comment anchored to a Prompt Drafter block — the drafter sidecar.
 *  Mirrors the Rust `DraftComment`; its discussion thread rides the shared
 *  `thread_messages` store keyed `(draftId, comment.id)` on `fork-*` events. */
export interface DraftComment {
  id: string;
  draftId: string;
  blockId: string | null;
  selCharStart: number | null;
  selCharEnd: number | null;
  selQuotedText: string | null;
  body: string;
  author: string | null;
  createdAt: number;
  forkSessionId: string | null;
}

/** One persisted turn in a linked discussion. Mirrors the Rust `LinkedMessage`.
 *  Each turn is tab-tagged (`tab*`) with the tab the user was on at the time, so
 *  the UI can show "on tab N — Title" per message. */
export interface LinkedMessage {
  id: string;
  linkedId: string;
  /** "user" | "assistant" | "system" (a conversion divider row). */
  role: string;
  body: string;
  /** "complete" | "error". */
  status: string;
  tabBrowseId: string | null;
  tabN: number | null;
  tabTitle: string | null;
  tabUrl: string | null;
  createdAt: number;
}

/** A chunk of streaming linked-discussion text. */
export interface LinkedDeltaEvent {
  linkedId: string;
  text: string;
  /** This delta's position in the turn's stream (see `TurnStatus.seq`). */
  seq: number;
}

/** A linked turn finished — `body` is the authoritative full reply. */
export interface LinkedDoneEvent {
  linkedId: string;
  messageId: string;
  body: string;
}

/** A linked turn failed; `error` is also persisted as a terminal row. */
export interface LinkedErrorEvent {
  linkedId: string;
  error: string;
}

/** A linked turn was cancelled — nothing was persisted for it. */
export interface LinkedCancelledEvent {
  linkedId: string;
}

// --- Memory Ask thread (mirrors src-tauri/src/memchat.rs) --------------------

/** One persisted turn in the Memory surface's Ask thread. Mirrors the Rust
 *  `MemChatMessage`; the thread id is the constant "memchat". */
export interface MemChatMessage {
  id: string;
  threadId: string;
  /** "user" | "assistant". */
  role: string;
  body: string;
  /** "complete" | "error". */
  status: string;
  createdAt: number;
}

/** A chunk of streaming Ask-agent text. */
export interface MemChatDeltaEvent {
  threadId: string;
  text: string;
  /** This delta's position in the turn's stream (see `TurnStatus.seq`). */
  seq: number;
}

/** An Ask turn finished — `body` is the authoritative full reply. */
export interface MemChatDoneEvent {
  threadId: string;
  messageId: string;
  body: string;
}

/** An Ask turn failed; `error` is also persisted as a terminal row. */
export interface MemChatErrorEvent {
  threadId: string;
  error: string;
}

/** An Ask turn was cancelled — nothing was persisted for it. */
export interface MemChatCancelledEvent {
  threadId: string;
}

// --- Code Review surface (mirrors src-tauri/src/review.rs + state.rs) --------

/** Which diff the reviewer is looking at. `vsBase`/`commitSha` carry their ref
 *  in the separate `base`/`sha` args of the `review_diff` command. */
export type DiffSource =
  | "uncommitted"
  | "staged"
  | "unstagedPlusUntracked"
  | "lastCommit"
  | "vsBase"
  | "commitSha";

export type DiffLineKind = "context" | "add" | "del";

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "binary";

/** One diff line; text carries NO leading +/-/space sign. Line numbers are
 *  per-side: added lines have no `oldLine`, deleted lines no `newLine`. */
export interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The `@@ … @@` trailer (enclosing context), possibly empty. */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: DiffFileStatus;
  binary: boolean;
  hunks: DiffHunk[];
}

/** Full-file contents for context expansion (`review_file_contents`). A side
 *  is null when it doesn't exist there (added/deleted), is binary, or the
 *  ref/path couldn't resolve. */
export interface ReviewFileContents {
  oldLines: string[] | null;
  newLines: string[] | null;
}

/** Branch names for the vsBase picker (`review_branches`). */
export interface ReviewBranches {
  local: string[];
  remote: string[];
  head: string | null;
}

/** One row of the commit picker (`review_commits`). */
export interface ReviewCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  committedAt: number;
}

/** One code-review session — the diff-review analog of a plan session.
 *  `round` increments on each Submit → agent-fix → re-review cycle. */
export interface CodeReviewSession {
  reviewId: string;
  repoPath: string;
  source: DiffSource;
  baseRef?: string;
  commitSha?: string;
  terminalId?: string;
  round: number;
  createdAt: number;
}

export type ReviewAnnotationKind = "comment" | "deletion" | "suggestion";

export type ReviewAnnotationStatus = "draft" | "submitted" | "carried" | "orphaned";

/** What an annotation anchors to: a line range, a whole file, or the whole
 *  change. File scope keeps `filePath` with zeroed lines; general also has an
 *  empty `filePath`. */
export type ReviewAnnotationScope = "line" | "file" | "general";

/** Conventional-comment labels (serializer-whitelisted). */
export type ReviewLabel =
  | "praise"
  | "nitpick"
  | "suggestion"
  | "issue"
  | "todo"
  | "question"
  | "thought"
  | "chore"
  | "note"
  | "typo"
  | "polish";

export type ReviewBlocking = "blocking" | "non-blocking" | "if-minor";

/** One annotation on a review diff. For line scope, `quotedText` (the
 *  selected lines' verbatim text) is the durable anchor that re-locates
 *  across rounds; `startLine`/`endLine` are a hint into one round's diff. */
export interface ReviewAnnotation {
  id: string;
  reviewId: string;
  round: number;
  filePath: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
  kind: ReviewAnnotationKind;
  body: string;
  suggestionReplacement?: string;
  quotedText: string;
  status: ReviewAnnotationStatus;
  resolution?: string;
  createdAt: number;
  scope: ReviewAnnotationScope;
  label?: ReviewLabel;
  blocking?: ReviewBlocking;
  /** "user" | "ai" | an external tool's source tag. */
  source: string;
}

/** An Ask-AI question about a diff selection — the reviewer's private
 *  consultation. Never serialized into the feedback payload; not carried
 *  across rounds. Its thread lives under `(reviewId, ask-NNN)`. */
export interface ReviewQuestion {
  id: string;
  reviewId: string;
  filePath: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
  quotedText: string;
  createdAt: number;
}

/** Live git state behind the review pane's status strip (`push_status`). */
/** Mirrors Rust's `hook::WorkflowAvailability` — the locally detectable ways
 *  native multi-agent workflows can be silently disabled (settings flag, env
 *  kill-switch). The plan-tier toggle is not detectable; the launch toast
 *  covers that gap. */
export interface WorkflowAvailability {
  disabledInSettings: boolean;
  disabledInEnv: boolean;
  /** Which settings file turned it off, so the warning can name it. */
  settingsSource: string | null;
  /** Always true. The run executes in `$SHELL -l`, which sources the user's
   *  rc files after Redline's environment is inherited — an
   *  `export CLAUDE_CODE_DISABLE_WORKFLOWS=1` in `~/.zshrc` is active in the
   *  run and structurally invisible here. `disabledInEnv: false` means "not
   *  in Redline's env", never "not set". */
  envUnreadable: boolean;
}

/** Mirrors Rust's `combine::CombineSource` — one plan session selected for a
 *  combination, as its Front Door pill shows it. */
export interface CombineSource {
  sessionId: string;
  planTitle: string | null;
  projectName: string;
  projectPath: string;
  versionNumber: number;
  status: string;
  runState: string | null;
  pendingCount: number;
  /** Sidecar-stripped size — what this source costs the brief. */
  bytes: number;
}

/** Mirrors Rust's `combine::CombinePreview`. `blocked` is a refusal sentence,
 *  never a truncation: silently dropping half of someone's plan and then
 *  producing a confident merge is the worst failure this flow could have. */
export interface CombinePreview {
  sources: CombineSource[];
  defaultProjectPath: string | null;
  warnings: string[];
  blocked: string | null;
  totalBytes: number;
}

/** Mirrors Rust's `combine::CombineBrief` — what gets typed, and what reaches
 *  the prompt lake. They are produced together so they can never disagree
 *  about which sources went in. */
export interface CombineBrief {
  brief: string;
  record: string;
}

/** Mirrors Rust's `hook::AllowCandidate` — an inferred build/test rule the
 *  Orchestrate modal offers, and whether the user already has it. */
export interface AllowCandidate {
  rule: string;
  present: boolean;
}

export interface GitStatus {
  /** Current branch; null = detached HEAD. */
  branch: string | null;
  headShort: string | null;
  headSubject: string | null;
  /** e.g. "origin/main"; null when the branch has no upstream (normal). */
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  remotes: string[];
  defaultRemote: string | null;
  /** The remote's default branch (from refs/remotes/<remote>/HEAD). */
  defaultBranch: string | null;
  /** "merge" | "rebase" | "cherry-pick" | "bisect" when one is underway. */
  inProgress: string | null;
  ghAvailable: boolean;
  ghAuthed: boolean;
}

export interface PrRequest {
  title: string;
  base?: string | null;
  body: string;
}

/** The `review_push` command's request. The target is the PUSH destination
 *  only — the checkout is never switched. */
export interface PushRequest {
  repo: string;
  reviewId: string;
  message: string;
  /** Files to stage; null = everything (`git add -A`). */
  paths: string[] | null;
  target: string;
  remote: string;
  setUpstream: boolean;
  createLocalBranch: boolean;
  noVerify: boolean;
  /** Push the current HEAD as-is, skipping stage + commit. */
  skipCommit: boolean;
  confirmProtected: boolean;
  pr: PrRequest | null;
}

export interface PushStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PushOutcome {
  committed: string | null;
  committedShort: string | null;
  branch: string;
  remote: string;
  /** `<remote>/<target>` — where the work is now published. */
  pushedRef: string;
  prUrl: string | null;
  prNumber: number | null;
  steps: PushStep[];
}

/** One recorded push (`review_last_push`) — backs the strip's last-push chip. */
export interface PushRecord {
  id: string;
  reviewId: string;
  repoPath: string;
  remote: string;
  branch: string;
  commitSha?: string;
  prUrl?: string;
  prNumber?: number;
  files: number;
  createdAt: number;
}

/** `review-push-log` streaming event. */
export interface PushLogEvent {
  reviewId: string;
  line: string;
}

/** The AI commit drafter's output (`ai_commit_draft`) — always editable. */
export interface CommitDraft {
  subject: string;
  body: string;
  branch: string;
  prTitle: string;
  prBody: string;
}

/** AI pre-review streaming events. */
export interface AiReviewLogEvent {
  reviewId: string;
  text: string;
}
export interface AiReviewDoneEvent {
  reviewId: string;
  added: number;
  important: number;
  nits: number;
  preExisting: number;
  /** Shadow attention-router verdict — closed vocabulary, no third tier.
   *  Informational only: recorded + shown in a banner, acted on by nothing. */
  verdict?: "auto" | "attend";
  verdictReason?: string;
  verdictSignals?: string[];
  verdictBar?: number;
  verdictCitedSeq?: number | null;
}
export interface AiReviewErrorEvent {
  reviewId: string;
  error: string;
  cancelled: boolean;
}

// --- Localhost dashboard (dev servers) -------------------------------------

/** A dev server listening right now, mapped to one of the user's repos.
 *  Mirrors `devmap::RunningServer`. */
export interface RunningServer {
  pid: number;
  /** The card's port: the lowest one this process holds. */
  port: number;
  /** Other ports the same process listens on (HMR sockets and friends). */
  extraPorts: number[];
  url: string;
  comm: string;
  args: string;
  projectPath: string;
  projectName: string;
  stack: string;
  runCommand: string;
  thumbPath: string | null;
}

/** A server we remember but that is not up right now. Mirrors
 *  `devmap::RecentServer`. */
export interface RecentServer {
  id: number;
  projectPath: string;
  projectName: string;
  port: number;
  url: string;
  stack: string;
  runCommand: string;
  lastSeenAt: number;
  thumbPath: string | null;
  /** Something else holds this port now — Run is still offered. */
  portBusy: boolean;
}

/** A listener that isn't a project's dev server. Mirrors
 *  `devmap::OtherListener`. */
export interface OtherListener {
  pid: number;
  port: number;
  comm: string;
}

/** One sweep of the machine. Mirrors `devmap::DevServerScan`. */
export interface DevServerScan {
  running: RunningServer[];
  recent: RecentServer[];
  others: OtherListener[];
}
