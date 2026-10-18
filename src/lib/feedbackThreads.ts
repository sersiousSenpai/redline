// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! How the flow Feedback tab (5a) reads a revision's comments: as threads —
//! your note, Claude's reply, then Accept / Reopen / Discuss — open ones
//! first, resolved ones collapsed after them.
//!
//! Pure, so the tab's header (owned by the stage) and its body agree on the
//! count and the "All resolved" line without either rendering the other.
//! The comments are the displayed revision's own — the clean-slate rule the
//! classic comment pane keeps: a new revision starts empty, and earlier
//! rounds are read on the version they were made on.

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
  /** Every thread on the revision — the tab's "Feedback 16". */
  count: number;
  /** Threads still open (see `isSettled`). */
  open: number;
  /** Every thread has Claude's answer: the header's "All resolved". */
  allResolved: boolean;
}

export function feedbackSummary(session: ReviewSession | null | undefined, version: number): FeedbackSummary {
  return summarize(revisionAt(session, version)?.comments ?? []);
}

export function summarize(comments: readonly Comment[]): FeedbackSummary {
  return {
    count: comments.length,
    open: comments.filter((c) => !isSettled(c)).length,
    allResolved: comments.length > 0 && comments.every(isAnswered),
  };
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
