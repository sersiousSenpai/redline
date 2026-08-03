// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Does the floating document control (zoom ± and the wide-view toggle) still
// fit in the right-hand gutter, or would it sit on top of the text?
//
// Sibling of textClearance.ts, which answers the same question for the controls
// in the LEFT margin. This one is a plain hide rather than a yield: the pill has
// no smaller pose to take, so it drops out and the ⌘ +/−/0 shortcuts carry on
// working without it.
//
// The subtlety is wide view. There the article runs to the pane's edges, so the
// gutter this control lives in is no longer "whatever the centred column didn't
// use" — it is exactly the article's right padding, and the control stacks into
// a narrow column to fit inside it. That has to hold for every pane width,
// because the toggle back out of wide view is IN this control: hide it and the
// mode has no exit.

/** The article's right padding, px: `pr-8` in normal view. */
export const DOC_PAD_R_NARROW = 32;

/** …and in wide view, matching `pl-16` on the other side. Sized to clear the
 *  stacked control (~30px) plus its inset and gap. */
export const DOC_PAD_R_WIDE = 64;

/** The control's distance from the pane's right edge, px. */
export const DOC_CTRL_INSET = 16;

/** Clearance the text must keep from the control before it's allowed to stay. */
export const DOC_CTRL_GAP = 12;

/** The control's width laid out as a row (− 100% + and the width toggle), used
 *  only before it has ever been measured — once hidden it is unmounted, and the
 *  "would it fit again?" question needs a width from somewhere. */
export const DOC_CTRL_ROW_W = 120;

/** All viewport-space x-coordinates, as read from bounding rects. */
export function docControlFits({
  articleRight,
  containerRight,
  padRight,
  controlWidth,
}: {
  /** The article's right edge — its box, padding included. */
  articleRight: number;
  /** The scroll container's right edge: what the control is pinned to. */
  containerRight: number;
  /** The article's right padding — empty, so the text ends this far short. */
  padRight: number;
  /** The control's measured width in its current (row or column) pose. */
  controlWidth: number;
}): boolean {
  const controlLeft = containerRight - DOC_CTRL_INSET - controlWidth;
  const textRight = articleRight - padRight;
  return textRight + DOC_CTRL_GAP <= controlLeft;
}
