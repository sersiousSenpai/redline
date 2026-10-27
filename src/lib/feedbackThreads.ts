// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! How the flow Feedback tab (5a) reads a revision's comments: as threads —
//! your note, Claude's reply, then Accept / Reopen / Discuss — open ones
//! first, resolved ones collapsed after them.
//!
//! Pure, so the tab's header (owned by the stage) and its body agree on the
//! counts without either rendering the other.
//!
//! **What the review reads** (`reviewScope`): while the latest version is on
//! screen, the whole current thread. A new revision starts with a clean
//! slate, and Claude's answers to last round's marks live on the version they
//! were written on; classic bridged that with an Action Items rail, and here
//! those answers lead the list as "Waiting on you". While an older version is
//! on screen, only its own comments.

import { agentLabelFor } from "./backendChoice";
import type { AnchorTarget } from "./anchorDisplay";
import type { Comment, ReviewSession, Revision } from "../types";

/** Resolved threads shown before "N more resolved". */
export const RESOLVED_PREVIEW = 3;

/** The revision the plan panel is showing; the latest when the version isn't
 *  one the session has. */
export function revisionAt(session: ReviewSession | null | undefined, version: number): Revision | null {
  const revisions = session?.revisions ?? [];
  return revisions.find((r) => r.versionNumber === version) ?? revisions[revisions.length - 1] ?? null;
}

/** Done with: accepted by the reviewer, or withdrawn. Everything else is an
 *  open thread — a note not sent yet, one Claude is answering, a reply
 *  waiting for Accept, a reopened one. */
export function isSettled(c: Comment): boolean {
  return c.status === "accepted" || c.status === "withdrawn";
}

/** Has an answer (or needs none any more): nothing is waiting on Claude or
 *  on the next Send. */
function isAnswered(c: Comment): boolean {
  return c.status === "resolved" || isSettled(c);
}

export interface FeedbackSummary {
  /** Every thread the review reads — the tab's "Feedback 16". */
  count: number;
  /** Threads still open (see `isSettled`). */
  open: number;
  /** Decisions waiting on you: answers to accept or reopen, suggestions. */
  waiting: number;
  /** Your marks the next Send carries. */
  marks: number;
  /** Every thread has Claude's answer: the header's "All resolved". */
  allResolved: boolean;
}

export function feedbackSummary(session: ReviewSession | null | undefined, version: number): FeedbackSummary {
  if (!session) return summarize([]);
  const groups = reviewGroups(session, version);
  return { ...summarize(reviewScope(session, version).flatMap((r) => r.comments)), waiting: groups.waiting.length, marks: groups.marks.length };
}

export function summarize(comments: readonly Comment[]): FeedbackSummary {
  return {
    count: comments.length,
    open: comments.filter((c) => !isSettled(c)).length,
    waiting: comments.filter((c) => c.status === "resolved" || isUndecidedSuggestion(c)).length,
    marks: comments.filter((c) => c.status === "draft" || c.status === "reopened").length,
    allResolved: comments.length > 0 && comments.every(isAnswered),
  };
}

/** A comment and the version it lives on. */
export interface Placed {
  comment: Comment;
  version: number;
}

/** The review's four piles, each in the order the marks were made. */
export interface ReviewGroups {
  /** Waiting on you: Claude's answers to accept or reopen, and an agent's
   *  suggested edit to keep or reject. */
  waiting: Placed[];
  /** Your marks: notes not sent yet and reopened threads, which ride the
   *  next Send. */
  marks: Placed[];
  /** Sent, and the agent is on them. */
  withAgent: Placed[];
  /** Accepted or withdrawn. */
  settled: Placed[];
}

/** The revisions the review reads: the current thread while the latest is
 *  on screen, else just the version shown. */
function reviewScope(session: ReviewSession, viewingVersion: number): Revision[] {
  const revisions = session.revisions;
  const latest = revisions[revisions.length - 1];
  if (!latest) return [];
  if (viewingVersion !== latest.versionNumber) {
    const shown = revisions.find((r) => r.versionNumber === viewingVersion);
    return shown ? [shown] : [latest];
  }
  let start = 0;
  revisions.forEach((r, i) => {
    if (r.threadStart) start = i;
  });
  return revisions.slice(start);
}

