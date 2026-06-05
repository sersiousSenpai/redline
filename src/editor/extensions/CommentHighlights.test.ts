// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { resolveRange, type CommentHighlightRange } from "./CommentHighlights";

const range = (over: Partial<CommentHighlightRange>): CommentHighlightRange => ({
  commentId: "c1",
  blockId: "blk-x",
  charStart: 0,
  charEnd: 0,
  quotedText: "",
  muted: false,
  ...over,
});

describe("resolveRange — sub-block tier is self-validating", () => {
  // "First sentence. Second sentence." — s1 = "First sentence.", s2 begins at 16.
  const text = "First sentence. Second sentence.";

  it("falls through to the char range when a stale sub-block id resolves to the wrong text", () => {
    // The stored sub-block id points at sentence 1, but the comment actually
    // quotes sentence 2 (block content drifted since capture). The guard must
    // reject the mismatched sub-block hit and honor the char range instead.
    const r = resolveRange(
      text,
      "P",
      range({
        charStart: 16,
        charEnd: 31,
        quotedText: "Second sentence",
        subBlockId: "blk-x.s1",
      }),
    );
    expect(r).toEqual({ from: 16, to: 31 });
  });

  it("honors a sub-block id whose slice matches the quoted text", () => {
    const r = resolveRange(
      text,
      "P",
      range({
        charStart: 0,
        charEnd: 15,
        quotedText: "First sentence.",
        subBlockId: "blk-x.s1",
      }),
    );
    expect(r).toEqual({ from: 0, to: 15 });
  });

  it("self-heals via quotedText when char offsets drift and no sub-block id is set", () => {
    const r = resolveRange(
      text,
      "P",
      range({
        charStart: 99,
        charEnd: 110,
        quotedText: "Second sentence",
      }),
    );
    expect(r).toEqual({ from: 16, to: 31 });
  });
});
