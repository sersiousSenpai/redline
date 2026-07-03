// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { DiffHunk } from "../types";
import { pairHunkLines, tokenize, wordDiff } from "./wordDiff";

const joined = (spans: { text: string }[]) => spans.map((s) => s.text).join("");
const changed = (spans: { text: string; changed: boolean }[]) =>
  spans.filter((s) => s.changed).map((s) => s.text);

describe("tokenize", () => {
  it("splits words, whitespace, and punctuation without splitting words", () => {
    expect(tokenize("let b = 2;")).toEqual(["let", " ", "b", " ", "=", " ", "2", ";"]);
    expect(tokenize("")).toEqual([]);
    expect(tokenize("foo_bar(x)")).toEqual(["foo_bar", "(", "x", ")"]);
  });
});

describe("wordDiff", () => {
  it("marks only the changed token, not the whole line", () => {
    const { del, add } = wordDiff("let b = 2;", "let b = 3;");
    // Both sides reconstruct their full text.
    expect(joined(del)).toBe("let b = 2;");
    expect(joined(add)).toBe("let b = 3;");
    expect(changed(del)).toEqual(["2"]);
    expect(changed(add)).toEqual(["3"]);
  });

  it("marks an inserted word run on the add side only", () => {
    const { del, add } = wordDiff("return value", "return the computed value");
    expect(changed(del)).toEqual([]);
    expect(changed(add).join("")).toBe("the computed ");
  });

  it("identical lines have no changed spans", () => {
    const { del, add } = wordDiff("same()", "same()");
    expect(changed(del)).toEqual([]);
    expect(changed(add)).toEqual([]);
  });

  it("fully different lines are fully changed", () => {
    const { del, add } = wordDiff("alpha", "omega");
    expect(changed(del)).toEqual(["alpha"]);
    expect(changed(add)).toEqual(["omega"]);
  });

  it("falls back to whole-line highlight past the token cap (minified lines)", () => {
    const long = Array.from({ length: 400 }, (_, i) => `t${i}`).join(" ");
    const { del, add } = wordDiff(long, `${long} tail`);
    expect(del).toEqual([{ text: long, changed: true }]);
    expect(add).toEqual([{ text: `${long} tail`, changed: true }]);
  });

  it("empty sides produce no spans rather than a phantom span", () => {
    const { del, add } = wordDiff("", "new line");
    expect(del).toEqual([]);
    expect(changed(add)).toEqual(["new line"]);
  });
});

const hunk = (kinds: ("context" | "del" | "add")[]): DiffHunk => ({
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  header: "",
  lines: kinds.map((kind, i) => ({
    kind,
    oldLine: kind === "add" ? null : i + 1,
    newLine: kind === "del" ? null : i + 1,
    text: `line ${i}`,
  })),
});

describe("pairHunkLines", () => {
  it("pairs a del run with the add run that follows, positionally", () => {
    // ctx, del, del, add, add, ctx  → 1↔3, 2↔4
    const pairs = pairHunkLines(hunk(["context", "del", "del", "add", "add", "context"]));
    expect(pairs.get(1)).toBe(3);
    expect(pairs.get(2)).toBe(4);
    expect(pairs.get(3)).toBe(1);
    expect(pairs.get(4)).toBe(2);
    expect(pairs.has(0)).toBe(false);
    expect(pairs.has(5)).toBe(false);
  });

  it("leaves surplus lines of an unbalanced run unpaired (whole-line tint)", () => {
    // del, add, add → 0↔1; 2 unpaired
    const pairs = pairHunkLines(hunk(["del", "add", "add"]));
    expect(pairs.get(0)).toBe(1);
    expect(pairs.has(2)).toBe(false);
  });

  it("adds without a preceding del run stay unpaired", () => {
    const pairs = pairHunkLines(hunk(["context", "add", "add"]));
    expect(pairs.size).toBe(0);
  });

  it("two separate change runs pair independently", () => {
    // del, add, ctx, del, add → 0↔1, 3↔4
    const pairs = pairHunkLines(hunk(["del", "add", "context", "del", "add"]));
    expect(pairs.get(0)).toBe(1);
    expect(pairs.get(3)).toBe(4);
    expect(pairs.size).toBe(4);
  });
});
