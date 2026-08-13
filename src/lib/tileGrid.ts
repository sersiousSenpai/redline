// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Pure geometry for the terminal dock's tile grid: which rows/columns N tiles
// arrange into for a given container, where every tile and gutter rests, and
// how a gutter drag redistributes space. No React, no DOM — the component owns
// the style writes, this owns the arithmetic, and everything here is testable
// as data. The tile-slot algebra (which terminal occupies which tile) lives in
// `tileSlots.ts`; this file never sees a terminal id.

import { CANONICAL_TERM_FRAC, docMinHFor } from "./paneLayout";

/** A pixel-sized container (the dock's pane area). */
export interface SizePx {
  width: number;
  height: number;
}

export interface GridShape {
  n: number;
  rows: number;
  /** Nominal columns per full row (`ceil(n / rows)`). */
  cols: number;
  /** Tiles per row, row-major; sums to n; every entry > 0. The LAST row
   *  carries the remainder — a ragged last row holds fewer, wider tiles. */
  rowCounts: number[];
}

/** One tile's resting box, all values fractions of the container (0..1). */
export interface TileRect {
  index: number;
  row: number;
  col: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Gutter {
  /** "row-1" | "col-0-2" — stable React key; a row handle is never reused as
   *  a column handle. */
  id: string;
  /** The drag axis: "y" moves a row boundary, "x" a column boundary. */
  axis: "x" | "y";
  row: number;
  col: number;
  /** Resting position along the drag axis, container fraction. */
  pos: number;
  /** The band it spans on the cross axis (a column gutter spans only its own
   *  row; a row gutter spans the full width). */
  crossStart: number;
  crossLength: number;
  /** Fraction indices it trades between (row indices for "y", column indices
   *  within `row` for "x"). */
  before: number;
  after: number;
  /** Drag clamps, already px→fraction resolved against the container. When
   *  the container can't fit both tiles' minima, both collapse to the pair's
   *  midpoint rather than emitting min > max. */
  min: number;
  max: number;
}

/** Row heights are GLOBAL; column widths are PER ROW — so a ragged last row
 *  holds fewer, wider tiles, and a row drag can never disturb columns. Every
 *  `cols[r]` has exactly `rowCounts[r]` entries summing to 1. */
export interface GridFractions {
  rows: number[];
  cols: number[][];
}

/** Persisted arrangements, keyed by `shapeKey` — n=5 and n=6 in a 2×3 have
 *  different last-row counts, so the key carries n, not just rows×cols.
 *  Switching tile count switches KEY: the old arrangement is untouched and
 *  returns verbatim when that count returns. */
export type FractionStore = Record<string, GridFractions>;

/** Tile minima, px — the gutter drag clamps. A fraction clamp is meaningless
 *  with N tiles (1/7 of a wide dock is a legitimate width). */
export const MIN_TILE_W = 360;
export const MIN_TILE_H = 180;

/** The per-tile header's height, exported so the geometry (which subtracts it
 *  when scoring what character grid a tile would get) and the header component
 *  can never disagree. */
export const TILE_HEADER_H = 26;

/** Stored arrangements kept before the oldest (insertion order) are pruned. */
export const MAX_STORED_SHAPES = 24;

/** A challenger shape must beat the current one by this factor — a 2px
 *  container change must not flip 1×4 ↔ 2×2 under the user's pointer. */
const SHAPE_HYSTERESIS = 1.08;

/** Approximate xterm cell metrics at the dock's 13px mono font. Used only to
 *  SCORE candidate shapes — precision doesn't matter, monotonicity does. */
const CELL_W = 8;
const CELL_H = 18;
/** Below this character grid a tile stops being a terminal at all. */
const MIN_COLS = 40;
const MIN_ROWS = 8;
/** Full marks at a canonical 80×24 — past that, more chars stop mattering. */
const TARGET_COLS = 80;
const TARGET_ROWS = 24;
/** Preferred tile aspect (w/h). Survives only as a tiebreaker once both
 *  candidates clear the character floors — a terminal's utility is measured
 *  in characters, not proportions. */
const ASPECT_TARGET = 1.6;

function makeShape(n: number, rows: number): GridShape | null {
  const cols = Math.ceil(n / rows);
  const last = n - (rows - 1) * cols;
  // An empty last row means fewer rows already express this shape.
  if (last < 1) return null;
  return {
    n,
    rows,
    cols,
    rowCounts: Array.from({ length: rows }, (_, r) =>
      r === rows - 1 ? last : cols,
    ),
  };
}

/** Character columns a tile would get at this shape's nominal tile width. */
function charCols(size: SizePx, shape: GridShape): number {
  return size.width / shape.cols / CELL_W;
}

/** Character rows a tile would get, after its header takes its strip. */
function charRows(size: SizePx, shape: GridShape): number {
  return (size.height / shape.rows - TILE_HEADER_H) / CELL_H;
}

/** Score a candidate shape by the character grid a tile would get, or null
 *  when a tile would fall below the usability floor. */
function scoreShape(size: SizePx, shape: GridShape): number | null {
  const c = charCols(size, shape);
  const r = charRows(size, shape);
  if (!(c >= MIN_COLS) || !(r >= MIN_ROWS)) return null;
  const usability =
    Math.min(c / TARGET_COLS, 1) * Math.min(r / TARGET_ROWS, 1);
  const tileAspect = size.width / shape.cols / (size.height / shape.rows);
  const shapeliness =
    (1 / (1 + Math.abs(Math.log(tileAspect / ASPECT_TARGET)))) ** 0.35;
  const fill = (shape.n / (shape.rows * shape.cols)) ** 0.5;
  return usability * shapeliness * fill;
}

/** The shape N tiles take in a container of `sizePx`.
 *
 *  Takes px, not an aspect ratio — aspect alone cannot express "a 260px dock
 *  physically cannot hold two rows of terminal". Every `rows = 1..n` candidate
 *  is scored by the character grid a tile would get; ties break toward fewer
 *  rows. When every candidate is rejected (tiny dock, many tiles) the fall
 *  back maximizes raw character area — this never throws and never returns an
 *  invalid shape, whatever n or size it is handed.
 *
 *  `opts.current` engages hysteresis: the incumbent shape survives unless a
 *  challenger beats it by SHAPE_HYSTERESIS, so a 2px container change can't
 *  teleport every tile. */
export function gridShapeFor(
  n: number,
  sizePx: SizePx,
  opts?: { current?: GridShape },
): GridShape {
  const count = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
  const size: SizePx = {
    width: Number.isFinite(sizePx?.width) ? Math.max(0, sizePx.width) : 0,
    height: Number.isFinite(sizePx?.height) ? Math.max(0, sizePx.height) : 0,
  };

  const candidates: GridShape[] = [];
  for (let rows = 1; rows <= count; rows++) {
    const s = makeShape(count, rows);
    if (s) candidates.push(s);
  }

  // The incumbent is re-derived from the candidate list (not trusted as
  // passed) so a stale or foreign object can never leak back out.
  const incumbent =
    opts?.current && opts.current.n === count
      ? candidates.find((s) => s.rows === opts.current?.rows)
      : undefined;

  let best: GridShape | null = null;
  let bestScore = -Infinity;
  for (const s of candidates) {
    const score = scoreShape(size, s);
    // Strictly greater: candidates arrive fewest-rows-first, so a tie keeps
    // the fewer-rows shape.
    if (score !== null && score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  if (best) {
    if (incumbent && incumbent !== best) {
      const incumbentScore = scoreShape(size, incumbent);
      if (incumbentScore !== null && bestScore <= incumbentScore * SHAPE_HYSTERESIS) {
        return incumbent;
      }
    }
    return best;
  }

  // Nothing clears the floor — maximize raw character area instead.
  let fallback = candidates[0];
  let fallbackMetric = -Infinity;
  for (const s of candidates) {
    const metric = charCols(size, s) * charRows(size, s);
    if (metric > fallbackMetric) {
      fallback = s;
      fallbackMetric = metric;
    }
  }
  if (incumbent && incumbent !== fallback) {
    const incumbentMetric = charCols(size, incumbent) * charRows(size, incumbent);
    if (incumbentMetric > 0 && fallbackMetric <= incumbentMetric * SHAPE_HYSTERESIS) {
      return incumbent;
    }
  }
  return fallback;
}

/** "5@2x3" — the FractionStore key. Carries n because n=5 and n=6 in a 2×3
 *  have different last-row counts. */
export function shapeKey(s: GridShape): string {
  return `${s.n}@${s.rows}x${s.cols}`;
}

export function evenFractions(shape: GridShape): GridFractions {
  return {
    rows: shape.rowCounts.map(() => 1 / shape.rows),
    cols: shape.rowCounts.map((k) => Array.from({ length: k }, () => 1 / k)),
  };
}

/** One axis of a stored arrangement, repaired against what the shape needs:
 *  wrong length → even; non-finite/≤0/>1 entries → the even share; then
 *  renormalized to sum 1 so surviving entries keep their ratio ([0.3, 0.3] →
 *  [0.5, 0.5]). No px clamping here — minimums are px and depend on the
 *  container, which the persisted model doesn't know; they live in the gutter
 *  clamps only. */
function repairAxis(raw: unknown, len: number): number[] {
  const even = 1 / len;
  const src = Array.isArray(raw) && raw.length === len ? raw : null;
  const vals = Array.from({ length: len }, (_, i) => {
    const v: unknown = src ? src[i] : even;
    return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1
      ? v
      : even;
  });
  const sum = vals.reduce((a, b) => a + b, 0);
  return vals.map((v) => v / sum);
}

/** Rows and each `cols[r]` repair INDEPENDENTLY — a shape whose last row
 *  gained a tile loses only that row's tuning, never the whole layout. */
export function normalizeFractions(
  shape: GridShape,
  stored: GridFractions | undefined,
): GridFractions {
  return {
    rows: repairAxis(stored?.rows, shape.rows),
    cols: shape.rowCounts.map((k, r) => repairAxis(stored?.cols?.[r], k)),
  };
}

/** Resting boxes, row-major, tiling the unit square exactly — the ragged last
 *  row STRETCHES (n=5 in a 2×3 gives it two tiles at 50%), it never leaves a
 *  hole or reads down a column. */
export function tileRects(shape: GridShape, f: GridFractions): TileRect[] {
  const rects: TileRect[] = [];
  let top = 0;
  let index = 0;
  for (let r = 0; r < shape.rows; r++) {
    const height = f.rows[r];
    let left = 0;
    for (let c = 0; c < shape.rowCounts[r]; c++) {
      const width = f.cols[r][c];
      rects.push({ index, row: r, col: c, left, top, width, height });
      index++;
      left += width;
    }
    top += height;
  }
  return rects;
}

/** Fraction the pixel minimum resolves to in this container; an unusable
 *  container (zero, NaN) resolves to Infinity, which collapses the clamp pair
 *  to its midpoint below. */
function minFrac(px: number, containerPx: number): number {
  return containerPx > 0 ? px / containerPx : Infinity;
}

function clampPair(
  pairStart: number,
  span: number,
  min: number,
): { min: number; max: number } {
  const lo = pairStart + min;
  const hi = pairStart + span - min;
  // Container too small for both minima → pin the handle at the midpoint
  // rather than emitting min > max (or NaN ordering).
  if (!(lo <= hi)) {
    const mid = pairStart + span / 2;
    return { min: mid, max: mid };
  }
  return { min: lo, max: hi };
}

/** Every draggable boundary at rest: `(rows-1)` row gutters plus
 *  `Σ(rowCounts[r]-1)` column gutters — 1 at n=2, exact parity with the old
 *  two-pane divider. */
export function gutters(
  shape: GridShape,
  f: GridFractions,
  sizePx: SizePx,
): Gutter[] {
  const out: Gutter[] = [];
  const minH = minFrac(MIN_TILE_H, sizePx.height);
  const minW = minFrac(MIN_TILE_W, sizePx.width);
  let rowStart = 0;
  for (let r = 0; r < shape.rows; r++) {
    if (r > 0) {
      const span = f.rows[r - 1] + f.rows[r];
      const pairStart = rowStart - f.rows[r - 1];
      out.push({
        id: `row-${r}`,
        axis: "y",
        row: r,
        col: 0,
        pos: rowStart,
        crossStart: 0,
        crossLength: 1,
        before: r - 1,
        after: r,
        ...clampPair(pairStart, span, minH),
      });
    }
    let colStart = 0;
    for (let c = 0; c < shape.rowCounts[r]; c++) {
      if (c > 0) {
        const span = f.cols[r][c - 1] + f.cols[r][c];
        const pairStart = colStart - f.cols[r][c - 1];
        out.push({
          id: `col-${r}-${c}`,
          axis: "x",
          row: r,
          col: c,
          pos: colStart,
          crossStart: rowStart,
          crossLength: f.rows[r],
          before: c - 1,
          after: c,
          ...clampPair(pairStart, span, minW),
        });
      }
      colStart += f.cols[r][c];
    }
    rowStart += f.rows[r];
  }
  return out;
}

/** Move gutter `g` to `pos` (clamped): the pair on either side trades space,
 *  their combined fraction is preserved exactly, and every other entry keeps
 *  its value AND identity. Immutable — never mutates `f`. */
export function resizeAt(
  _shape: GridShape,
  f: GridFractions,
  g: Gutter,
  pos: number,
): GridFractions {
  const clamped = Math.min(g.max, Math.max(g.min, pos));
  if (g.axis === "y") {
    const pairStart = f.rows.slice(0, g.before).reduce((a, b) => a + b, 0);
    const span = f.rows[g.before] + f.rows[g.after];
    const rows = f.rows.slice();
    rows[g.before] = clamped - pairStart;
    rows[g.after] = span - rows[g.before];
    return { rows, cols: f.cols };
  }
  const rowCols = f.cols[g.row].slice();
  const pairStart = rowCols.slice(0, g.before).reduce((a, b) => a + b, 0);
  const span = rowCols[g.before] + rowCols[g.after];
  rowCols[g.before] = clamped - pairStart;
  rowCols[g.after] = span - rowCols[g.before];
  const cols = f.cols.slice();
  cols[g.row] = rowCols;
  return { rows: f.rows, cols };
}

/** Double-click: even out the pair at gutter `g` (only that pair). */
export function evenAt(
  shape: GridShape,
  f: GridFractions,
  g: Gutter,
): GridFractions {
  if (g.axis === "y") {
    const pairStart = f.rows.slice(0, g.before).reduce((a, b) => a + b, 0);
    const span = f.rows[g.before] + f.rows[g.after];
    return resizeAt(shape, f, g, pairStart + span / 2);
  }
  const pairStart = f.cols[g.row]
    .slice(0, g.before)
    .reduce((a, b) => a + b, 0);
  const span = f.cols[g.row][g.before] + f.cols[g.row][g.after];
  return resizeAt(shape, f, g, pairStart + span / 2);
}

/** The dock height `n` tiles ask for. Stepwise share so the dock doesn't
 *  creep (n≤2 keeps today's canonical dock untouched), raised to the row
 *  count's floor (two passes resolve the rows↔height circularity), capped so
 *  the document keeps its own floor — and it ONLY EVER GROWS: a dock dragged
 *  taller keeps its height, and removing a tile never yanks it shorter.
 *  Shrinking is the user's job; they have a divider and a collapse caret. */
export function dockHeightForTiles(
  n: number,
  win: SizePx,
  current: number,
): number {
  const frac = n <= 2 ? CANONICAL_TERM_FRAC : n <= 4 ? 0.45 : 0.6;
  let target = Math.round(win.height * frac);
  const shape = gridShapeFor(n, { width: win.width, height: target });
  target = Math.max(target, shape.rows * MIN_TILE_H);
  target = Math.min(target, win.height - docMinHFor(win.height));
  return Math.max(current, target);
}

/** One-time lazy migration of the legacy two-pane split ratio: seeds the
 *  `2@1x2` arrangement iff it's absent and the old value is a finite number
 *  strictly inside (0,1). The legacy key itself is left in place and never
 *  written again — deleting it would make a rollback destructive for a
 *  20-byte saving. */
export function seedFromLegacyRatio(
  store: FractionStore,
  raw: unknown,
): FractionStore {
  if (store["2@1x2"]) return store;
  const r = typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(r) || r <= 0 || r >= 1) return store;
  return { ...store, "2@1x2": { rows: [1], cols: [[r, 1 - r]] } };
}

/** Insert/update one arrangement, pruning the store's OLDEST entries
 *  (insertion order) past MAX_STORED_SHAPES — never the one just written. */
export function putFractions(
  store: FractionStore,
  key: string,
  f: GridFractions,
): FractionStore {
  const next: FractionStore = { ...store, [key]: f };
  const keys = Object.keys(next).filter((k) => k !== key);
  let excess = keys.length + 1 - MAX_STORED_SHAPES;
  for (const k of keys) {
    if (excess <= 0) break;
    delete next[k];
    excess--;
  }
  return next;
}