export function reviewGroups(session: ReviewSession, viewingVersion: number): ReviewGroups {
  const placed = reviewScope(session, viewingVersion)
    .flatMap((r) => r.comments.map((comment) => ({ comment, version: r.versionNumber })))
    .sort((a, b) => a.comment.createdAt - b.comment.createdAt);
  const groups: ReviewGroups = { waiting: [], marks: [], withAgent: [], settled: [] };
  for (const p of placed) {
    const c = p.comment;
    if (c.status === "resolved" || isUndecidedSuggestion(c)) groups.waiting.push(p);
    else if (c.status === "draft" || c.status === "reopened") groups.marks.push(p);
    else if (c.status === "submitted") groups.withAgent.push(p);
    else groups.settled.push(p);
  }
  return groups;
}

export type TypeTone = "plan" | "redline" | "build" | "muted";

/** What kind of mark it is, in classic's words and colours: an Edit (blue),
 *  Feedback (amber), a Question (green), a Question you turned into a
 *  Change request (amber), a block added, removed or moved. */
export function markType(c: Comment): { text: string; tone: TypeTone } {
  switch (c.type) {
    case "edit":
      return { text: "Edit", tone: "plan" };
    case "question":
      return c.actionable ? { text: "Change request", tone: "redline" } : { text: "Question", tone: "build" };
    case "feedback":
      return { text: c.scope === "structural" ? "Feedback · structural" : "Feedback", tone: "redline" };
    case "block-insert":
      return { text: "Block added", tone: "plan" };
    case "block-delete":
      return { text: "Block removed", tone: "plan" };
    case "block-move":
      return { text: "Block moved", tone: "plan" };
    default:
      return { text: "Note", tone: "muted" };
  }
}

/** What the anchor labeller needs from a comment: its block (a structural
 *  comment's own block when it has no other), and the selection that picks
 *  a step or a row. */
export function commentTarget(c: Comment): AnchorTarget {
  return {
    anchorId: c.anchorId,
    blockId: c.blockId ?? c.structural?.blockId ?? null,
    selection: c.selection ?? null,
  };
}

/** Open threads first, then settled ones; each in the order they were
 *  written, as the classic pane lists them (and as the board does: step 4,
 *  then releases, then §4). */
export function orderFeedback(comments: readonly Comment[]): { open: Comment[]; settled: Comment[] } {
  const sorted = [...comments].sort((a, b) => a.createdAt - b.createdAt);
  return { open: sorted.filter((c) => !isSettled(c)), settled: sorted.filter(isSettled) };
}

/** Said by voice: the voice agent writes every comment it captures with
 *  this author (voice.rs `VOICE_AGENT_ID`). */
export function isVoiceNote(c: Comment): boolean {
  return c.author === "voice";
}

/** An agent's suggested edit nobody has decided on yet (M4). */
export function isUndecidedSuggestion(c: Comment): boolean {
  return !!c.author && !isVoiceNote(c) && c.type === "edit" && c.status === "draft" && !c.agentState;
}

export type StatusTone = "build" | "redline" | "muted";

/** The right end of a card's meta line: where the thread stands. */
export function statusNote(c: Comment, backend?: string | null): { text: string; tone: StatusTone } {
  const agent = agentLabelFor(backend);
  switch (c.status) {
    case "resolved":
    case "accepted":
      return {
        text: c.resolution ? `Resolved in v${c.resolution.appearedInVersion}` : "Resolved",
        tone: "build",
      };
    case "reopened":
      return { text: c.actionable ? "Change pending" : "Reopened", tone: "redline" };
    case "submitted":
      return { text: c.reopenNote ? `Follow-up with ${agent}` : `With ${agent}`, tone: "muted" };
    case "withdrawn":
      return { text: "Withdrawn", tone: "muted" };
    case "draft":
      return { text: isUndecidedSuggestion(c) ? `Suggested by ${c.author}` : "Not sent yet", tone: "muted" };
  }
}

/** The note as one line of plain words, for a collapsed card: the body, or
 *  an edit's before → after when the body is only the edit marker. */
export function noteText(c: Comment): string {
  const body = (c.body ?? "").replace(/\s+/g, " ").trim();
  if (body && body !== "(edit)") return body;
  if (c.edit) return `"${c.edit.original}" → "${c.edit.revised}"`;
  if (c.structural) return c.structural.markdown?.replace(/\s+/g, " ").trim() || `Block ${c.structural.op}`;
  return "";
}

/** Two letters for a note's author, for the margin avatar ("Imani Moore" →
 *  "IM"). An external reviewer by their name; the owner's own notes, said
 *  or typed, by the owner's name; "Me" without one. */
export function noteInitials(c: Comment, ownerName?: string | null): string {
  return initials(c.reviewer ?? ownerName ?? "") || "Me";
}

export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
