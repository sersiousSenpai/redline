// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { Comment } from "../types";
import { buildDraftCommentUpdate } from "./draftCommentUpdate";

function draft(over: Partial<Comment>): Comment {
  return {
    id: "c-001",
    type: "feedback",
    anchorId: "s1p1",
    body: "original body",
    createdAt: 0,
    status: "draft",
    ...over,
  } as Comment;
}

describe("buildDraftCommentUpdate", () => {
  it("sends only body for a feedback comment", () => {
    const u = buildDraftCommentUpdate(draft({}), "new text");
    expect(u).toEqual({ body: "new text" });
  });

  it("never includes selection or blockId (anchor-unchanged contract)", () => {
    const c = draft({
      blockId: "blk-1",
      selection: { charStart: 0, charEnd: 4, quotedText: "orig" },
    });
    const u = buildDraftCommentUpdate(c, "new", "rev");
    expect("selection" in u).toBe(false);
    expect("blockId" in u).toBe(false);
    expect("scope" in u).toBe(false);
    expect("structural" in u).toBe(false);
  });

  it("keeps the prior body when the draft is blanked (non-edit)", () => {
    const u = buildDraftCommentUpdate(draft({}), "   ");
    expect(u.body).toBe("original body");
  });

  it("updates edit.revised while pinning edit.original", () => {
    const c = draft({
      type: "edit",
      body: "(edit)",
      edit: { original: "the old words", revised: "first attempt" },
    });
    const u = buildDraftCommentUpdate(c, "", "second attempt");
    expect(u.edit).toEqual({
      original: "the old words",
      revised: "second attempt",
    });
    expect(u.body).toBe("(edit)");
  });

  it("drops an emptied revised text instead of sending it", () => {
    const c = draft({
      type: "edit",
      body: "(edit)",
      edit: { original: "keep me", revised: "was here" },
    });
    const u = buildDraftCommentUpdate(c, "a note", "   ");
    expect(u.edit).toBeUndefined();
    expect(u.body).toBe("a note");
  });

  it("ignores revisedDraft on a non-edit comment", () => {
    const u = buildDraftCommentUpdate(draft({}), "body", "stray revised");
    expect(u.edit).toBeUndefined();
  });

  it("restores the (edit) placeholder when an edit note is blanked", () => {
    const c = draft({
      type: "edit",
      body: "old note",
      edit: { original: "o", revised: "r" },
    });
    const u = buildDraftCommentUpdate(c, "", "r2");
    expect(u.body).toBe("(edit)");
  });
});
