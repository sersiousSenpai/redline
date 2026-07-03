// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { DiffFile } from "../types";
import {
  diffStats,
  displayPath,
  fileHeaderIndex,
  flattenDiff,
  hunkSideIndices,
  hunkSideText,
} from "./flattenDiff";

const file = (over: Partial<DiffFile>): DiffFile => ({
  oldPath: "src/a.ts",
  newPath: "src/a.ts",
  status: "modified",
  binary: false,
  hunks: [],
  ...over,
});

const twoHunkFile = file({
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      header: "fn one",
      lines: [
        { kind: "context", oldLine: 1, newLine: 1, text: "a" },
        { kind: "del", oldLine: 2, newLine: null, text: "b" },
        { kind: "add", oldLine: null, newLine: 2, text: "c" },
      ],
    },
    {
      oldStart: 9,
      oldLines: 1,
      newStart: 9,
      newLines: 1,
      header: "",
      lines: [{ kind: "context", oldLine: 9, newLine: 9, text: "tail" }],
    },
  ],
});

describe("flattenDiff", () => {
  it("emits file, hunk, and line rows in document order", () => {
    const rows = flattenDiff([twoHunkFile]);
    expect(rows.map((r) => r.type)).toEqual([
      "file",
      "hunk",
      "line",
      "line",
      "line",
      "hunk",
      "line",
    ]);
    // Every row carries the file path + indices the annotation layer keys on.
    expect(rows.every((r) => r.filePath === "src/a.ts")).toBe(true);
    const lastLine = rows[6];
    if (lastLine.type !== "line") throw new Error("expected line row");
    expect(lastLine.hunkIndex).toBe(1);
    expect(lastLine.lineIndex).toBe(0);
    expect(lastLine.line.text).toBe("tail");
    const secondLine = rows[3];
    if (secondLine.type !== "line") throw new Error("expected line row");
    expect(secondLine.lineIndex).toBe(1);
  });

  it("collapsed files contribute only their header row", () => {
    const other = file({ oldPath: "b.ts", newPath: "b.ts" });
    const rows = flattenDiff([twoHunkFile, other], new Set(["src/a.ts"]));
    expect(rows.map((r) => r.type)).toEqual(["file", "file"]);
    expect(rows[1].filePath).toBe("b.ts");
    // fileIndex still points into the original files array.
    expect(rows[1].fileIndex).toBe(1);
  });

  it("empty input flattens to no rows", () => {
    expect(flattenDiff([])).toEqual([]);
  });

  it("split mode: context mirrors, del/add pairs positionally, tails go one-sided", () => {
    const f = file({
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 4,
          header: "",
          lines: [
            { kind: "context", oldLine: 1, newLine: 1, text: "ctx" },
            { kind: "del", oldLine: 2, newLine: null, text: "d1" },
            { kind: "del", oldLine: 3, newLine: null, text: "d2" },
            { kind: "add", oldLine: null, newLine: 2, text: "a1" },
            { kind: "add", oldLine: null, newLine: 3, text: "a2" },
            { kind: "add", oldLine: null, newLine: 4, text: "a3" },
          ],
        },
      ],
    });
    const rows = flattenDiff([f], new Set(), "split");
    expect(rows.map((r) => r.type)).toEqual(["file", "hunk", "pair", "pair", "pair", "pair"]);
    const pairs = rows.filter((r) => r.type === "pair");
    // Context mirrors into both cells (same line object, same hunk index).
    expect(pairs[0]).toMatchObject({
      left: { text: "ctx" },
      right: { text: "ctx" },
      leftLineIndex: 0,
      rightLineIndex: 0,
    });
    // d1↔a1, d2↔a2 pair positionally; a3 is one-sided.
    expect(pairs[1]).toMatchObject({ left: { text: "d1" }, right: { text: "a1" } });
    expect(pairs[2]).toMatchObject({ left: { text: "d2" }, right: { text: "a2" } });
    expect(pairs[3]).toMatchObject({ left: null, leftLineIndex: null, right: { text: "a3" } });
  });

  it("split mode: an add-only run pairs against empty left cells", () => {
    const f = file({
      hunks: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
          header: "",
          lines: [
            { kind: "add", oldLine: null, newLine: 1, text: "a1" },
            { kind: "add", oldLine: null, newLine: 2, text: "a2" },
          ],
        },
      ],
    });
    const pairs = flattenDiff([f], new Set(), "split").filter((r) => r.type === "pair");
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.type === "pair" && p.left === null)).toBe(true);
  });

  it("split mode still honors the viewed collapse", () => {
    const rows = flattenDiff([twoHunkFile], new Set(["src/a.ts"]), "split");
    expect(rows.map((r) => r.type)).toEqual(["file"]);
  });

  it("hunkSideIndices tracks each side's segment position", () => {
    const idx = hunkSideIndices(twoHunkFile.hunks[0]);
    // context(a): old 0 / new 0; del(b): old 1, no new; add(c): no old, new 1.
    expect(idx).toEqual([
      { oldIdx: 0, newIdx: 0 },
      { oldIdx: 1, newIdx: -1 },
      { oldIdx: -1, newIdx: 1 },
    ]);
  });

  it("hunkSideText joins each side's lines — the highlight segment content", () => {
    expect(hunkSideText(twoHunkFile.hunks[0], "old")).toBe("a\nb");
    expect(hunkSideText(twoHunkFile.hunks[0], "new")).toBe("a\nc");
  });

  it("fileHeaderIndex finds a file's header row for jump-to-file", () => {
    const other = file({ oldPath: "b.ts", newPath: "b.ts" });
    const rows = flattenDiff([twoHunkFile, other]);
    expect(fileHeaderIndex(rows, "src/a.ts")).toBe(0);
    expect(fileHeaderIndex(rows, "b.ts")).toBe(rows.length - 1);
    expect(fileHeaderIndex(rows, "missing.ts")).toBe(-1);
  });
});

describe("displayPath", () => {
  it("uses newPath except for deletions (old path) — the annotation anchor path", () => {
    expect(displayPath(file({ oldPath: "old.ts", newPath: "new.ts" }))).toBe("new.ts");
    expect(
      displayPath(file({ oldPath: "gone.ts", newPath: "/dev/null", status: "deleted" })),
    ).toBe("gone.ts");
  });
});

describe("diffStats", () => {
  it("counts files and add/del lines (context excluded)", () => {
    expect(diffStats([twoHunkFile])).toEqual({ files: 1, additions: 1, deletions: 1 });
    expect(diffStats([])).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
});
