// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Width of the table-of-contents rail. Two snap points rather than a free
// width: long headings get room at 340 without the rail ever competing with
// the document column, and the doc scroller's reserved left padding stays in
// lockstep with whichever snap is active.
export const TOC_RAIL_W = 230;
export const TOC_RAIL_W_WIDE = 340;

/** Bounds for the transient drag width — far enough past both snap points to
 *  feel like a drag, tight enough that the rail never swallows the column. */
export const TOC_DRAG_MIN = 180;
export const TOC_DRAG_MAX = 420;

/** Which snap point a released drag lands on: past the midpoint → wide. */
export function snapTocWide(px: number): boolean {
  return px >= (TOC_RAIL_W + TOC_RAIL_W_WIDE) / 2;
}

export function clampTocDrag(px: number): number {
  return Math.max(TOC_DRAG_MIN, Math.min(TOC_DRAG_MAX, px));
}
