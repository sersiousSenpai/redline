// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RESIZE_SETTLE_MS,
  createResizeScheduler,
  isUsableTermSize,
} from "./termSize";

describe("isUsableTermSize", () => {
  it("rejects missing dimensions", () => {
    expect(isUsableTermSize(undefined)).toBe(false);
    expect(isUsableTermSize(null)).toBe(false);
  });

  it("rejects FitAddon's squished-host floor (2 cols × 1 row)", () => {
    expect(isUsableTermSize({ cols: 2, rows: 1 })).toBe(false);
    expect(isUsableTermSize({ cols: 2, rows: 24 })).toBe(false);
    expect(isUsableTermSize({ cols: 80, rows: 1 })).toBe(false);
    expect(isUsableTermSize({ cols: 0, rows: 0 })).toBe(false);
  });

  it("accepts real geometry", () => {
    expect(isUsableTermSize({ cols: 3, rows: 2 })).toBe(true);
    expect(isUsableTermSize({ cols: 80, rows: 24 })).toBe(true);
  });
});

describe("createResizeScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses a debounced storm into one trailing send", () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const s = createResizeScheduler((size) => sent.push(size));
    for (let c = 40; c <= 120; c++) s.schedule({ cols: c, rows: 24 }, false);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(RESIZE_SETTLE_MS);
    expect(sent).toEqual([{ cols: 120, rows: 24 }]);
  });

  it("sends immediately for single-shot paths and cancels a pending debounce", () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const s = createResizeScheduler((size) => sent.push(size));
    s.schedule({ cols: 100, rows: 30 }, false);
    s.schedule({ cols: 80, rows: 24 }, true);
    expect(sent).toEqual([{ cols: 80, rows: 24 }]);
    vi.advanceTimersByTime(RESIZE_SETTLE_MS * 2);
    // The debounced 100×30 was superseded — nothing else lands.
    expect(sent).toEqual([{ cols: 80, rows: 24 }]);
  });

  it("never resends an unchanged size", () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const s = createResizeScheduler((size) => sent.push(size));
    s.schedule({ cols: 80, rows: 24 }, true);
    s.schedule({ cols: 80, rows: 24 }, true);
    s.schedule({ cols: 80, rows: 24 }, false);
    vi.advanceTimersByTime(RESIZE_SETTLE_MS);
    expect(sent).toEqual([{ cols: 80, rows: 24 }]);
  });

  it("drops degenerate sizes even at flush time", () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const s = createResizeScheduler((size) => sent.push(size));
    s.schedule({ cols: 2, rows: 1 }, true);
    s.schedule({ cols: 2, rows: 1 }, false);
    vi.advanceTimersByTime(RESIZE_SETTLE_MS);
    expect(sent).toEqual([]);
  });

  it("cancel drops the pending send", () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const s = createResizeScheduler((size) => sent.push(size));
    s.schedule({ cols: 80, rows: 24 }, false);
    s.cancel();
    vi.advanceTimersByTime(RESIZE_SETTLE_MS * 2);
    expect(sent).toEqual([]);
  });
});
