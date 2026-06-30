// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
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
}

export interface NewCommentRequest {
  type: CommentType;
  scope?: CommentScope;
  anchorId: AnchorId;
  blockId?: string;
  body: string;
  edit?: EditPayload;
  structural?: StructuralPayload;
  selection?: CommentSelection;
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
  sessionId: SessionId;
  projectPath: string;
  projectName: string;
  createdAt: number;
  revisions: Revision[];
  status: SessionStatus;
  attachState: AttachState;
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
}

/** A chunk of streaming assistant text for a comment's fork thread. */
export interface ForkDeltaEvent {
  sessionId: SessionId;
  commentId: string;
  text: string;
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

/** A chunk of streaming assistant text for a tab's browse thread. */
export interface BrowseDeltaEvent {
  browseId: string;
  text: string;
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
