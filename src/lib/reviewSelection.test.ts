// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { DiffFile, DiffLine } from "../types";
import {
  dragRange,
  lineInRange,
  nextAnnotationId,
  nextQuestionId,
  quotedTextForRange,
  reduceGutterClick,
  sideOfLine,
} from "./reviewSelection";

const ctx = (oldLine: number, newLine: number, text = "ctx"): DiffLine => ({
  kind: "context",
  oldLine,
  newLine,
  text,
});
const add = (newLine: number, text = "added"): DiffLine => ({
  kind: "add",
  oldLine: null,
  newLine,
  text,
});
const del = (oldLine: number, text = "removed"): DiffLine => ({
  kind: "del",
  oldLine,
  newLine: null,
  text,
});

describe("reduceGutterClick", () => {
  it("plain click selects one line on the line's own side", () => {
    const r = reduceGutterClick(null, { filePath: "a.ts", line: add(7), shift: false });
    expect(r).toEqual({ filePath: "a.ts", side: "new", startLine: 7, endLine: 7 });
    const r2 = reduceGutterClick(null, { filePath: "a.ts", line: del(3), shift: false });
    expect(r2).toEqual({ filePath: "a.ts", side: "old", startLine: 3, endLine: 3 });
  });

  it("shift-click extends within the same file + side, in either direction", () => {
    let r = reduceGutterClick(null, { filePath: "a.ts", line: add(7), shift: false });
    r = reduceGutterClick(r, { filePath: "a.ts", line: ctx(9, 10), shift: true });
    expect(r).toEqual({ filePath: "a.ts", side: "new", startLine: 7, endLine: 10 });
    r = reduceGutterClick(r, { filePath: "a.ts", line: ctx(2, 3), shift: true });
    expect(r).toEqual({ filePath: "a.ts", side: "new", startLine: 3, endLine: 10 });
  });

  it("shift-click across file or side starts fresh instead of extending", () => {
    const base = reduceGutterClick(null, { filePath: "a.ts", line: add(7), shift: false });
    const other = reduceGutterClick(base, { filePath: "b.ts", line: add(2), shift: true });
    expect(other).toEqual({ filePath: "b.ts", side: "new", startLine: 2, endLine: 2 });
    const flipped = reduceGutterClick(base, { filePath: "a.ts", line: del(4), shift: true });
    expect(flipped).toEqual({ filePath: "a.ts", side: "old", startLine: 4, endLine: 4 });
  });

  it("dragRange spans from the anchor in either direction on the anchor's side", () => {
    expect(dragRange("a.ts", "new", 5, ctx(9, 9))).toEqual({
      filePath: "a.ts",
      side: "new",
      startLine: 5,
      endLine: 9,
    });
    // Dragging upward normalizes.
    expect(dragRange("a.ts", "new", 9, ctx(3, 3))).toEqual({
      filePath: "a.ts",
      side: "new",
      startLine: 3,
      endLine: 9,
    });
    // A hovered line with no number on the drag side extends nothing.
    expect(dragRange("a.ts", "old", 2, add(7))).toBeNull();
    expect(dragRange("a.ts", "old", 2, del(6))).toEqual({
      filePath: "a.ts",
      side: "old",
      startLine: 2,
      endLine: 6,
    });
  });

  it("plain click on a context line selects its new side (row-click path)", () => {
    // The whole row is the click surface now — a context row must anchor to
    // the new side so quotedText captures what's actually on screen.
    const r = reduceGutterClick(null, { filePath: "a.ts", line: ctx(4, 6), shift: false });
    expect(r).toEqual({ filePath: "a.ts", side: "new", startLine: 6, endLine: 6 });
  });

  it("clicking the sole selected line again clears the selection", () => {
    const one = reduceGutterClick(null, { filePath: "a.ts", line: add(7), shift: false });
    expect(reduceGutterClick(one, { filePath: "a.ts", line: add(7), shift: false })).toBeNull();
    // But not when the range spans more than one line.
    const wide = { filePath: "a.ts", side: "new" as const, startLine: 7, endLine: 9 };
    expect(
      reduceGutterClick(wide, { filePath: "a.ts", line: add(7), shift: false }),
    ).toEqual({ filePath: "a.ts", side: "new", startLine: 7, endLine: 7 });
  });
});

const file: DiffFile = {
  oldPath: "src/a.ts",
  newPath: "src/a.ts",
  status: "modified",
  binary: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      header: "",
      lines: [ctx(1, 1, "intro"), del(2, "old body"), add(2, "new body"), ctx(3, 3, "tail")],
    },
  ],
};

describe("quotedTextForRange", () => {
  it("captures the new side (context + adds), skipping del lines", () => {
    const text = quotedTextForRange([file], {
      filePath: "src/a.ts",
      side: "new",
      startLine: 1,
      endLine: 3,
    });
    expect(text).toBe("intro\nnew body\ntail");
  });

  it("captures the old side (context + dels), skipping add lines", () => {
    const text = quotedTextForRange([file], {
      filePath: "src/a.ts",
      side: "old",
      startLine: 2,
      endLine: 2,
    });
    expect(text).toBe("old body");
  });

  it("unknown file → empty string", () => {
    expect(
      quotedTextForRange([file], { filePath: "nope.ts", side: "new", startLine: 1, endLine: 1 }),
    ).toBe("");
  });
});

describe("lineInRange + sideOfLine", () => {
  it("matches only lines with a number on the range's side", () => {
    const range = { filePath: "src/a.ts", side: "new" as const, startLine: 2, endLine: 3 };
    expect(lineInRange(range, "src/a.ts", add(2))).toBe(true);
    expect(lineInRange(range, "src/a.ts", ctx(3, 3))).toBe(true);
    expect(lineInRange(range, "src/a.ts", del(2))).toBe(false); // no new-side number
    expect(lineInRange(range, "other.ts", add(2))).toBe(false);
    expect(lineInRange(null, "src/a.ts", add(2))).toBe(false);
  });

  it("sideOfLine: del → old; add/context → new", () => {
    expect(sideOfLine(del(1))).toBe("old");
    expect(sideOfLine(add(1))).toBe("new");
    expect(sideOfLine(ctx(1, 1))).toBe("new");
  });
});

describe("nextAnnotationId", () => {
  it("continues the rc-NNN series and ignores foreign ids", () => {
    expect(nextAnnotationId([])).toBe("rc-001");
    expect(nextAnnotationId([{ id: "rc-001" }, { id: "rc-007" }, { id: "x9" }])).toBe("rc-008");
  });

  it("prefixed series are independent namespaces", () => {
    const mixed = [{ id: "rc-004" }, { id: "ask-002" }, { id: "ai-009" }];
    expect(nextAnnotationId(mixed)).toBe("rc-005");
    expect(nextQuestionId(mixed)).toBe("ask-003");
  });
});
