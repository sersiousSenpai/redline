// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Comment, ReviewSession } from "../types";

/**
 * The session with a just-saved comment already on it — what the
 * `comments-changed` → `get_session` reload will return a beat later.
 *
 * Applied in the same tick that closes the composer, so the composer and the
 * new card swap in one frame instead of leaving a gap (or, for the first
 * comment on a revision, the pane's empty state) between them.
 *
 * Mirrors `add_comment`: the comment lands on the LATEST revision, and an id
 * the session already has is left alone — so the insert is idempotent against
 * a reload that got there first. A session the user has since switched away
 * from is returned untouched.
 */
export function withOptimisticComment(
  session: ReviewSession | null,
  sessionId: string,
  saved: Comment,
): ReviewSession | null {
  if (!session || session.sessionId !== sessionId) return session;
  const revisions = session.revisions;
  const latest = revisions[revisions.length - 1];
  if (!latest) return session;
  if (revisions.some((r) => r.comments.some((c) => c.id === saved.id))) {
    return session;
  }
  return {
    ...session,
    revisions: [
      ...revisions.slice(0, -1),
      { ...latest, comments: [...latest.comments, saved] },
    ],
  };
}
