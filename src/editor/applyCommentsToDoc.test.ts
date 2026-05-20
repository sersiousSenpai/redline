// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { Comment } from "../types";
import { applyCommentsToDoc, type BlockHandle } from "./applyCommentsToDoc";

function fakeBlock(blockId: string, initial: string): BlockHandle & {
  md: string;
  lastMeta: string | null;
} {
  const h = {
    blockId,
    md: initial,
    lastMeta: null as string | null,
    getMarkdown: () => h.md,
    setMarkdown: (m: string, meta: { source: "rl-sync" }) => {
      h.md = m;
      h.lastMeta = meta.source;
    },
  };
  return h;
}

const base = new Map([
  ["blk-1", "Base one."],
  ["blk-2", "Base two."],
]);

const editComment: Comment = {
  id: "c-001",
  type: "edit",
  anchorId: "A.p1",
  blockId: "blk-1",
  body: "(edit)",
  edit: { original: "Base one.", revised: "Reconciled one." },
  createdAt: 0,
  status: "draft",
};

describe("applyCommentsToDoc", () => {
  it("pushes comment revisions into the document, tagged rl-sync", () => {
    const b1 = fakeBlock("blk-1", "Base one.");
    const b2 = fakeBlock("blk-2", "Base two.");
    const touched = applyCommentsToDoc([editComment], [b1, b2], base);
    expect(touched).toEqual(["blk-1"]);
    expect(b1.md).toBe("Reconciled one.");
    expect(b1.lastMeta).toBe("rl-sync");
    expect(b2.md).toBe("Base two."); // untouched, already at base
  });

  it("is idempotent — a second pass rewrites nothing", () => {
    const b1 = fakeBlock("blk-1", "Base one.");
    applyCommentsToDoc([editComment], [b1], base);
    expect(applyCommentsToDoc([editComment], [b1], base)).toEqual([]);
  });

  it("restores a block to base when its comment is withdrawn", () => {
    const b1 = fakeBlock("blk-1", "Reconciled one.");
    // No editor comment anymore → block must return to its base markdown.
    const touched = applyCommentsToDoc([], [b1], base);
    expect(touched).toEqual(["blk-1"]);
    expect(b1.md).toBe("Base one.");
  });
});
