export type SessionId = string;
export type AnchorId = string;

export type SessionStatus = "in_review" | "approved" | "aborted";

export interface Paragraph {
  anchorId: AnchorId;
  /** Verbatim markdown source for this block — rendered faithfully by the UI. */
  markdown: string;
  /** Plain-text rendering, used for revision diffing. */
  text: string;
}

export interface Section {
  anchorId: AnchorId;
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
}

export type CommentType = "edit" | "feedback" | "question";
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

export interface Comment {
  id: string;
  type: CommentType;
  scope?: CommentScope;
  anchorId: AnchorId;
  body: string;
  edit?: EditPayload;
  createdAt: number;
  status: CommentStatus;
  resolution?: Resolution;
}

export interface NewCommentRequest {
  type: CommentType;
  scope?: CommentScope;
  anchorId: AnchorId;
  body: string;
  edit?: EditPayload;
}

export interface UpdateCommentRequest {
  body?: string;
  scope?: CommentScope;
  edit?: EditPayload;
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
}

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  matcherFound: boolean;
  conflictingUrl: string | null;
}

export interface PlanReceivedEvent {
  sessionId: SessionId;
  version: number;
  isNewSession: boolean;
  resolutionsAttached: number;
  unmatchedResolutionIds: string[];
  unresolvedSubmittedIds: string[];
  resolutionParseError: string | null;
}
