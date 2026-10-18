// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The plan panel's pose rules (PLAN C3, deviation 3: one rule for two
//! layouts). The pose is stored per session in shell/flowState.ts; this is
//! what moves it and what the stage actually paints.
//!
//! - **closed**: the conversation has the whole stage (4b, 4d).
//! - **split**: the conversation as a 440px column beside the plan (4c).
//! - **full**: what "Full screen" becomes (5a) — the plan in the centre and
//!   the conversation moved into the right panel's Chat tab, beside Feedback.
//!
//! Four rules, each a pure function with a truth table in the tests:
//!
//! 1. No plan forces `closed` — whatever was stored, there is nothing to show.
//! 2. A narrow stage (< 900px) paints `split` as `full`: a 440px column
//!    beside a plan leaves the plan no reading measure, and full keeps both
//!    one tab apart. Painted only — the stored pose comes back on widening.
//! 3. A new revision moves `closed → split`, once per revision: the plan
//!    appears when it is ready (4c), but closing it again sticks until the
//!    next version.
//! 4. Entering `full` opens Feedback when marks are waiting on an answer,
//!    and Chat otherwise (the conversation is what moved there).
//!
//! The writers below are the only callers of `setPlanPose` / `setPanelTab`
//! outside the top bar's ⌘⌥B, so every pose change goes through the rules.

import type { CSSProperties } from "react";

import { DOC_MEASURE_MIN } from "./docControl";

import {
  getFlowState,
  planPoseOf,
  setPanelTab,
  setPlanPose,
  type PanelTab,
  type PlanPose,
} from "../shell/flowState";

/** Below this stage width the split pose paints as full. */
export const NARROW_STAGE_PX = 900;

/** The conversation column's width beside the plan (4c). */
export const SPLIT_COLUMN_PX = 440;

/** The full pose's right panel (5a). */
export const FULL_PANEL_PX = 400;

/** Rules 1 and 2: the pose the stage paints. */
export function effectivePose(i: {
  stored: PlanPose;
  hasPlan: boolean;
  narrow: boolean;
}): PlanPose {
  if (!i.hasPlan) return "closed";
  if (i.narrow && i.stored === "split") return "full";
  return i.stored;
}

/** Rule 3: the pose a revision lands in, and the revision it marks as seen —
 *  or null when this revision has already had its one move. */
export function poseOnRevision(i: {
  stored: PlanPose;
  revision: number;
  /** The last revision that moved this session's pose, if any. */
  moved: number | null;
}): { pose: PlanPose; moved: number } | null {
  if (i.moved !== null && i.revision <= i.moved) return null;
  return { pose: i.stored === "closed" ? "split" : i.stored, moved: i.revision };
}

/** Rule 4: the right panel's tab after a pose change. */
export function tabOnPose(i: {
  from: PlanPose;
  to: PlanPose;
  /** Marks on the plan still waiting on an answer: unsent, or resolved and
   *  not yet accepted. */
  unresolved: number;
  tab: PanelTab;
}): PanelTab {
  if (i.to !== "full" || i.from === "full") return i.tab;
  return i.unresolved > 0 ? "feedback" : "chat";
}

// ── Writers ────────────────────────────────────────────────────────────────

/** The revision that last moved each session's pose. Memory only: after a
 *  relaunch the newest revision may open the plan once more, which is the
 *  same as arriving. */
const movedAt = new Map<string, number>();

/** Rule 3, applied: call whenever the session's latest revision is known. */
export function noteRevision(sessionId: string, revision: number): void {
  const step = poseOnRevision({
    stored: planPoseOf(sessionId),
    revision,
    moved: movedAt.get(sessionId) ?? null,
  });
  if (!step) return;
  movedAt.set(sessionId, step.moved);
  setPlanPose(sessionId, step.pose);
}

/** Move a session to `to`, carrying the panel tab with rule 4. */
export function movePose(
  sessionId: string,
  to: PlanPose,
  unresolved: number,
): void {
  const from = planPoseOf(sessionId);
  setPanelTab(tabOnPose({ from, to, unresolved, tab: getFlowState().panelTab }));
  setPlanPose(sessionId, to);
}

/** "Open in panel →", "Show plan", the inline card's Open. A narrow stage
 *  goes straight to full, which is what split would paint anyway. */
export function openPlan(sessionId: string, unresolved: number, narrow: boolean): void {
  movePose(sessionId, narrow ? "full" : "split", unresolved);
}

/** "✕ Close plan". */
export function closePlan(sessionId: string): void {
  setPlanPose(sessionId, "closed");
}

/** "⤢ Full screen", a toggle: full from split, and back beside the
 *  conversation from full. */
export function toggleFull(sessionId: string, unresolved: number): void {
  movePose(sessionId, planPoseOf(sessionId) === "full" ? "split" : "full", unresolved);
}

/** Tests only. */
export function resetFlowPoseForTests(): void {
  movedAt.clear();
}

// ── The plan column ─────────────────────────────────────────────────────────

/** The plan article's box in each pose (4c: a 680px column, 34/56 padding,
 *  set against the panel's left edge; 5a: a 720px text column, centred), as
 *  custom properties the stage sets on its root and the article reads
 *  (`FLOW_ARTICLE`): the article is App's, rendered before the stage knows
 *  its pose. The width control still wins: wide fills the panel, and a
 *  measure dragged past its minimum widens the board's column by as much. */
export function planColumnVars(
  pose: PlanPose,
  wide: boolean,
  measure: number,
): CSSProperties {
  const extra = Number.isFinite(measure) ? Math.max(0, measure - DOC_MEASURE_MIN) : 0;
  const full = pose === "full";
  // Full: a 720px TEXT column — 24px of gutter either side, so the text
  // never meets a docked contents rail, inside a 768px box.
  return {
    "--rl-plan-max": wide ? "none" : `${(full ? 768 : 680) + extra}px`,
    "--rl-plan-pt": full ? "40px" : "34px",
    "--rl-plan-px": full ? (wide ? "64px" : "24px") : "56px",
    "--rl-plan-mx": full ? "auto" : "0px",
  } as CSSProperties;
}

/** The plan article's inline box in the flow shell — the counterpart of
 *  classic's `docArticleWidth`, reading what `planColumnVars` set. Longhands
 *  only, so it never meets a classic `paddingLeft` as a shorthand. */
export const FLOW_ARTICLE: CSSProperties = {
  maxWidth: "var(--rl-plan-max, 720px)",
  paddingTop: "var(--rl-plan-pt, 40px)",
  paddingBottom: "48px",
  paddingLeft: "var(--rl-plan-px, 0px)",
  paddingRight: "var(--rl-plan-px, 0px)",
  marginLeft: "var(--rl-plan-mx, auto)",
  marginRight: "var(--rl-plan-mx, auto)",
};
