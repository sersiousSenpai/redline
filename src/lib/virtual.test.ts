// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { chunksForRange, visibleRange } from "./virtual";

describe("visibleRange", () => {
  it("returns an empty range for an empty or unmeasured viewport", () => {
    expect(visibleRange(0, 0, 100, 18, 10)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(0, 400, 0, 18, 10)).toEqual({ start: 0, end: 0 });
  });

  it("windows around the scroll position with overscan", () => {
    // scrollTop 1800 / 18px = line 100; 360px / 18 = 20 visible; overscan 10.
    expect(visibleRange(1800, 360, 1000, 18, 10)).toEqual({ start: 90, end: 130 });
  });

  it("clamps to the document bounds", () => {
    expect(visibleRange(0, 360, 1000, 18, 10).start).toBe(0);
    const end = visibleRange(18 * 1000, 360, 1000, 18, 10).end;
    expect(end).toBe(1000);
  });
});

describe("chunksForRange", () => {
  it("covers every chunk the range touches", () => {
    expect(chunksForRange(90, 130, 100)).toEqual([0, 1]);
    expect(chunksForRange(0, 100, 100)).toEqual([0]);
    expect(chunksForRange(100, 301, 100)).toEqual([1, 2, 3]);
  });

  it("is empty for an empty range", () => {
    expect(chunksForRange(50, 50, 100)).toEqual([]);
  });
});
