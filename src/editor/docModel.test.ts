// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { computeParagraphDiff, type ParagraphDiff } from "../diff";
import type { Section } from "../types";
import { redlineStatusByBlockId, revisionEditByBlockId } from "./docModel";

function para(anchorId: string, blockId: string, text = "x") {
  return { anchorId, blockId, markdown: text, text };
}
function section(
  anchorId: string,
  blockId: string,
  paragraphs: ReturnType<typeof para>[],
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

describe("redlineStatusByBlockId", () => {
  it("projects per-anchor diff onto block ids (headings + nested paragraphs)", () => {
    const sections: Section[] = [
      section("A", "blk-h1", [para("A.p1", "blk-p1"), para("A.p2", "blk-p2")], [
        section("A.1", "blk-h2", [para("A.1.p1", "blk-p3")]),
      ]),
    ];
    const diff: ParagraphDiff = new Map([
      ["A.p1", { status: "modified", originalText: "old" }],
      ["A.p2", { status: "unchanged" }],
      ["A.1.p1", { status: "added" }],
      ["A.1", { status: "moved" }],
    ]);

    const map = redlineStatusByBlockId(sections, diff);
    expect(map.get("blk-p1")).toBe("modified");
    expect(map.has("blk-p2")).toBe(false); // unchanged is omitted
    expect(map.get("blk-p3")).toBe("added");
    expect(map.get("blk-h2")).toBe("moved");
  });

  it("returns an empty map when no diff is given", () => {
    expect(redlineStatusByBlockId([], undefined).size).toBe(0);
  });
});

describe("computeParagraphDiff + revisionEditByBlockId — Bug 2 round-trip", () => {
  // The Rust parser's positional-fallback rebinding ensures that a paragraph
  // whose text changed between revisions keeps its v_{n-1} blockId when the
  // containing section's paragraph count is preserved. With that contract in
  // place, the frontend diff's primary `prevByBlock` keying lands cleanly,
  // and the editor's `revisionEditByBlockId` projection lands on the right
  // block — even on the second consecutive edit of the same paragraph.
  it("modified block with preserved blockId routes via prevByBlock", () => {
    const prev: Section[] = [
      section("A", "blk-h", [para("A.p1", "blk-p1", "original")]),
    ];
    const curr: Section[] = [
      section("A", "blk-h", [para("A.p1", "blk-p1", "reworded")]),
    ];
    const diff = computeParagraphDiff(curr, prev);
    // Loose match: Phase D adds an optional `subBlocks` decomposition
    // alongside the status/originalText pair; this test cares about
    // routing, not the decomposition payload.
    expect(diff.get("A.p1")).toMatchObject({
      status: "modified",
      originalText: "original",
    });
    const edits = revisionEditByBlockId(curr, diff);
    expect(edits.get("blk-p1")).toEqual({
      status: "modified",
      originalText: "original",
    });
  });

  // Even if rebinding fails (e.g. the prev paragraph count differs and the
  // positional fallback is skipped), the diff falls back to anchorId keying.
  // `revisionEditByBlockId` then stores under the *current* blockId — the
  // editor's reconcile pass looks up by that, so the redline still renders.
  it("falls back to anchorId when current blockId is fresh", () => {
    const prev: Section[] = [
      section("A", "blk-h", [para("A.p1", "blk-old", "original")]),
    ];
    const curr: Section[] = [
      section("A", "blk-h", [para("A.p1", "blk-fresh", "reworded")]),
    ];
    const diff = computeParagraphDiff(curr, prev);
    // Loose match: Phase D adds an optional `subBlocks` decomposition
    // alongside the status/originalText pair; this test cares about
    // routing, not the decomposition payload.
    expect(diff.get("A.p1")).toMatchObject({
      status: "modified",
      originalText: "original",
    });
    const edits = revisionEditByBlockId(curr, diff);
    // The redline projection keys on the *current* (fresh) blockId — that's
    // what the editor's PM nodes carry, so the lookup matches.
    expect(edits.get("blk-fresh")).toEqual({
      status: "modified",
      originalText: "original",
    });
    expect(edits.has("blk-old")).toBe(false);
  });
});
