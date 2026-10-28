// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { tileAtPoint } from "./tilePolicy";

describe("tileAtPoint", () => {
  const boxes = [
    { index: 0, left: 0, top: 0, right: 100, bottom: 50 },
    { index: 1, left: 100, top: 0, right: 200, bottom: 50 },
    { index: 2, left: 0, top: 0, right: 0, bottom: 0 },
  ];

  it("finds the tile under the pointer, edges belonging to the next tile", () => {
    expect(tileAtPoint(boxes, 10, 10)).toBe(0);
    expect(tileAtPoint(boxes, 100, 10)).toBe(1);
    expect(tileAtPoint(boxes, 199, 49)).toBe(1);
  });

  it("is null off the grid, and a hidden (zero-size) tile never matches", () => {
    expect(tileAtPoint(boxes, 250, 10)).toBeNull();
    expect(tileAtPoint(boxes, 0, 0)).toBe(0);
    expect(tileAtPoint([boxes[2]], 0, 0)).toBeNull();
  });
});
