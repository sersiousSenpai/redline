import { describe, expect, it } from "vitest";

import type { ParagraphDiff } from "../diff";
import type { Section } from "../types";
import { redlineStatusByBlockId } from "./docModel";

function para(anchorId: string, blockId: string) {
  return { anchorId, blockId, markdown: "x", text: "x" };
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
