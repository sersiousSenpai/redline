// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Whether a toolbar still has room for its words.
//
// The conversation dock made this matter: the same panel is a ~360px column
// beside a surface and a full-width room on the plate, and a row of labelled
// actions that fits the second overflows the first — silently, off the right
// edge, which is how you lose "Close" and never find out why.
//
// Same law as the document's zoom control (`docControl.ts`) and the Discuss
// pill's stow ladder: the control YIELDS TO A SMALLER POSE, it never unmounts.
// Losing a word is recoverable; losing the button is not.

export type ToolbarPose = "full" | "compact";

/** Shed the words below this. */
export const TOOLBAR_COMPACT_AT = 420;
/** …and take them back only well above it. The gap is the whole point: a
 *  single threshold sits exactly where a compact row's own width lands, so the
 *  measurement that shrinks the row makes it fit, which grows it, which makes
 *  it overflow — a flap on every frame of a drag. */
export const TOOLBAR_FULL_AT = 460;

export function toolbarPose(width: number, prev: ToolbarPose): ToolbarPose {
  // An unmeasured element reports 0. Keep what we had rather than flashing to
  // compact for one frame on every mount.
  if (!Number.isFinite(width) || width <= 0) return prev;
  if (width < TOOLBAR_COMPACT_AT) return "compact";
  if (width >= TOOLBAR_FULL_AT) return "full";
  return prev;
}
