// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { DiffFile, DiffHunk, DiffLine } from "../types";
import {
  augmentFile,
  contentConsistent,
  deltasReconcile,
  expandSlots,
  gapAbove,
} from "./expandContext";

const ctx = (o: number, n: number, text: string): DiffLine => ({
  kind: "context",
  oldLine: o,
  newLine: n,
  text,
});
const del = (o: number, text: string): DiffLine => ({
  kind: "del",
  oldLine: o,
  newLine: null,
  text,
});
const add = (n: number, text: string): DiffLine => ({
  kind: "add",
  oldLine: null,
  newLine: n,
  text,
});

// A 12-line file where line 5 was changed (L5: "five" → "FIVE") and line 10
// changed ("ten" → "TEN"), diffed with -U1.
const OLD = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const NEW = OLD.map((t) => (t === "five" ? "FIVE" : t === "ten" ? "TEN" : t));

const hunk1: DiffHunk = {
  oldStart: 4,
  oldLines: 3,
  newStart: 4,
  newLines: 3,
  header: "",
  lines: [ctx(4, 4, "four"), del(5, "five"), add(5, "FIVE"), ctx(6, 6, "six")],
};
const hunk2: DiffHunk = {
  oldStart: 9,
  oldLines: 3,
  newStart: 9,
  newLines: 3,
  header: "",
  lines: [ctx(9, 9, "nine"), del(10, "ten"), add(10, "TEN"), ctx(11, 11, "eleven")],
};
const file: DiffFile = {
  oldPath: "f.txt",
  newPath: "f.txt",
  status: "modified",
  binary: false,
  hunks: [hunk1, hunk2],
};

describe("contentConsistent", () => {
  it("accepts content that matches every claimed line", () => {
    expect(contentConsistent(file, "old", OLD)).toBe(true);
    expect(contentConsistent(file, "new", NEW)).toBe(true);
  });

  it("rejects drifted content (same length, different text)", () => {
    const drifted = [...NEW];
    drifted[3] = "FOUR (edited underneath)";
    expect(contentConsistent(file, "new", drifted)).toBe(false);
  });

  it("rejects content shorter than the claimed line numbers", () => {
    expect(contentConsistent(file, "new", NEW.slice(0, 5))).toBe(false);
  });
});

describe("gapAbove / expandSlots", () => {
  it("computes the top and between gaps", () => {
    expect(gapAbove(file, 0)).toBe(3); // lines 1-3
    expect(gapAbove(file, 1)).toBe(2); // lines 7-8
  });

  it("emits top, between, and bottom slots for a modified file", () => {
    expect(expandSlots(file)).toEqual([
      { hunkIndex: 0, edge: "up", gap: 3 },
      { hunkIndex: 1, edge: "up", gap: 2 },
      { hunkIndex: 1, edge: "down", gap: null },
    ]);
  });

  it("added/binary files have no slots", () => {
    expect(expandSlots({ ...file, status: "added" })).toEqual([]);
    expect(expandSlots({ ...file, binary: true })).toEqual([]);
  });
});

describe("augmentFile", () => {
  it("expands a hunk upward with correctly numbered context", () => {
    const out = augmentFile(file, OLD, NEW, 0, "up", 2);
    const h = out.hunks[0];
    expect(h.oldStart).toBe(2);
    expect(h.newStart).toBe(2);
    expect(h.oldLines).toBe(5);
    expect(h.newLines).toBe(5);
    expect(h.lines.slice(0, 2)).toEqual([ctx(2, 2, "two"), ctx(3, 3, "three")]);
  });

  it("consuming the whole between-gap merges adjacent hunks", () => {
    const out = augmentFile(file, OLD, NEW, 1, "up", 20);
    expect(out.hunks).toHaveLength(1);
    const h = out.hunks[0];
    // Continuous 4..11 on both sides: 3+2+3 old-side lines.
    expect(h.oldStart).toBe(4);
    expect(h.oldLines).toBe(8);
    expect(h.newLines).toBe(8);
    const texts = h.lines.map((l) => l.text);
    expect(texts).toContain("seven");
    expect(texts).toContain("eight");
    // Order is document order: hunk1, gap, hunk2.
    expect(texts.indexOf("seven")).toBeGreaterThan(texts.indexOf("six"));
    expect(texts.indexOf("nine")).toBeGreaterThan(texts.indexOf("eight"));
  });

  it("expands the last hunk downward and clamps at the file end", () => {
    const out = augmentFile(file, OLD, NEW, 1, "down", 20);
    const h = out.hunks[1];
    expect(h.newLines).toBe(4); // + line 12 only
    expect(h.lines[h.lines.length - 1]).toEqual(ctx(12, 12, "twelve"));
    // Idempotent once exhausted.
    const again = augmentFile(out, OLD, NEW, 1, "down", 20);
    expect(again.hunks[1].newLines).toBe(4);
  });

  it("returns the file unchanged when there is nothing to expand", () => {
    const topless: DiffFile = {
      ...file,
      hunks: [{ ...hunk1, oldStart: 1, newStart: 1 }],
    };
    expect(augmentFile(topless, OLD, NEW, 0, "up", 20)).toBe(topless);
  });

  it("never mutates the input file", () => {
    const before = JSON.stringify(file);
    augmentFile(file, OLD, NEW, 0, "up", 2);
    augmentFile(file, OLD, NEW, 1, "down", 5);
    expect(JSON.stringify(file)).toBe(before);
  });
});

describe("deltasReconcile", () => {
  it("passes when hunk deltas match the whole-file counts", () => {
    expect(deltasReconcile(file, OLD, NEW)).toBe(true);
  });
  it("fails when the file gained lines the hunks don't account for", () => {
    expect(deltasReconcile(file, OLD, [...NEW, "thirteen"])).toBe(false);
  });
  it("one-sided files pass trivially", () => {
    expect(deltasReconcile(file, null, NEW)).toBe(true);
  });
});
