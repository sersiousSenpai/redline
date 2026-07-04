// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  mirrorIsBehind,
  mirrorSummary,
  scopeLabel,
  type MirrorStatus,
} from "./portability";

const st = (over: Partial<MirrorStatus>): MirrorStatus => ({
  dir: "/vault",
  enabled: true,
  lastSeq: 0,
  totalEvents: 0,
  noteCount: 0,
  ...over,
});

describe("scopeLabel", () => {
  it("labels every scope", () => {
    expect(scopeLabel("session")).toBe("This plan");
    expect(scopeLabel("mission")).toBe("This mission");
    expect(scopeLabel("class")).toBe("This class");
    expect(scopeLabel("full")).toBe("Everything");
  });
});

describe("mirrorSummary", () => {
  it("reads Off when no directory is chosen", () => {
    expect(mirrorSummary(null)).toMatch(/^Off/);
    expect(mirrorSummary(st({ enabled: false, dir: null }))).toMatch(/^Off/);
  });

  it("reads caught-up when lastSeq >= totalEvents", () => {
    const s = mirrorSummary(st({ lastSeq: 12, totalEvents: 12, noteCount: 12 }));
    expect(s).toContain("all 12 events mirrored");
    expect(s).toContain("12 notes");
  });

  it("reads N of M when behind", () => {
    expect(mirrorSummary(st({ lastSeq: 3, totalEvents: 10, noteCount: 3 }))).toContain(
      "3 of 10 events mirrored",
    );
  });

  it("reads the empty-ledger case honestly", () => {
    expect(mirrorSummary(st({ totalEvents: 0 }))).toContain("no ledger events yet");
  });
});

describe("mirrorIsBehind", () => {
  it("is true only when enabled with events past lastSeq", () => {
    expect(mirrorIsBehind(st({ lastSeq: 3, totalEvents: 10 }))).toBe(true);
    expect(mirrorIsBehind(st({ lastSeq: 10, totalEvents: 10 }))).toBe(false);
    expect(mirrorIsBehind(st({ enabled: false, dir: null, totalEvents: 10 }))).toBe(false);
    expect(mirrorIsBehind(null)).toBe(false);
  });
});
