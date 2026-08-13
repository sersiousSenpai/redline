// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { pillLabel, relativeTime, type MemoryStatus } from "./MemoryStatusPill";

const NOW = 1_000_000_000_000;

const base: MemoryStatus = {
  live: true,
  itemCount: 0,
  backlog: 0,
  lastOrganizedTs: null,
  lastOrganizedSummary: null,
  chainOk: true,
  compactedCount: 0,
  reclaimedBytes: 0,
  lastCompactionTs: null,
  pendingProposals: 0,
};

describe("relativeTime", () => {
  it("reads coarse buckets and handles the null/never case", () => {
    expect(relativeTime(null, NOW)).toBe("not yet");
    expect(relativeTime(NOW - 5_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(relativeTime(NOW - 3 * 3600_000, NOW)).toBe("3h ago");
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
  });

  it("clamps a future timestamp to just now rather than going negative", () => {
    expect(relativeTime(NOW + 10_000, NOW)).toBe("just now");
  });
});

describe("pillLabel", () => {
  it("shows a bare label before anything is captured", () => {
    expect(pillLabel(null, NOW)).toBe("Memory");
    expect(pillLabel(base, NOW)).toBe("Memory");
  });

  it("prefers the last-organized time when the keeper has run", () => {
    const s = { ...base, itemCount: 40, lastOrganizedTs: NOW - 60_000 };
    expect(pillLabel(s, NOW)).toBe("Memory · organized 1m ago");
  });

  it("falls back to the captured count before the first organize", () => {
    const s = { ...base, itemCount: 12 };
    expect(pillLabel(s, NOW)).toBe("Memory · 12 captured");
  });

  it("lets held proposals outrank the ambient line — a queued destructive op is never invisible", () => {
    const s = { ...base, itemCount: 40, lastOrganizedTs: NOW - 60_000, pendingProposals: 2 };
    expect(pillLabel(s, NOW)).toBe("Memory · 2 to review");
  });

  it("hides the ready-depth segment at zero", () => {
    expect(pillLabel(base, NOW, 0)).toBe("Memory");
    expect(pillLabel(null, NOW, 0)).toBe("Memory");
    const s = { ...base, itemCount: 40, lastOrganizedTs: NOW - 60_000 };
    expect(pillLabel(s, NOW, 0)).toBe("Memory · organized 1m ago");
  });

  it("appends the ready-depth segment after whichever memory segment won", () => {
    expect(pillLabel(base, NOW, 3)).toBe("Memory · 3 ready");
    expect(pillLabel(null, NOW, 1)).toBe("Memory · 1 ready");
    const organized = { ...base, itemCount: 40, lastOrganizedTs: NOW - 60_000 };
    expect(pillLabel(organized, NOW, 3)).toBe("Memory · organized 1m ago · 3 ready");
    // Held proposals still outrank the memory line; ready depth still appends.
    const held = { ...organized, pendingProposals: 2 };
    expect(pillLabel(held, NOW, 3)).toBe("Memory · 2 to review · 3 ready");
  });
});
