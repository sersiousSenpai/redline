// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootTimeline,
  mark,
  markOnce,
  resetBootMarksForTest,
  sinceEntry,
} from "./bootMarks";

describe("boot marks", () => {
  beforeEach(() => {
    resetBootMarksForTest();
    performance.clearMarks?.();
    performance.clearMeasures?.();
  });

  it("records a mark and measures it from the entry origin", () => {
    mark("rl:entry");
    mark("rl:first-commit");
    expect(performance.getEntriesByName("rl:entry", "mark")).toHaveLength(1);
    expect(
      performance.getEntriesByName("rl:first-commit (from entry)", "measure"),
    ).toHaveLength(1);
    expect(sinceEntry("rl:first-commit")).not.toBeNull();
  });

  it("markOnce is idempotent — StrictMode double-invocation records once", () => {
    mark("rl:entry");
    markOnce("rl:actionable");
    markOnce("rl:actionable");
    markOnce("rl:actionable");
    expect(performance.getEntriesByName("rl:actionable", "mark")).toHaveLength(
      1,
    );
  });

  it("a milestone reached before the origin still records, without a measure", () => {
    // Order is not guaranteed under a failure (a reveal that beats the entry
    // mark in a resurrected window); the mark must survive regardless.
    markOnce("rl:reveal-call");
    expect(
      performance.getEntriesByName("rl:reveal-call", "mark"),
    ).toHaveLength(1);
    expect(sinceEntry("rl:reveal-call")).toBeNull();
  });

  it("never throws when the User Timing API is unavailable", () => {
    const original = performance.mark;
    // A WebView (or a hardened test env) without `mark` must degrade to a
    // no-op — instrumentation may never be the thing that breaks boot.
    // @ts-expect-error deliberately removing the API for the test
    performance.mark = undefined;
    try {
      expect(() => mark("rl:entry")).not.toThrow();
      expect(sinceEntry("rl:entry")).toBeNull();
    } finally {
      performance.mark = original;
    }
  });

  it("survives a throwing measure (duplicate/absent start mark)", () => {
    mark("rl:entry");
    const original = performance.measure;
    performance.measure = vi.fn(() => {
      throw new Error("no such mark");
    }) as unknown as typeof performance.measure;
    try {
      expect(() => mark("rl:core-bootstrap")).not.toThrow();
    } finally {
      performance.measure = original;
    }
  });

  it("bootTimeline reports every fired milestone in milliseconds", () => {
    mark("rl:entry");
    mark("rl:first-commit");
    mark("rl:actionable");
    const timeline = bootTimeline();
    expect(Object.keys(timeline).sort()).toEqual([
      "rl:actionable",
      "rl:entry",
      "rl:first-commit",
    ]);
    expect(timeline["rl:entry"]).toBe(0);
    for (const value of Object.values(timeline)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});
