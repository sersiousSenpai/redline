// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  MAX_STORED_SHAPES,
  MIN_TILE_H,
  MIN_TILE_W,
  dockHeightForTiles,
  evenAt,
  evenFractions,
  gridShapeFor,
  gutters,
  normalizeFractions,
  putFractions,
  resizeAt,
  seedFromLegacyRatio,
  shapeKey,
  tileRects,
  type GridFractions,
  type GridShape,
  type SizePx,
} from "./tileGrid";

// The three reference containers the shape tables pin. "Wide" is the docked
// dock on a 1728px window at the tile-driven heights (0.30 / 0.45 / 0.60 of a
// 970px window); "fullscreen" is the dock covering that window; "portrait" is
// a tall narrow window.
const WIDE = (n: number): SizePx => ({
  width: 1728,
  height: n <= 2 ? 291 : n <= 4 ? 437 : 582,
});
const FULLSCREEN: SizePx = { width: 1728, height: 970 };
const PORTRAIT: SizePx = { width: 900, height: 1200 };

const shape = (
  n: number,
  rows: number,
  cols: number,
  rowCounts: number[],
): GridShape => ({ n, rows, cols, rowCounts });

describe("gridShapeFor — shape tables", () => {
  it("wide dock: one row through n=4, then two ragged rows", () => {
    expect(gridShapeFor(1, WIDE(1))).toEqual(shape(1, 1, 1, [1]));
    expect(gridShapeFor(2, WIDE(2))).toEqual(shape(2, 1, 2, [2]));
    expect(gridShapeFor(3, WIDE(3))).toEqual(shape(3, 1, 3, [3]));
    expect(gridShapeFor(4, WIDE(4))).toEqual(shape(4, 1, 4, [4]));
    expect(gridShapeFor(5, WIDE(5))).toEqual(shape(5, 2, 3, [3, 2]));
    expect(gridShapeFor(6, WIDE(6))).toEqual(shape(6, 2, 3, [3, 3]));
    expect(gridShapeFor(7, WIDE(7))).toEqual(shape(7, 2, 4, [4, 3]));
  });

  it("fullscreen 16:9: rows engage from n=3 — chars beat aspect (2x2 over 1x4)", () => {
    expect(gridShapeFor(1, FULLSCREEN)).toEqual(shape(1, 1, 1, [1]));
    expect(gridShapeFor(2, FULLSCREEN)).toEqual(shape(2, 1, 2, [2]));
    expect(gridShapeFor(3, FULLSCREEN)).toEqual(shape(3, 2, 2, [2, 1]));
    expect(gridShapeFor(4, FULLSCREEN)).toEqual(shape(4, 2, 2, [2, 2]));
    expect(gridShapeFor(5, FULLSCREEN)).toEqual(shape(5, 2, 3, [3, 2]));
    expect(gridShapeFor(6, FULLSCREEN)).toEqual(shape(6, 2, 3, [3, 3]));
    expect(gridShapeFor(7, FULLSCREEN)).toEqual(shape(7, 2, 4, [4, 3]));
  });

  it("portrait: stacks rows a wide dock would never pick", () => {
    expect(gridShapeFor(1, PORTRAIT)).toEqual(shape(1, 1, 1, [1]));
    expect(gridShapeFor(2, PORTRAIT)).toEqual(shape(2, 2, 1, [1, 1]));
    expect(gridShapeFor(3, PORTRAIT)).toEqual(shape(3, 3, 1, [1, 1, 1]));
    expect(gridShapeFor(4, PORTRAIT)).toEqual(shape(4, 2, 2, [2, 2]));
    expect(gridShapeFor(5, PORTRAIT)).toEqual(shape(5, 3, 2, [2, 2, 1]));
    expect(gridShapeFor(6, PORTRAIT)).toEqual(shape(6, 3, 2, [2, 2, 2]));
    expect(gridShapeFor(7, PORTRAIT)).toEqual(shape(7, 4, 2, [2, 2, 2, 1]));
  });
});

