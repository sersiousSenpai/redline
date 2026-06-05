// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { segmentSentences, segmentSourceLines } from "./sentenceSegment";

describe("segmentSentences", () => {
  it("splits on `. `, `! `, `? ` followed by a sentence-starter", () => {
    const out = segmentSentences("One. Two! Three? Four.");
    expect(out.map((s) => s.text)).toEqual([
      "One.",
      "Two!",
      "Three?",
      "Four.",
    ]);
  });

  it("returns the whole input as one sentence when no boundary fires", () => {
    expect(segmentSentences("just one clause").map((s) => s.text)).toEqual([
      "just one clause",
    ]);
  });

  it("returns an empty array for empty / whitespace-only input", () => {
    expect(segmentSentences("")).toEqual([]);
    expect(segmentSentences("   \n  ")).toEqual([]);
  });

  it("honors the abbreviation allow-list", () => {
    // Without an allow-list these would each become two sentences.
    expect(
      segmentSentences("Met with Dr. Brown today. Excellent talk.").map(
        (s) => s.text,
      ),
    ).toEqual(["Met with Dr. Brown today.", "Excellent talk."]);
    expect(
      segmentSentences("Use e.g. lists for items. Otherwise prose.").map(
        (s) => s.text,
      ),
    ).toEqual(["Use e.g. lists for items.", "Otherwise prose."]);
    expect(
      segmentSentences("Per p. 14 vs. p. 22, see below. Done.").map(
        (s) => s.text,
      ),
    ).toEqual(["Per p. 14 vs. p. 22, see below.", "Done."]);
  });

  it("does not split inside backtick code spans", () => {
    // `foo.bar()` would otherwise trigger on the dot.
    expect(
      segmentSentences(
        "Call `foo.bar(arg)` to start. Then call `baz.quux()`.",
      ).map((s) => s.text),
    ).toEqual([
      "Call `foo.bar(arg)` to start.",
      "Then call `baz.quux()`.",
    ]);
  });

  it("does not split when the next char is lowercase", () => {
    // Even after `. ` we don't split if the continuation isn't a sentence-
    // starter; protects against ellipses-style runs and weird formatting.
    expect(
      segmentSentences("ok... fine then. Next sentence.").map((s) => s.text),
    ).toEqual(["ok... fine then.", "Next sentence."]);
  });

  it("preserves byte offsets for round-trip slicing", () => {
    const text = "First. Second. Third.";
    const out = segmentSentences(text);
    for (const s of out) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
  });
});

describe("segmentSourceLines", () => {
  it("splits on newlines and skips empty lines", () => {
    const out = segmentSourceLines("line one\nline two\n\nline four\n");
    expect(out.map((l) => l.text)).toEqual([
      "line one",
      "line two",
      "line four",
    ]);
  });

  it("returns an empty array when the input is all whitespace", () => {
    expect(segmentSourceLines("\n\n   \n")).toEqual([]);
  });

  it("preserves byte offsets", () => {
    const text = "a\nbb\nccc";
    const out = segmentSourceLines(text);
    for (const l of out) {
      expect(text.slice(l.start, l.end)).toBe(l.text);
    }
  });
});
