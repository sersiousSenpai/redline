// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it } from "vitest";

import { beginMeasure, cancelMeasure, endMeasure, lastMeasure, resetMeasuresForTest } from "./perf";

describe("workbench measures", () => {
  beforeEach(() => {
    resetMeasuresForTest();
    performance.clearMarks?.();
    performance.clearMeasures?.();
  });

  it("times begin to end and records a measure under the name", () => {
    expect(endMeasure("wb:session-switch")).toBeNull();
    beginMeasure("wb:session-switch");
    const ms = endMeasure("wb:session-switch");
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThanOrEqual(0);
    expect(lastMeasure("wb:session-switch")).toBe(ms);
    expect(performance.getEntriesByName("wb:session-switch", "measure")).toHaveLength(1);
    // Ended: a second end is a no-op.
    expect(endMeasure("wb:session-switch")).toBeNull();
  });

  it("a cancelled begin never ends; a repeated begin restarts", () => {
    beginMeasure("wb:tab-switch");
    cancelMeasure("wb:tab-switch");
    expect(endMeasure("wb:tab-switch")).toBeNull();
    beginMeasure("wb:new-tab-caret");
    beginMeasure("wb:new-tab-caret");
    expect(endMeasure("wb:new-tab-caret")).not.toBeNull();
    expect(performance.getEntriesByName("wb:new-tab-caret", "measure")).toHaveLength(1);
  });

  it("never throws without the User Timing API", () => {
    const mark = performance.mark;
    const measure = performance.measure;
    // @ts-expect-error — simulating an old WebView
    performance.mark = undefined;
    // @ts-expect-error — simulating an old WebView
    performance.measure = undefined;
    try {
      expect(() => {
        beginMeasure("wb:terminal-swap");
        expect(endMeasure("wb:terminal-swap")).not.toBeNull();
      }).not.toThrow();
    } finally {
      performance.mark = mark;
      performance.measure = measure;
    }
  });
});
