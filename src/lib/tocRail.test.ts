// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  TOC_DRAG_MAX,
  TOC_DRAG_MIN,
  TOC_RAIL_W,
  TOC_RAIL_W_WIDE,
  clampTocDrag,
  snapTocWide,
} from "./tocRail";

describe("snapTocWide", () => {
  const midpoint = (TOC_RAIL_W + TOC_RAIL_W_WIDE) / 2; // 285

  it("snaps to narrow below the midpoint", () => {
    expect(snapTocWide(TOC_RAIL_W)).toBe(false);
    expect(snapTocWide(midpoint - 1)).toBe(false);
  });

  it("snaps to wide at and above the midpoint", () => {
    expect(snapTocWide(midpoint)).toBe(true);
    expect(snapTocWide(TOC_RAIL_W_WIDE)).toBe(true);
    expect(snapTocWide(TOC_DRAG_MAX)).toBe(true);
  });

  it("extremes land on their nearest snap", () => {
    expect(snapTocWide(TOC_DRAG_MIN)).toBe(false);
    expect(snapTocWide(0)).toBe(false);
    expect(snapTocWide(10_000)).toBe(true);
  });
});

describe("clampTocDrag", () => {
  it("passes through in-range widths", () => {
    expect(clampTocDrag(TOC_RAIL_W)).toBe(TOC_RAIL_W);
    expect(clampTocDrag(300)).toBe(300);
  });

  it("clamps to the drag bounds", () => {
    expect(clampTocDrag(0)).toBe(TOC_DRAG_MIN);
    expect(clampTocDrag(10_000)).toBe(TOC_DRAG_MAX);
  });
});
