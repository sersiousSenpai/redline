// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { lineDiff } from "./lineDiff";

const shape = (before: string, after: string) => lineDiff(before, after).map((o) => `${o.kind === "same" ? " " : o.kind === "add" ? "+" : "-"}${o.text}`);

describe("lineDiff", () => {
  it("keeps the shared lines and marks what changed", () => {
    expect(shape("a\nb\nc", "a\nB\nc")).toEqual([" a", "-b", "+B", " c"]);
    expect(shape("a\nc", "a\nb\nc")).toEqual([" a", "+b", " c"]);
    expect(shape("a\nb\nc", "a\nc")).toEqual([" a", "-b", " c"]);
  });
  it("numbers each side", () => {
    const ops = lineDiff("x\ny", "w\nx\ny");
    expect(ops[0]).toEqual({ kind: "add", text: "w", oldLine: null, newLine: 1 });
    expect(ops[1]).toEqual({ kind: "same", text: "x", oldLine: 1, newLine: 2 });
  });
  it("is all same for equal text", () => {
    expect(lineDiff("a\nb", "a\nb").every((o) => o.kind === "same")).toBe(true);
  });
});
