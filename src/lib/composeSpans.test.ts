// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { composeLineSpans, type HlToken, type MatchRange } from "./composeSpans";
import type { WordSpan } from "./wordDiff";

const joined = (spans: { text: string }[]) => spans.map((s) => s.text).join("");

describe("composeLineSpans", () => {
  const text = "const x = 42;";

  it("empty text yields no spans", () => {
    expect(composeLineSpans("", [{ t: "" }], null, [])).toEqual([]);
  });

  it("token-only: carries hljs classes and reconstructs the text", () => {
    const tokens: HlToken[] = [
      { c: "hljs-keyword", t: "const" },
      { t: " x = " },
      { c: "hljs-number", t: "42" },
      { t: ";" },
    ];
    const spans = composeLineSpans(text, tokens, null, []);
    expect(joined(spans)).toBe(text);
    expect(spans[0]).toEqual({ text: "const", cls: "hljs-keyword" });
    expect(spans.find((s) => s.text === "42")?.cls).toBe("hljs-number");
  });

  it("word-only: tints only changed spans, with the caller's side kind", () => {
    const word: WordSpan[] = [
      { text: "const x = ", changed: false },
      { text: "42", changed: true },
      { text: ";", changed: false },
    ];
    const spans = composeLineSpans(text, null, { spans: word, kind: "add" }, []);
    expect(joined(spans)).toBe(text);
    expect(spans.map((s) => s.word)).toEqual([undefined, "add", undefined]);
  });

  it("match-only: active beats hit, clamped to the line", () => {
    const matches: MatchRange[] = [
      { start: 6, end: 7, active: false }, // "x"
      { start: 10, end: 99, active: true }, // "42;" clamped
    ];
    const spans = composeLineSpans(text, null, null, matches);
    expect(joined(spans)).toBe(text);
    expect(spans.find((s) => s.text === "x")?.match).toBe("hit");
    expect(spans.find((s) => s.text === "42;")?.match).toBe("active");
  });

  it("all three layers overlapping: boundaries split, attributes stack", () => {
    const tokens: HlToken[] = [
      { c: "hljs-keyword", t: "const" },
      { t: " x = " },
      { c: "hljs-number", t: "42" },
      { t: ";" },
    ];
    const word: WordSpan[] = [
      { text: "const x = ", changed: false },
      { text: "42;", changed: true }, // crosses the number/; token boundary
    ];
    const matches: MatchRange[] = [{ start: 0, end: 7, active: false }]; // "const x"
    const spans = composeLineSpans(text, tokens, { spans: word, kind: "del" }, matches);
    expect(joined(spans)).toBe(text);
    // "const" = keyword + match
    expect(spans[0]).toEqual({ text: "const", cls: "hljs-keyword", match: "hit" });
    // "42" = number class + word tint; ";" = word tint only (split by token edge)
    expect(spans.find((s) => s.text === "42")).toEqual({
      text: "42",
      cls: "hljs-number",
      word: "del",
    });
    expect(spans.find((s) => s.text === ";")).toEqual({ text: ";", word: "del" });
  });

  it("coalesces adjacent identical spans", () => {
    const tokens: HlToken[] = [
      { t: "ab" },
      { t: "cd" }, // same (absent) class → one span
    ];
    const spans = composeLineSpans("abcd", tokens, null, []);
    expect(spans).toEqual([{ text: "abcd" }]);
  });

  it("layer that disagrees with the text length is clamped, never out of bounds", () => {
    const tokens: HlToken[] = [{ c: "hljs-string", t: "way too long for the line" }];
    const spans = composeLineSpans("ab", tokens, null, []);
    expect(joined(spans)).toBe("ab");
    expect(spans[0].cls).toBe("hljs-string");
  });

  it("multi-byte text splits on JS code units consistently", () => {
    const t = "état = \u{1F600};"; // astral emoji = 2 code units
    const tokens: HlToken[] = [
      { c: "hljs-variable", t: "état" },
      { t: " = " },
      { c: "hljs-string", t: "\u{1F600}" },
      { t: ";" },
    ];
    const spans = composeLineSpans(t, tokens, null, []);
    expect(joined(spans)).toBe(t);
    expect(spans.find((s) => s.cls === "hljs-string")?.text).toBe("\u{1F600}");
  });
});
