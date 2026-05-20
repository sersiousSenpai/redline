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

/** Character-range anchor inside a single block's plain textContent, captured
 *  at comment creation. Renders as a Word-style highlight; click-bridges
 *  the comment card and the in-doc selection. Block-relative so it piggybacks
 *  on the stable `blockId` identity (positions per-doc would drift on every
 *  transaction). `quotedText` is the self-healing fallback when offsets
 *  shift inside the block. */
export interface CommentSelection {
  /** Inclusive, in block textContent units. */
  charStart: number;
  /** Exclusive. */
  charEnd: number;
  quotedText: string;
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

export interface ReviewSession {
  sessionId: SessionId;
  projectPath: string;
  projectName: string;
  createdAt: number;
  revisions: Revision[];
  status: SessionStatus;
}

export interface SessionSummary {
  sessionId: SessionId;
  projectName: string;
  projectPath: string;
  latestVersion: number;
  createdAt: number;
  status: SessionStatus;
  pendingCount: number;
  awaitingReview: boolean;
  /** A POST is held for this session — its terminal is active; not deletable. */
  held: boolean;
}

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  matcherFound: boolean;
  conflictingUrl: string | null;
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
