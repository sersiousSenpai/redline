// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { squarify, type TreemapDatum } from "./treemap";

function d(id: string, value: number): TreemapDatum {
  return { id, label: id.toUpperCase(), value };
}

describe("squarify", () => {
  const DATA = [d("a", 6), d("b", 6), d("c", 4), d("d", 3), d("e", 2), d("f", 2), d("g", 1)];

  it("tile area is exactly proportional to value", () => {
    const rects = squarify(DATA, 600, 400);
    const total = DATA.reduce((s, x) => s + x.value, 0);
    for (const r of rects) {
      expect((r.w * r.h) / (600 * 400)).toBeCloseTo(r.value / total, 6);
    }
  });

  it("keeps every tile inside the bounds", () => {
    for (const r of squarify(DATA, 600, 400)) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(600 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(400 + 1e-6);
    }
  });

  it("tiles never overlap", () => {
    const rects = squarify(DATA, 600, 400);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it("is deterministic regardless of input order", () => {
    const shuffled = [DATA[3], DATA[0], DATA[6], DATA[1], DATA[5], DATA[2], DATA[4]];
    expect(squarify(shuffled, 600, 400)).toEqual(squarify(DATA, 600, 400));
  });

  it("drops zero/negative values and handles empty input", () => {
    expect(squarify([], 600, 400)).toEqual([]);
    expect(squarify([d("z", 0), d("n", -3)], 600, 400)).toEqual([]);
    const rects = squarify([d("a", 5), d("z", 0)], 600, 400);
    expect(rects.map((r) => r.id)).toEqual(["a"]);
  });

  it("a single tile fills the whole rectangle", () => {
    const [only] = squarify([d("solo", 42)], 300, 200);
    expect(only.x).toBe(0);
    expect(only.y).toBe(0);
    expect(only.w).toBeCloseTo(300, 6);
    expect(only.h).toBeCloseTo(200, 6);
  });
});
