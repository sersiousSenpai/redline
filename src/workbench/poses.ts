// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Responsive poses (D18): a narrow window folds the side columns so the
// centre stays readable. Below 1100 px the rail folds to its 40 px edge;
// below 900 px the sidebar folds to its icon pose too. The user may open
// either while narrow — that opening is kept for the narrow spell and
// forgotten when the window grows past the breakpoint, where the stored
// preference applies again (so a rail left open comes back open). Nothing
// here is stored: the narrow openings are in-memory, the preference is the
// user's persisted choice and never written by a resize.

export const RAIL_FOLD_BELOW = 1100;
export const SIDEBAR_FOLD_BELOW = 900;
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
  const railNarrow = i.winWidth < RAIL_FOLD_BELOW;
  const sidebarNarrow = i.winWidth < SIDEBAR_FOLD_BELOW;
  return {
    railNarrow,
    sidebarNarrow,
    paneCollapsed: railNarrow ? !i.narrowOpen.rail : i.paneCollapsed,
    sidebarCollapsed: sidebarNarrow ? !i.narrowOpen.sidebar : i.sidebarCollapsed,
  };
}

/** The narrow openings after a width change: a column that left its narrow
 *  regime forgets being opened in it. Identity when nothing changes. */
export function settleNarrowOpen(open: NarrowOpen, winWidth: number): NarrowOpen {
  const rail = open.rail && winWidth < RAIL_FOLD_BELOW;
  const sidebar = open.sidebar && winWidth < SIDEBAR_FOLD_BELOW;
  return rail === open.rail && sidebar === open.sidebar ? open : { rail, sidebar };
}
