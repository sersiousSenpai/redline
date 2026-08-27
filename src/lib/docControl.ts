// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Does the floating document control (zoom ± and the wide-view toggle) still
// fit in the right-hand gutter, or would it sit on top of the text?
//
// Sibling of textClearance.ts, which answers the same question for the controls
// in the LEFT margin — and answers it the same way: by YIELDING, never hiding.
// The pill DOES have a smaller pose, the narrow column it stands up into in
// wide view, and a gutter too tight for the row is still roomy enough for that.
// So the answer here is never "gone". A plan document always carries its zoom
// and its line-width toggle: ⌘ +/−/0 are not discoverable, the way back out of
// wide view lives in this control, and at the pane widths this app actually
// runs at — sidebar, terminal wall and a docked discussion all taking their
// cut — the row almost never fits, so "hide when it doesn't" read as the
// controls simply being gone.
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

/** …and stacked into a column: one 22px button plus the pill's 3px padding and
 *  1px border either side. A fallback only — the live element is measured — so
 *  an approximation is enough. */
export const DOC_CTRL_COL_W = 30;

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

/** The two poses the control can take. There is deliberately no third one for
 *  "hidden": see the header. */
export type DocControlPose = "row" | "column";

/** Which pose the control should take in the room the gutter gives it.
 *
 *  Only the ROW is measured against the text — a column that still doesn't fit
 *  is shown anyway, floating over the tail of the last line rather than leaving
 *  the document with no zoom and no way out of wide view. That is the whole
 *  trade: a 30px chip in the bottom-right corner beats a missing control.
 */
export function docControlPose({
  articleRight,
  containerRight,
  padRight,
  rowWidth,
}: {
  articleRight: number;
  containerRight: number;
  padRight: number;
  /** The control's width laid out as a ROW — never the stacked measurement,
   *  which would answer a question nobody asked and oscillate (see App.tsx). */
  rowWidth: number;
}): DocControlPose {
  return docControlFits({
    articleRight,
    containerRight,
    padRight,
    controlWidth: rowWidth,
  })
    ? "row"
    : "column";
}
