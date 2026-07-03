// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Which artifact the Discussion sidecar pertains to. One pane, two contexts:
//! the plan's comment threads or the code review's annotations/questions.
//! Context follows what's on screen; only a genuine split (both visible)
//! consults the user's pinned choice (the header toggle).

export type DiscussionContext = "plan" | "review";

/**
 * - Review pane closed → plan (the only context there is).
 * - Review open and the plan side unavailable (doc hidden, or a folder tab
 *   where plan comments don't apply) → review.
 * - True split (both available) → whatever the user pinned via the toggle.
 */
export function effectiveDiscussionContext(
  reviewOpen: boolean,
  planAvailable: boolean,
  pinned: DiscussionContext,
): DiscussionContext {
  if (!reviewOpen) return "plan";
  if (!planAvailable) return "review";
  return pinned;
}
