// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { planMarkdownToDoc } from "./markdown";
import { textOffsetToPos } from "./textOffset";

/** `textContent` offsets → block-relative doc positions, checked through
 *  `textBetween` so the assertions read as the characters a range covers. */
describe("textOffsetToPos", () => {
  const doc = planMarkdownToDoc(
    ["<!-- rl:blk-l -->", "- One", "- Two", "- Three", ""].join("\n"),
  );
  // Absolute position: the list is the doc's first block, so `+1` enters it.
  const abs = (offset: number, bias: 1 | -1) => {
    const rel = textOffsetToPos(doc.child(0), offset, bias);
    return rel === null ? null : 1 + rel;
  };

  it("maps offsets past item 1 across the list-item tokens", () => {
    // "OneTwoThree": "Two" is [3, 6), "Three" is [6, 11).
    expect(doc.textBetween(abs(3, 1)!, abs(6, -1)!)).toBe("Two");
    expect(doc.textBetween(abs(7, 1)!, abs(11, -1)!)).toBe("hree");
  });

  it("resolves a boundary offset by bias", () => {
    // Offset 3 is both the end of "One" and the start of "Two".
    expect(doc.resolve(abs(3, -1)!).parent.textContent).toBe("One");
    expect(doc.resolve(abs(3, 1)!).parent.textContent).toBe("Two");
  });

  it("handles the ends of the text and rejects offsets past them", () => {
    expect(doc.resolve(abs(0, 1)!).parent.textContent).toBe("One");
    expect(doc.textBetween(abs(0, 1)!, abs(11, 1)!)).toBe("OneTwoThree");
    expect(abs(12, 1)).toBeNull();
    expect(abs(12, -1)).toBeNull();
  });

  it("steps over a zero-width hard break", () => {
    const para = planMarkdownToDoc("Alpha one\\\nBeta two").child(0);
    expect(para.textContent).toBe("Alpha oneBeta two");
    // Forward bias lands after the break, so "Beta" doesn't swallow it.
    const from = textOffsetToPos(para, 9, 1)!;
    const to = textOffsetToPos(para, 13, -1)!;
    expect(to - from).toBe(4);
    expect(para.textBetween(from, to)).toBe("Beta");
  });
});
