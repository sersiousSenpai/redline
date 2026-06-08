// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";

import { planMarkdownToDoc } from "./markdown/parser";
import { parseSidecarIdTyped } from "./markdown/sidecar";
import { resolveWordsInUnit } from "./subBlockResolve";
import { findUnitNode } from "./unitResolve";

/**
 * The load-bearing invariant of the granular-anchoring rework: a `.lN[.wM]`
 * line-axis id minted on capture must resolve, through `findUnitNode` +
 * `resolveWordsInUnit`, back to the exact characters it named. This mirrors the
 * position math in `CommentHighlights` (`blockOffset + textblockPos + 1 +
 * charBase + wordStart`) and asserts it against `doc.textBetween`, so a drift
 * between the capture index and the PM descendant walk would fail here.
 */

const PLAN = [
  "<!-- rl:blk-list1 -->",
  "- First bullet item",
  "- Second bullet item",
  "- Third bullet item",
  "",
  "<!-- rl:blk-code1 -->",
  "```js",
  "const a = 1;",
  "const b = 2;",
  "const c = 3;",
  "```",
  "",
  "<!-- rl:blk-tbl1 -->",
  "| Name | Role |",
  "| --- | --- |",
  "| Alice | Admin |",
  "| Bob | User |",
  "",
].join("\n");

/** Replay the `CommentHighlights` unit-path math: resolve a stored sub-block
 *  id to the text it points at in the live doc. Returns `null` when the id
 *  doesn't land (the highlight would fall back to char/quotedText tiers). */
function resolveIdToText(
  doc: PMNode,
  blockId: string,
  subBlockId: string,
): string | null {
  const parsed = parseSidecarIdTyped(subBlockId);
  if (!parsed || parsed.kind !== "subBlock" || parsed.axis.kind !== "line") {
    return null;
  }
  let out: string | null = null;
  doc.forEach((block, offset) => {
    if (block.attrs?.blockId !== blockId) return;
    const unit = findUnitNode(block, parsed.axis);
    if (!unit) return;
    const wr = resolveWordsInUnit(unit.unitText, parsed.words);
    if (!wr) return;
    const base = offset + unit.contentStart + unit.charBase;
    out = doc.textBetween(base + wr.start, base + wr.end);
  });
  return out;
}

describe("findUnitNode — line-axis position identity", () => {
  const doc = planMarkdownToDoc(PLAN);

  it("resolves a whole list item", () => {
    expect(resolveIdToText(doc, "blk-list1", "blk-list1.l2")).toBe(
      "Second bullet item",
    );
  });

  it("resolves a word and a word-range inside a list item", () => {
    expect(resolveIdToText(doc, "blk-list1", "blk-list1.l2.w1")).toBe("Second");
    expect(resolveIdToText(doc, "blk-list1", "blk-list1.l3.w2-w3")).toBe(
      "bullet item",
    );
  });

  it("resolves a whole code source line and a word inside it", () => {
    expect(resolveIdToText(doc, "blk-code1", "blk-code1.l2")).toBe(
      "const b = 2;",
    );
    // line 2 word 1 = "const"; word 3 = "2;".
    expect(resolveIdToText(doc, "blk-code1", "blk-code1.l2.w1")).toBe("const");
    expect(resolveIdToText(doc, "blk-code1", "blk-code1.l3.w1")).toBe("const");
  });

  it("resolves table cells in row-major order (header + body)", () => {
    expect(resolveIdToText(doc, "blk-tbl1", "blk-tbl1.l1")).toBe("Name"); // header
    expect(resolveIdToText(doc, "blk-tbl1", "blk-tbl1.l2")).toBe("Role"); // header
    expect(resolveIdToText(doc, "blk-tbl1", "blk-tbl1.l3")).toBe("Alice"); // r1c1
    expect(resolveIdToText(doc, "blk-tbl1", "blk-tbl1.l4")).toBe("Admin"); // r1c2
    expect(resolveIdToText(doc, "blk-tbl1", "blk-tbl1.l5")).toBe("Bob"); // r2c1
    expect(resolveIdToText(doc, "blk-tbl1", "blk-tbl1.l6")).toBe("User"); // r2c2
  });

  it("returns null for an index past the end (self-heals via fallback)", () => {
    expect(resolveIdToText(doc, "blk-list1", "blk-list1.l9")).toBeNull();
    expect(resolveIdToText(doc, "blk-tbl1", "blk-tbl1.l99")).toBeNull();
  });
});
