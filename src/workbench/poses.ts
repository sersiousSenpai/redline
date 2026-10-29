// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Responsive poses (D18): a narrow window folds the side columns so the
// centre stays readable. Below 1100 px the rail folds to its 40 px edge;
// below 900 px the sidebar folds to its icon pose too — and at any width a
// column that cannot keep its hard stop beside the stage's folds (D38). The user may open
// either while narrow — that opening is kept for the narrow spell and
// forgotten when the window grows past the breakpoint, where the stored
// preference applies again (so a rail left open comes back open). Nothing
// here is stored: the narrow openings are in-memory, the preference is the
// user's persisted choice and never written by a resize.

import { DIVIDER_W, docMinFor } from "../lib/paneLayout";
import { RAIL_EDGE_W, RAIL_MIN_W, SIDEBAR_MIN_W } from "./rail";

export const RAIL_FOLD_BELOW = 1100;
export const SIDEBAR_FOLD_BELOW = 900;

/** Hard stops (D38): a column that cannot keep its minimum beside a stage at
 *  its own floor folds instead of squishing. The rail folds first, so it is
 *  measured beside the sidebar at ITS minimum; the sidebar beside the rail's
 *  edge strip. With today's minimums both answers are already the D18
 *  breakpoints' — the fit is the rule should a minimum ever grow. */
export function railFoldsAt(winWidth: number, stageMin = 0): boolean {
  return winWidth < RAIL_FOLD_BELOW || SIDEBAR_MIN_W + RAIL_MIN_W + 2 * DIVIDER_W + stageFloor(winWidth, stageMin) > winWidth;
}
export function sidebarFoldsAt(winWidth: number, stageMin = 0): boolean {
  return winWidth < SIDEBAR_FOLD_BELOW || SIDEBAR_MIN_W + RAIL_EDGE_W + 2 * DIVIDER_W + stageFloor(winWidth, stageMin) > winWidth;
}
/** The stage's floor at this window: its own, or what the tab on screen
 *  asks (D40: a split's panes at their minimums). */
function stageFloor(winWidth: number, stageMin: number): number {
  return Math.max(docMinFor(winWidth), stageMin);
}

/** The document's floor while the rail is in its narrow regime: a rail the
 *  user opens there curtains over the plan instead of squeezing it. */
export const NARROW_DOC_MIN = 560;

export interface NarrowOpen {
  rail: boolean;
  sidebar: boolean;
}

export const NO_NARROW_OPEN: NarrowOpen = { rail: false, sidebar: false };

export interface PoseInput {
  winWidth: number;
  /** The persisted preferences. */
  sidebarCollapsed: boolean;
  paneCollapsed: boolean;
  /** What the user opened while narrow. */
  narrowOpen: NarrowOpen;
  /** What the tab on screen asks of the stage (D40), past its own floor. */
  stageMin?: number;
}

export interface Pose {
  sidebarCollapsed: boolean;
  paneCollapsed: boolean;
  /** Whether each column is in its narrow regime (a toggle then edits the
   *  narrow opening, not the preference). */
  railNarrow: boolean;
  sidebarNarrow: boolean;
}

/** What the pane layout needs from the pose (`computePaneLayout`): the
 *  narrow document floor applies only while a column was opened BY HAND in
 *  its narrow regime — the default narrow pose (rail at its edge, sidebar in
 *  its icon pose) never curtains the document — and the hand-opened column
 *  is the one that curtains. */
export function narrowLayoutInputs(pose: Pose, open: NarrowOpen): { docMin?: number; overlayFirst?: "pane" | "sidebar" } {
  const rail = pose.railNarrow && open.rail && !pose.paneCollapsed;
  const sidebar = pose.sidebarNarrow && open.sidebar && !pose.sidebarCollapsed;
  if (!rail && !sidebar) return {};
  return { docMin: NARROW_DOC_MIN, overlayFirst: rail && sidebar ? undefined : rail ? "pane" : "sidebar" };
}

export function responsivePose(i: PoseInput): Pose {
  const railNarrow = railFoldsAt(i.winWidth, i.stageMin);
  const sidebarNarrow = sidebarFoldsAt(i.winWidth, i.stageMin);
  return {
    railNarrow,
    sidebarNarrow,
    paneCollapsed: railNarrow ? !i.narrowOpen.rail : i.paneCollapsed,
    sidebarCollapsed: sidebarNarrow ? !i.narrowOpen.sidebar : i.sidebarCollapsed,
  };
}

/** The narrow openings after a width change: a column that left its narrow
 *  regime forgets being opened in it. Identity when nothing changes. */
export function settleNarrowOpen(open: NarrowOpen, winWidth: number, stageMin = 0): NarrowOpen {
  const rail = open.rail && railFoldsAt(winWidth, stageMin);
  const sidebar = open.sidebar && sidebarFoldsAt(winWidth, stageMin);
  return rail === open.rail && sidebar === open.sidebar ? open : { rail, sidebar };
}
