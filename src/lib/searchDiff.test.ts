// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { DiffFile } from "../types";
import { flattenDiff } from "./flattenDiff";
import { groupMatches, matchRowIndex, searchDiff } from "./searchDiff";

const fileA: DiffFile = {
  oldPath: "a.ts",
  newPath: "a.ts",
  status: "modified",
  binary: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      header: "",
      lines: [
        { kind: "context", oldLine: 1, newLine: 1, text: "const foo = foo(fooBar);" },
        { kind: "del", oldLine: 2, newLine: null, text: "let x = 1;" },
        { kind: "add", oldLine: null, newLine: 2, text: "let Foo = 2;" },
      ],
    },
  ],
};
const fileB: DiffFile = {
  oldPath: "b.ts",
  newPath: "b.ts",
  status: "modified",
  binary: false,
  hunks: [
    {
      oldStart: 5,
      oldLines: 1,
      newStart: 5,
      newLines: 1,
      header: "",
      lines: [{ kind: "context", oldLine: 5, newLine: 5, text: "nothing here" }],
    },
  ],
};

describe("searchDiff", () => {
  it("finds case-insensitive matches with multiple hits per line", () => {
    const { matches, perFile } = searchDiff([fileA, fileB], "foo");
    // 3 on the first line (foo, foo, fooBar) + 1 on the add line (Foo).
    expect(matches).toHaveLength(4);
    expect(perFile.get("a.ts")).toBe(4);
    expect(perFile.has("b.ts")).toBe(false);
    expect(matches[0]).toMatchObject({ filePath: "a.ts", start: 6, end: 9 });
  });

  it("empty query matches nothing", () => {
    expect(searchDiff([fileA], "").matches).toHaveLength(0);
  });

  it("groupMatches keys by hunk line and keeps global indices", () => {
    const { matches } = searchDiff([fileA], "foo");
    const grouped = groupMatches(matches);
    expect(grouped.get("0:0:0")).toHaveLength(3);
    expect(grouped.get("0:0:2")).toEqual([{ start: 4, end: 7, index: 3 }]);
  });
});

describe("matchRowIndex", () => {
  it("locates the row in unified mode", () => {
    const rows = flattenDiff([fileA, fileB]);
    const { matches } = searchDiff([fileA, fileB], "nothing");
    expect(matches).toHaveLength(1);
    const idx = matchRowIndex(rows, matches[0]);
    expect(idx).toBeGreaterThan(0);
    expect(rows[idx]).toMatchObject({ type: "line", filePath: "b.ts" });
  });

  it("locates pair rows in split mode (either cell)", () => {
    const rows = flattenDiff([fileA], new Set(), "split");
    const { matches } = searchDiff([fileA], "let");
    // One del-side and one add-side match — both land on the same pair row.
    expect(matches).toHaveLength(2);
    const a = matchRowIndex(rows, matches[0]);
    const b = matchRowIndex(rows, matches[1]);
    expect(a).toBe(b);
    expect(rows[a]).toMatchObject({ type: "pair" });
  });

  it("returns -1 for a collapsed file", () => {
    const rows = flattenDiff([fileA], new Set(["a.ts"]));
    const { matches } = searchDiff([fileA], "foo");
    expect(matchRowIndex(rows, matches[0])).toBe(-1);
  });
});