describe("gridShapeFor — structural invariants", () => {
  const SIZES: SizePx[] = [
    { width: 1728, height: 291 },
    { width: 1728, height: 582 },
    FULLSCREEN,
    PORTRAIT,
    { width: 400, height: 200 },
    { width: 0, height: 0 },
  ];

  it("rowCounts are positive, sum to n, and never grow down the rows — n=1..24, six containers", () => {
    for (const size of SIZES) {
      for (let n = 1; n <= 24; n++) {
        const s = gridShapeFor(n, size);
        expect(s.n).toBe(n);
        expect(s.rowCounts).toHaveLength(s.rows);
        expect(s.rowCounts.every((k) => k > 0)).toBe(true);
        expect(s.rowCounts.reduce((a, b) => a + b, 0)).toBe(n);
        expect(s.cols).toBe(Math.ceil(n / s.rows));
        for (let r = 1; r < s.rows; r++) {
          expect(s.rowCounts[r]).toBeLessThanOrEqual(s.rowCounts[r - 1]);
        }
      }
    }
  });

  it("no hard-coded tile cap in the geometry — n=24 yields a valid shape", () => {
    const s = gridShapeFor(24, FULLSCREEN);
    expect(s.rowCounts.reduce((a, b) => a + b, 0)).toBe(24);
    expect(s.rows).toBeGreaterThan(1);
  });

  it("degrades without throwing: n=0 / -3 / NaN clamp to one tile; zero size still answers", () => {
    for (const bad of [0, -3, NaN, 2.9]) {
      const s = gridShapeFor(bad, FULLSCREEN);
      expect(s.rowCounts.reduce((a, b) => a + b, 0)).toBe(s.n);
      expect(s.rowCounts.every((k) => k > 0)).toBe(true);
    }
    expect(gridShapeFor(0, FULLSCREEN).n).toBe(1);
    expect(gridShapeFor(2.9, FULLSCREEN).n).toBe(2);
    expect(gridShapeFor(7, { width: 0, height: 0 }).n).toBe(7);
    expect(gridShapeFor(7, { width: NaN, height: NaN }).n).toBe(7);
  });

  it("hysteresis: a near-tied incumbent survives a container nudge, a foreign one doesn't", () => {
    // Fullscreen n=7 scores [4,3] and [3,3,1] within a few percent of each
    // other — exactly the flip hysteresis exists to stop.
    const incumbent = shape(7, 3, 3, [3, 3, 1]);
    expect(gridShapeFor(7, FULLSCREEN)).toEqual(shape(7, 2, 4, [4, 3]));
    expect(gridShapeFor(7, FULLSCREEN, { current: incumbent })).toEqual(
      incumbent,
    );
    // An incumbent for a different n is ignored, never leaked back out.
    expect(gridShapeFor(5, FULLSCREEN, { current: incumbent })).toEqual(
      shape(5, 2, 3, [3, 2]),
    );
    // A decisively-beaten incumbent is replaced.
    expect(
      gridShapeFor(7, WIDE(7), { current: shape(7, 7, 1, [1, 1, 1, 1, 1, 1, 1]) }),
    ).toEqual(shape(7, 2, 4, [4, 3]));
  });
});

