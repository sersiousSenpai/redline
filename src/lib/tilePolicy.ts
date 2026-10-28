// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// What is left of the wall's policy once placement became the workbench's
// (a terminal goes on a wall with room, else a new tab) and nothing is ever
// taken off a wall on its own: the drag-to-arrange hit test.

// ── Drag-to-arrange ───────────────────────────────────────────────────────

/** One tile's on-screen box, measured once when a drag starts. */
export interface TileBox {
  index: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The tile under a viewport point, or null over a gutter, the shelf or
 *  anywhere off the grid. Zero-size boxes (tiles hidden by a zoom) never
 *  match. */
export function tileAtPoint(
  boxes: readonly TileBox[],
  x: number,
  y: number,
): number | null {
  for (const b of boxes) {
    if (b.right <= b.left || b.bottom <= b.top) continue;
    if (x >= b.left && x < b.right && y >= b.top && y < b.bottom) return b.index;
  }
  return null;
}
