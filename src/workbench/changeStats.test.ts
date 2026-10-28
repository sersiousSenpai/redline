// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { DiffFile, DiffLineKind } from "../types";
import { diffStats } from "./changeStats";

const file = (oldPath: string, newPath: string, kinds: DiffLineKind[]): DiffFile => ({
  oldPath,
  newPath,
  status: "modified",
  binary: false,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: "", lines: kinds.map((kind) => ({ kind, oldLine: null, newLine: null, text: "" })) }],
});

describe("diffStats", () => {
  it("counts added and removed lines per path, a deletion under its old path", () => {
    const m = diffStats([file("a.ts", "a.ts", ["add", "add", "context", "del"]), file("gone.ts", "/dev/null", ["del", "del"])]);
    expect(m.get("a.ts")).toEqual({ add: 2, del: 1 });
    expect(m.get("gone.ts")).toEqual({ add: 0, del: 2 });
  });
});