describe("fractions and rects", () => {
  const S5 = shape(5, 2, 3, [3, 2]);

  it("shapeKey carries n — 5@2x3 and 6@2x3 are different arrangements", () => {
    expect(shapeKey(S5)).toBe("5@2x3");
    expect(shapeKey(shape(6, 2, 3, [3, 3]))).toBe("6@2x3");
  });

  it("the ragged last row STRETCHES: n=5 row 0 at 0, 1/3, 2/3; row 1 at 0, 0.5", () => {
    const rects = tileRects(S5, evenFractions(S5));
    expect(rects.map((r) => r.left)).toEqual([0, 1 / 3, 2 / 3, 0, 0.5]);
    expect(rects[3].width).toBeCloseTo(0.5, 10);
    expect(rects[4].width).toBeCloseTo(0.5, 10);
  });

  it("rects tile the unit square exactly", () => {
    const f: GridFractions = {
      rows: [0.62, 0.38],
      cols: [
        [0.2, 0.45, 0.35],
        [0.7, 0.3],
      ],
    };
    const rects = tileRects(S5, f);
    expect(rects).toHaveLength(5);
    // Row-major, edges meeting exactly: each left is the previous right, each
    // row's widths sum to 1, the rows' heights sum to 1.
    expect(rects[1].left).toBeCloseTo(rects[0].left + rects[0].width, 12);
    expect(rects[2].left).toBeCloseTo(rects[1].left + rects[1].width, 12);
    expect(rects[2].left + rects[2].width).toBeCloseTo(1, 12);
    expect(rects[4].left + rects[4].width).toBeCloseTo(1, 12);
    expect(rects[3].top).toBeCloseTo(rects[0].height, 12);
    expect(rects[3].top + rects[3].height).toBeCloseTo(1, 12);
  });

  it("normalizeFractions: absent → even; ratios renormalize; axes repair independently", () => {
    expect(normalizeFractions(S5, undefined)).toEqual(evenFractions(S5));
    // [0.3, 0.3] → [0.5, 0.5]: ratio preserved, sum repaired.
    const drifted = normalizeFractions(shape(2, 1, 2, [2]), {
      rows: [1],
      cols: [[0.3, 0.3]],
    });
    expect(drifted.cols[0]).toEqual([0.5, 0.5]);
    // A last row that changed length loses ONLY that row's tuning.
    const partial = normalizeFractions(S5, {
      rows: [0.7, 0.3],
      cols: [
        [0.5, 0.25, 0.25],
        [0.2, 0.3, 0.5], // wrong length for rowCounts[1] = 2
      ],
    });
    expect(partial.rows).toEqual([0.7, 0.3]);
    expect(partial.cols[0]).toEqual([0.5, 0.25, 0.25]);
    expect(partial.cols[1]).toEqual([0.5, 0.5]);
    // Garbage entries coerce to the even share, then renormalize — never NaN,
    // never a negative, always summing to 1.
    const garbage = normalizeFractions(S5, {
      rows: [NaN, 0.5],
      cols: [
        [-1, 2, 0.5],
        [Infinity, 0.25],
      ],
    });
    for (const axis of [garbage.rows, ...garbage.cols]) {
      expect(axis.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
      expect(axis.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
  });
});

describe("gutters", () => {
  const size: SizePx = { width: 1728, height: 582 };

  it("count = (rows-1) + Σ(rowCounts[r]-1): 0 at n=1, 1 at n=2, 4 at 2x3 [3,2], 6 at 2x4", () => {
    const count = (s: GridShape) =>
      gutters(s, evenFractions(s), size).length;
    expect(count(shape(1, 1, 1, [1]))).toBe(0);
    expect(count(shape(2, 1, 2, [2]))).toBe(1);
    expect(count(shape(5, 2, 3, [3, 2]))).toBe(4);
    expect(count(shape(7, 2, 4, [4, 3]))).toBe(6);
  });

  it("n=2 is exact parity with the old split: one x-axis gutter at the ratio", () => {
    const s2 = shape(2, 1, 2, [2]);
    const gs = gutters(s2, { rows: [1], cols: [[0.3, 0.7]] }, size);
    expect(gs).toHaveLength(1);
    expect(gs[0]).toMatchObject({
      id: "col-0-1",
      axis: "x",
      before: 0,
      after: 1,
      crossStart: 0,
      crossLength: 1,
    });
    expect(gs[0].pos).toBeCloseTo(0.3, 12);
    // px clamps resolved against the container: MIN_TILE_W each side.
    expect(gs[0].min).toBeCloseTo(MIN_TILE_W / size.width, 12);
    expect(gs[0].max).toBeCloseTo(1 - MIN_TILE_W / size.width, 12);
  });

  it("a column gutter spans only its own row; a row gutter spans the width", () => {
    const s5 = shape(5, 2, 3, [3, 2]);
    const f: GridFractions = {
      rows: [0.6, 0.4],
      cols: [
        [1 / 3, 1 / 3, 1 / 3],
        [0.5, 0.5],
      ],
    };
    const gs = gutters(s5, f, size);
    const row = gs.find((g) => g.id === "row-1");
    expect(row).toMatchObject({ axis: "y", crossStart: 0, crossLength: 1 });
    expect(row?.pos).toBeCloseTo(0.6, 12);
    const bottom = gs.find((g) => g.id === "col-1-1");
    expect(bottom?.crossStart).toBeCloseTo(0.6, 12);
    expect(bottom?.crossLength).toBeCloseTo(0.4, 12);
    expect(bottom?.pos).toBeCloseTo(0.5, 12);
  });

  it("a container too small for both minima collapses the clamp to the midpoint", () => {
    const s2 = shape(2, 1, 2, [2]);
    const gs = gutters(s2, evenFractions(s2), { width: 500, height: 200 });
    expect(gs[0].min).toBeCloseTo(0.5, 12);
    expect(gs[0].max).toBeCloseTo(0.5, 12);
    // Degenerate container (zero/NaN) pins the handle rather than yielding
    // NaN or a negative span.
    const dead = gutters(s2, evenFractions(s2), { width: 0, height: 0 });
    expect(dead[0].min).toBeCloseTo(0.5, 12);
    expect(dead[0].max).toBeCloseTo(0.5, 12);
  });
});

describe("resizeAt / evenAt", () => {
  const S5 = shape(5, 2, 3, [3, 2]);
  const size: SizePx = { width: 1728, height: 582 };

  it("moves exactly the pair, preserves its combined fraction exactly, mutates nothing", () => {
    const f = evenFractions(S5);
    const before = JSON.parse(JSON.stringify(f)) as GridFractions;
    const g = gutters(S5, f, size).find((x) => x.id === "col-0-1");
    if (!g) throw new Error("col-0-1 missing");
    const out = resizeAt(S5, f, g, 0.4);
    expect(out.cols[0][0]).toBeCloseTo(0.4, 12);
    expect(out.cols[0][1]).toBeCloseTo(1 / 3 + 1 / 3 - 0.4, 12);
    // Pair sum exact, third column untouched.
    expect(out.cols[0][0] + out.cols[0][1]).toBeCloseTo(2 / 3, 14);
    expect(out.cols[0][2]).toBe(f.cols[0][2]);
    // Untouched arrays keep their IDENTITY (rows, the other row's cols).
    expect(out.rows).toBe(f.rows);
    expect(out.cols[1]).toBe(f.cols[1]);
    // The input was never mutated.
    expect(f).toEqual(before);
  });

  it("clamps to the px minima on both sides", () => {
    const f = evenFractions(S5);
    const g = gutters(S5, f, size).find((x) => x.id === "col-0-1");
    if (!g) throw new Error("col-0-1 missing");
    const minW = MIN_TILE_W / size.width;
    expect(resizeAt(S5, f, g, 0).cols[0][0]).toBeCloseTo(minW, 12);
    expect(resizeAt(S5, f, g, 1).cols[0][1]).toBeCloseTo(minW, 12);
  });

  it("row drags trade row heights and never touch columns", () => {
    const f = evenFractions(S5);
    const g = gutters(S5, f, size).find((x) => x.id === "row-1");
    if (!g) throw new Error("row-1 missing");
    const out = resizeAt(S5, f, g, 0.62);
    expect(out.rows[0]).toBeCloseTo(0.62, 12);
    expect(out.rows[1]).toBeCloseTo(0.38, 12);
    expect(out.rows[0] + out.rows[1]).toBeCloseTo(1, 14);
    expect(out.cols).toBe(f.cols);
    // Clamped by MIN_TILE_H when dragged to the edge.
    const minH = MIN_TILE_H / size.height;
    expect(resizeAt(S5, f, g, 0).rows[0]).toBeCloseTo(minH, 12);
  });

  it("evenAt evens exactly the pair (double-click)", () => {
    const f: GridFractions = {
      rows: [0.5, 0.5],
      cols: [
        [0.5, 1 / 6, 1 / 3],
        [0.5, 0.5],
      ],
    };
    const g = gutters(S5, f, { width: 4000, height: 2000 }).find(
      (x) => x.id === "col-0-1",
    );
    if (!g) throw new Error("col-0-1 missing");
    const out = evenAt(S5, f, g);
    expect(out.cols[0][0]).toBeCloseTo(1 / 3, 12);
    expect(out.cols[0][1]).toBeCloseTo(1 / 3, 12);
    expect(out.cols[0][2]).toBe(f.cols[0][2]);
  });
});

describe("dockHeightForTiles", () => {
  const win: SizePx = { width: 1728, height: 970 };

  it("n≤2 keeps today's canonical dock; more tiles step the share up", () => {
    expect(dockHeightForTiles(2, win, 291)).toBe(291);
    expect(dockHeightForTiles(4, win, 291)).toBe(Math.round(970 * 0.45));
    expect(dockHeightForTiles(5, win, 291)).toBe(Math.round(970 * 0.6));
  });

  it("only ever grows: a dock dragged to 700 keeps 700, and dropping tiles never shrinks it", () => {
    expect(dockHeightForTiles(7, win, 700)).toBe(700);
    expect(dockHeightForTiles(1, win, 700)).toBe(700);
  });

  it("caps at the document's floor (docMinHFor)", () => {
    // 400px window: doc floor 220 → dock can never exceed 180.
    expect(dockHeightForTiles(7, { width: 1728, height: 400 }, 120)).toBe(180);
  });
});

describe("persistence helpers", () => {
  it("seedFromLegacyRatio: seeds 2@1x2 once from a valid ratio, else no-ops with the same identity", () => {
    const seeded = seedFromLegacyRatio({}, 0.3);
    expect(seeded["2@1x2"]).toEqual({ rows: [1], cols: [[0.3, 0.7]] });
    // Already present → untouched (same identity).
    const existing = { "2@1x2": { rows: [1], cols: [[0.6, 0.4]] } };
    expect(seedFromLegacyRatio(existing, 0.3)).toBe(existing);
    // Invalid legacy values → same identity, no seed.
    for (const bad of [0, 1, -0.2, NaN, "0.5", null, undefined]) {
      const store = {};
      expect(seedFromLegacyRatio(store, bad)).toBe(store);
    }
  });

  it("putFractions prunes the OLDEST stored shapes past the cap, never the one just written", () => {
    let store = {};
    for (let i = 0; i < MAX_STORED_SHAPES + 3; i++) {
      store = putFractions(store, `${i}@1x${i}`, { rows: [1], cols: [[1]] });
    }
    const keys = Object.keys(store);
    expect(keys).toHaveLength(MAX_STORED_SHAPES);
    expect(keys[0]).toBe("3@1x3");
    expect(keys[keys.length - 1]).toBe(`${MAX_STORED_SHAPES + 2}@1x${MAX_STORED_SHAPES + 2}`);
    // Updating an existing key neither grows the store nor evicts anything.
    const updated = putFractions(store, "3@1x3", { rows: [1], cols: [[1]] });
    expect(Object.keys(updated)).toHaveLength(MAX_STORED_SHAPES);
  });
});
