// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Should a control floating in the document's margin get out of the text's way?
//
// The plan column is centred with a max width, so on a wide pane the margins
// are empty desk and a control can sit there. Narrow the pane and the text
// column grows outward until it runs under the control — at which point the
// control has to yield. How it yields is each control's business (the Discuss
// pill hinges 90° into a vertical tab, the Contents button sheds its label and
// becomes a bare burger); WHEN it yields is this.
//
// Two thresholds, not one. A single threshold strobes whenever a divider comes
// to rest exactly on it: a pixel of pointer jitter either way flips the state,
// restarting the transition each time. The band below means a state, once
// taken, holds until the geometry has moved decisively the other way.

/** Collapse once the text closes to within this many px of the control. */
export const COLLAPSE_GAP = 12;

/** Expand again only once this much clearance is back — the extra 16px over
 *  COLLAPSE_GAP is the anti-flap band. */
export const EXPAND_GAP = 28;

/** Next state, given the current one.
 *
 *  `ctrlRight` must be the control's right edge in its EXPANDED form, and
 *  measured from layout (offsetLeft/offsetWidth) rather than from a bounding
 *  rect — a rect is polluted by any transform the collapse animation is
 *  running, and feeding that back in is how this oscillates. `textLeft` is
 *  where the text actually starts: the column's box left plus its own left
 *  padding. Same coordinate space for both, viewport being the convenient one. */
export function nextCollapsed(
  prev: boolean,
  ctrlRight: number,
  textLeft: number,
): boolean {
  const gap = textLeft - ctrlRight;
  return prev ? gap < EXPAND_GAP : gap < COLLAPSE_GAP;
}
