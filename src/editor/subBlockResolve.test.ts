// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  blockKindForTag,
  computeSubBlockId,
  computeWordsInUnit,
  resolveSubBlockId,
  resolveWordsInUnit,
} from "./subBlockResolve";

describe("blockKindForTag", () => {
  it("maps code / list / table / blockquote to the line axis", () => {
    expect(blockKindForTag("PRE")).toBe("line");
    expect(blockKindForTag("CODE")).toBe("line");
    expect(blockKindForTag("UL")).toBe("line");
    expect(blockKindForTag("OL")).toBe("line");
    expect(blockKindForTag("LI")).toBe("line");
    expect(blockKindForTag("TABLE")).toBe("line");
    expect(blockKindForTag("TD")).toBe("line");
    expect(blockKindForTag("TH")).toBe("line");
    expect(blockKindForTag("BLOCKQUOTE")).toBe("line");
  });
  it("defaults everything else to the sentence axis", () => {
    expect(blockKindForTag("P")).toBe("sentence");
    expect(blockKindForTag("H1")).toBe("sentence");
    expect(blockKindForTag("H3")).toBe("sentence");
    expect(blockKindForTag("span")).toBe("sentence");
  });
});

describe("computeSubBlockId — prose (sentence axis)", () => {
  // "First sentence. Second sentence. Third sentence."
  //  0         1         2         3         4
  //  0123456789012345678901234567890123456789012345678
  //  ^                 ^                ^
  //  s1 0..15          s2 16..32        s3 33..48
  const text = "First sentence. Second sentence. Third sentence.";
  const blockId = "blk-aaaa1111";

  it("emits a whole-sentence id when the selection covers exactly one sentence", () => {
    expect(
      computeSubBlockId({
        blockId,
        blockText: text,
        kind: "sentence",
        charStart: 16,
        charEnd: 32,
      }),
    ).toBe("blk-aaaa1111.s2");
  });

  it("emits a single-word id when the selection covers exactly one word", () => {
    // "Second" at unit-relative chars 0..6 of sentence 2 → word 1 of s2.
    expect(
      computeSubBlockId({
        blockId,
        blockText: text,
        kind: "sentence",
        charStart: 16,
        charEnd: 22,
      }),
    ).toBe("blk-aaaa1111.s2.w1");
  });

  it("emits a word-range id when the selection covers contiguous whole words", () => {
    // Use a sentence without trailing punctuation glued to the last word
    // so the word boundaries inside the unit are unambiguous.
    const alt = "alpha beta gamma delta.";
    // "alpha beta" → chars 0..10 → words 1..2.
    expect(
      computeSubBlockId({
        blockId,
        blockText: alt,
        kind: "sentence",
        charStart: 0,
        charEnd: 10,
      }),
    ).toBe("blk-aaaa1111.s1.w1-w2");
    // "beta gamma" → chars 6..16 → words 2..3.
    expect(
      computeSubBlockId({
        blockId,
        blockText: alt,
        kind: "sentence",
        charStart: 6,
        charEnd: 16,
      }),
    ).toBe("blk-aaaa1111.s1.w2-w3");
  });

  it("returns undefined when the selection crosses a sentence boundary", () => {
    // From mid-s1 through mid-s2 — coarser than a single unit.
    expect(
      computeSubBlockId({
        blockId,
        blockText: text,
        kind: "sentence",
        charStart: 6,
        charEnd: 22,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the selection doesn't land on word boundaries", () => {
    // First three chars of "First" — partial word.
    expect(
      computeSubBlockId({
        blockId,
        blockText: text,
        kind: "sentence",
        charStart: 0,
        charEnd: 3,
      }),
    ).toBeUndefined();
  });

  it("returns undefined for a zero-length selection", () => {
    expect(
      computeSubBlockId({
        blockId,
        blockText: text,
        kind: "sentence",
        charStart: 5,
        charEnd: 5,
      }),
    ).toBeUndefined();
  });
});

describe("computeSubBlockId — code (line axis)", () => {
  const code = "fn main() {\n    println!(\"hi\");\n}";
  const blockId = "blk-bbbb2222";

  it("addresses the whole second line", () => {
    // Line 2 (1-based) is `    println!("hi");` starting at byte 12, ending
    // at byte 31 — but segmentSourceLines trims leading/trailing whitespace.
    // Let's compute via the actual segmenter result instead of hand-counting:
    // - line 1: "fn main() {" at 0..11
    // - line 2: "    println!(\"hi\");" at 12..31 trimmed → "println!(\"hi\");" at 16..31
    // - line 3: "}" at 32..33
    const id = computeSubBlockId({
      blockId,
      blockText: code,
      kind: "line",
      charStart: 16,
      charEnd: 31,
    });
    expect(id).toBe("blk-bbbb2222.l2");
  });
});

describe("computeWordsInUnit ↔ resolveWordsInUnit — unit-scoped word ranges", () => {
  const unit = "Second bullet item";

  it("whole-unit selection resolves to the full unit span", () => {
    expect(resolveWordsInUnit(unit, null)).toEqual({ start: 0, end: unit.length });
  });

  it("computes a single-word range and resolves it back", () => {
    // "Second" → chars 0..6 → word 1.
    const words = computeWordsInUnit(unit, 0, 6);
    expect(words).toEqual({ start: 1, end: 1 });
    const back = resolveWordsInUnit(unit, words);
    expect(unit.slice(back!.start, back!.end)).toBe("Second");
  });

  it("computes a contiguous word-range and resolves it back", () => {
    // "bullet item" → chars 7..18 → words 2..3.
    const words = computeWordsInUnit(unit, 7, 18);
    expect(words).toEqual({ start: 2, end: 3 });
    const back = resolveWordsInUnit(unit, words);
    expect(unit.slice(back!.start, back!.end)).toBe("bullet item");
  });

  it("returns null on a partial-word selection", () => {
    expect(computeWordsInUnit(unit, 0, 3)).toBeNull(); // "Sec"
  });

  it("returns null on an empty or out-of-bounds selection", () => {
    expect(computeWordsInUnit(unit, 5, 5)).toBeNull();
    expect(computeWordsInUnit(unit, -1, 6)).toBeNull();
    expect(computeWordsInUnit(unit, 0, unit.length + 1)).toBeNull();
  });

  it("returns null when a word index runs past the unit", () => {
    expect(resolveWordsInUnit(unit, { start: 1, end: 9 })).toBeNull();
  });
});

describe("resolveSubBlockId — round-trip via computed id", () => {
  it("computed id resolves back to the same char range (sentence)", () => {
    const text = "Alpha beta. Gamma delta epsilon. Zeta.";
    const id = computeSubBlockId({
      blockId: "blk-cafe",
      blockText: text,
      kind: "sentence",
      charStart: 18,
      charEnd: 23,
    });
    expect(id).toBe("blk-cafe.s2.w2");
    const resolved = resolveSubBlockId({
      blockText: text,
      kind: "sentence",
      subBlockId: id!,
    });
    expect(resolved).toEqual({ start: 18, end: 23 });
  });

  it("returns null when axis mismatch (sentence id on line block)", () => {
    expect(
      resolveSubBlockId({
        blockText: "code\nhere\n",
        kind: "line",
        subBlockId: "blk-x.s2",
      }),
    ).toBeNull();
  });

  it("returns null when sentence index is past the end", () => {
    expect(
      resolveSubBlockId({
        blockText: "Only one sentence.",
        kind: "sentence",
        subBlockId: "blk-x.s5",
      }),
    ).toBeNull();
  });

  it("returns null when word index is past the end of its unit", () => {
    expect(
      resolveSubBlockId({
        blockText: "Two words.",
        kind: "sentence",
        subBlockId: "blk-x.s1.w7",
      }),
    ).toBeNull();
  });

  it("returns null on a malformed id", () => {
    expect(
      resolveSubBlockId({
        blockText: "anything",
        kind: "sentence",
        subBlockId: "not a sidecar id",
      }),
    ).toBeNull();
  });

  it("survives a parent block reword as long as the addressed unit still exists", () => {
    // v1 had the comment on sentence 2. v2 rewords sentence 1 but leaves
    // sentence 2 intact — the id should still land on the right span.
    const v2 = "Different opener. Gamma delta epsilon. Final.";
    const resolved = resolveSubBlockId({
      blockText: v2,
      kind: "sentence",
      subBlockId: "blk-cafe.s2.w2",
    });
    // sentence 2 in v2 starts after "Different opener. " (length 18); word 2
    // ("delta") spans chars 24..29 of v2.
    expect(resolved).not.toBeNull();
    expect(v2.slice(resolved!.start, resolved!.end)).toBe("delta");
  });
});
