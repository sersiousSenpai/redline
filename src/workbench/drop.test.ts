// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { dropEdgeAt, dropTargetAt, dropZone } from "./drop";

const box = { left: 100, top: 50, width: 400, height: 200 };

describe("merge by drag: where a tab lands", () => {
  it.each([
    [110, 150, "left"],
    [490, 150, "right"],
    [300, 60, "top"],
    [300, 240, "bottom"],
    // The middle goes to the nearest edge: closer to the top than the sides.
    [300, 140, "top"],
    [300, 160, "bottom"],
  ] as const)("(%i, %i) is the %s edge", (x, y, edge) => {
    expect(dropEdgeAt(box, x, y)).toBe(edge);
  });

  it("lights the half the merged tab will take", () => {
    expect(dropZone(box, "left")).toEqual({ left: 100, top: 50, width: 200, height: 200 });
    expect(dropZone(box, "right")).toEqual({ left: 300, top: 50, width: 200, height: 200 });
    expect(dropZone(box, "top")).toEqual({ left: 100, top: 50, width: 400, height: 100 });
    expect(dropZone(box, "bottom")).toEqual({ left: 100, top: 150, width: 400, height: 100 });
  });

  it("finds the pane under the point, or none outside every pane", () => {
    const rects = { a: box, b: { left: 506, top: 50, width: 300, height: 200 } };
    expect(dropTargetAt(rects, 790, 150)).toEqual({ paneId: "b", edge: "right", zone: { left: 656, top: 50, width: 150, height: 200 } });
    expect(dropTargetAt(rects, 120, 150)?.paneId).toBe("a");
    expect(dropTargetAt(rects, 10, 10)).toBeNull();
  });
});
