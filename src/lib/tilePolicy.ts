// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The wall's POLICY: where a terminal goes when something asks for it to be
// shown, which tile gives way, what the shelf leads with, and which quiet
// tile parks itself next. Pure, like its neighbours — `tileGrid.ts` owns the
// geometry, `tileSlots.ts` the slot algebra, `termState.ts` what each
// terminal is doing; this file decides with all three and the component
// commits the answer.
//
// One placement rule serves every automatic placement (a shelf click, App's
// "show me X", ⌘⇧J, a new terminal at the tile cap), so the wall never has
// two opinions about which tile is expendable. A drag or a menu pick is the
// user naming a tile, and bypasses it.

import { isLoud, isQuiet, type TermState } from "./termState";
import {
  gridShapeFor,
  TARGET_COLS,
  TARGET_ROWS,
  tileCharGrid,
  type SizePx,
} from "./tileGrid";

export type PlaceTarget = { kind: "add" } | { kind: "replace"; index: number };

/** Most replaceable first. `working` is not in the plan's ranking but must
 *  rank somewhere: a busy agent's tile still gives way before the tile the
 *  user is looking at, and it keeps glowing on the shelf if it does. */
export const EVICTION_ORDER: readonly TermState[] = [
  "exited",
  "idle",
  "serving",
  "held",
  "running",
  "working",
];

function evictionRank(state: TermState | undefined): number {
  const i = EVICTION_ORDER.indexOf(state ?? "idle");
  return i === -1 ? EVICTION_ORDER.length : i;
}

/** Where to show a terminal that isn't tiled. `shapeFits` (see
 *  `fitsAnotherTile`) says the grid has room for one more usable tile — then
 *  the terminal gets its own. Otherwise it replaces the QUIETEST tile that is
 *  unpinned, unfocused and not loud; ties go to the later tile (the newest
 *  arrival, rather than the head of the grid the eye reads first). The
 *  focused tile is replaced only when nothing else may be — and a pin is the
 *  user's own "keep this on the wall", so while the wall is under its tile
 *  cap (`underCap`) a pinned focused tile makes it grow past the fit rule
 *  instead. */
export function placeTarget(
  tiles: readonly string[],
  states: ReadonlyMap<string, TermState>,
  pinned: ReadonlySet<string>,
  focusIdx: number,
  shapeFits: boolean,
  underCap = false,
): PlaceTarget {
  if (shapeFits || tiles.length === 0) return { kind: "add" };
  const focus = Math.max(0, Math.min(focusIdx, tiles.length - 1));
  let best = -1;
  let bestRank = Infinity;
  for (let i = 0; i < tiles.length; i++) {
    if (i === focus || pinned.has(tiles[i])) continue;
    const state = states.get(tiles[i]);
    if (state && isLoud(state)) continue;
    const rank = evictionRank(state);
    if (rank <= bestRank) {
      best = i;
      bestRank = rank;
    }
  }
  if (best !== -1) return { kind: "replace", index: best };
  if (underCap && pinned.has(tiles[focus])) return { kind: "add" };
  return { kind: "replace", index: focus };
}

/** Whether one more tile still fits as a real terminal: the shape
 *  `gridShapeFor` would pick for `count + 1` tiles must give each one
 *  TARGET_COLS columns and TARGET_ROWS rows. A dock too short for 24 rows at
 *  ANY count is measured against the rows a single row of tiles gets
 *  instead, so a short dock can still widen into columns but never splits
 *  into slivers. `size` null (never measured) defers to the cap alone. */
export function fitsAnotherTile(
  count: number,
  size: SizePx | null,
  max: number,
): boolean {
  if (count >= max) return false;
  if (!size || size.width <= 0 || size.height <= 0) return true;
  const n = count + 1;
  const grid = tileCharGrid(gridShapeFor(n, size), size);
  const oneRow = tileCharGrid({ n: 1, rows: 1, cols: 1, rowCounts: [1] }, size);
  return grid.cols >= TARGET_COLS && grid.rows >= Math.min(TARGET_ROWS, oneRow.rows);
}

/** The shelf's order: loud first, then busy (working, running), then quiet;
 *  within a tier most-recently-evicted first (`mru`), then creation order.
 *  A just-parked terminal (`fresh`) leads for a few seconds so the chip that
 *  just left the wall is where the eye follows it. */
export function shelfOrder(
  untiled: readonly string[],
  states: ReadonlyMap<string, TermState>,
  mru: readonly string[],
  fresh: string | null,
): string[] {
  const tier = (id: string): number => {
    if (id === fresh) return -1;
    const s = states.get(id) ?? "idle";
    return isLoud(s) ? 0 : isQuiet(s) ? 2 : 1;
  };
  const recency = (id: string): number => {
    const i = mru.indexOf(id);
    return i === -1 ? Infinity : i;
  };
  // Stable: equal keys keep creation order.
  return [...untiled].sort(
    (a, b) => tier(a) - tier(b) || recency(a) - recency(b),
  );
}

// ── Parking ───────────────────────────────────────────────────────────────

/** How long a tile must stay quiet, untouched, before it parks itself. A dev
 *  server, a held plan or a dead shell has nothing to watch; an idle shell
 *  is often about to be typed in, so it gets far longer. */
export const PARK_SETTLE_MS: Partial<Record<TermState, number>> = {
  serving: 15_000,
  held: 15_000,
  exited: 15_000,
  idle: 120_000,
};

export interface ParkInput {
  tiles: readonly string[];
  states: ReadonlyMap<string, TermState>;
  pinned: ReadonlySet<string>;
  focusIdx: number;
  zoomedId: string | null;
  /** When each terminal entered its current state. */
  since: ReadonlyMap<string, number>;
  /** When each terminal was last typed in, placed, or focused away from —
   *  anything that says the user was just there. */
  touched: ReadonlyMap<string, number>;
  now: number;
}

/** The ONE tile to park now, or null. Parking takes a tile off the wall
 *  (its terminal goes to the shelf); never the focused, zoomed or a pinned
 *  tile, never the last one, and only after its settle window. Among the
 *  settled, the quietest goes first, then the longest overdue — one per call,
 *  so the grid reshapes at most once per tick. */
export function parkCandidate(p: ParkInput): number | null {
  if (p.tiles.length <= 1) return null;
  let best: number | null = null;
  let bestRank = Infinity;
  let bestOverdue = -Infinity;
  for (let i = 0; i < p.tiles.length; i++) {
    const id = p.tiles[i];
    if (i === p.focusIdx || id === p.zoomedId || p.pinned.has(id)) continue;
    const state = p.states.get(id);
    const settle = state ? PARK_SETTLE_MS[state] : undefined;
    if (!state || settle === undefined) continue;
    const quietSince = Math.max(p.since.get(id) ?? p.now, p.touched.get(id) ?? -Infinity);
    const overdue = p.now - quietSince - settle;
    if (overdue < 0) continue;
    const rank = evictionRank(state);
    if (rank < bestRank || (rank === bestRank && overdue > bestOverdue)) {
      best = i;
      bestRank = rank;
      bestOverdue = overdue;
    }
  }
  return best;
}

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
