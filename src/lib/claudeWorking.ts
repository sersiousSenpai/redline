// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { SessionStatus } from "../types";

export interface ClaudeWorkingInputs {
  /** A submit fired for this session and its next plan POST hasn't arrived. */
  awaitingNextPlan: boolean;
  /** A plan POST is currently held — Claude is blocked awaiting review. */
  held: boolean;
  /** The held POST detached — Claude is no longer connected to this session. */
  detached: boolean;
  sessionStatus: SessionStatus | undefined;
  submittedCount: number;
  pendingCount: number;
}

/**
 * "Claude is working" — the window between the reviewer sending feedback and
 * the revised plan coming back. Drives the footer/pane indicators and gates
 * the submit/approve buttons.
 *
 * Two signals hold it true:
 *  1. `awaitingNextPlan` — the explicit per-session lock set at submit and
 *     cleared by that session's next plan-received (or detach) event. Covers
 *     the gap before comment statuses refresh, and the re-fire race (bug #5).
 *  2. Submitted comments with nothing pending, but ONLY while the session is
 *     not held: once the next plan arrives the POST is held again, so Claude
 *     is by definition done — comments stuck at "submitted" after that
 *     (resolution mismatch, parse error) must not keep the indicator lit;
 *     the unresolved-ids warning banner owns that state instead.
 */
export function isClaudeWorking(i: ClaudeWorkingInputs): boolean {
  if (i.awaitingNextPlan) return true;
  return (
    !i.held &&
    !i.detached &&
    i.sessionStatus === "in_review" &&
    i.submittedCount > 0 &&
    i.pendingCount === 0
  );
}
