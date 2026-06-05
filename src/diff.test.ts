// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { computeParagraphDiff } from "./diff";
import type { Paragraph, Section } from "./types";

function para(
  anchorId: string,
  blockId: string,
  text: string,
  markdown: string = text,
): Paragraph {
  return { anchorId, blockId, markdown, text };
}

function section(
  anchorId: string,
  blockId: string,
  paragraphs: Paragraph[],
  children: Section[] = [],
): Section {
  return {
    anchorId,
    blockId,
    level: 1,
    title: "T",
    bodyMarkdown: "",
    children,
    paragraphs,
  };
}

describe("computeParagraphDiff — sentence-level decomposition (Phase D)", () => {
  it("decomposes a modified 4-sentence paragraph into per-sentence subBlocks", () => {
    const original =
      "First sentence. Second sentence here. Third one. Fourth.";
    const revised =
      "First sentence. Second sentence reworded. Third one. Fourth.";
    const prev: Section[] = [
      section("A", "blk-h", [para("A.p1", "blk-p1", original)]),
    ];
    const curr: Section[] = [
      section("A", "blk-h", [para("A.p1", "blk-p1", revised)]),
    ];
    const diff = computeParagraphDiff(curr, prev);
    const info = diff.get("A.p1");
    expect(info?.status).toBe("modified");
    expect(info?.subBlocks).toBeDefined();
    expect(info!.subBlocks!.map((e) => e.status)).toEqual([
      "unchanged",
      "modified",
      "unchanged",
      "unchanged",
    ]);
    expect(info!.subBlocks![1].subBlockId).toBe("blk-p1.s2");
    expect(info!.subBlocks![1].originalText).toBe("Second sentence here.");
  });

  it("does not decompose when sentence counts differ (reflow case)", () => {
    // v1 has 2 sentences, v2 has 3 — pair-by-index would be misleading,
    // so we keep the paragraph-level status and let the inline-marks
    // precision path handle the visible distinction.
    const prev: Section[] = [
      section("A", "blk-h", [para("A.p1", "blk-p1", "One. Two.")]),
    ];
    const curr: Section[] = [
      section("A", "blk-h", [
        para("A.p1", "blk-p1", "One. Two. Three sentence added."),
      ]),
    ];
    const info = computeParagraphDiff(curr, prev).get("A.p1");
    expect(info?.status).toBe("modified");
    expect(info?.subBlocks).toBeUndefined();
  });

  it("does not decompose code blocks (inline ins/del marks already pinpoint changes)", () => {
    const prev: Section[] = [
      section("A", "blk-h", [
        para(
          "A.p1",
          "blk-p1",
          "fn main() {\nold();\n}",
          "```rust\nfn main() {\nold();\n}\n```",
        ),
      ]),
    ];
    const curr: Section[] = [
      section("A", "blk-h", [
        para(
          "A.p1",
          "blk-p1",
          "fn main() {\nnew();\n}",
          "```rust\nfn main() {\nnew();\n}\n```",
        ),
      ]),
    ];
    const info = computeParagraphDiff(curr, prev).get("A.p1");
    expect(info?.status).toBe("modified");
    expect(info?.subBlocks).toBeUndefined();
  });

  it("does not decompose when the paragraph has no blockId", () => {
    const prev: Section[] = [
      section("A", "blk-h", [para("A.p1", "", "First. Second. Third.")]),
    ];
    const curr: Section[] = [
      section("A", "blk-h", [para("A.p1", "", "First. Second changed. Third.")]),
    ];
    const info = computeParagraphDiff(curr, prev).get("A.p1");
    expect(info?.status).toBe("modified");
    expect(info?.subBlocks).toBeUndefined();
  });
});
