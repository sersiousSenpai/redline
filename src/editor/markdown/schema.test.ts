// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { planSchema } from "./schema";

/**
 * Regression gate for a bug that kept coming back: Word-style track-changes
 * deletes by *marking* text `rl_del` in place, but the base `code_block` node
 * spec ships `marks: ''` (forbids every mark). ProseMirror then silently drops
 * the `addMark`, so strike/delete inside a fenced code block did nothing. Every
 * schema rebuild that re-swapped `codeBlock` for `richCodeBlock()` faithfully
 * carried the `marks: ''` forward and the bug returned. These assertions use
 * ProseMirror's own predicate (`allowsMarkType`, the exact check that dropped
 * the mark) plus a real transaction, so a future rebuild that forgets the
 * `marks` widening goes red immediately.
 */
describe("codeBlock schema — track-change marks", () => {
  const s = planSchema();

  it("permits rl_ins/rl_del but still forbids formatting marks (code stays literal)", () => {
    const cb = s.nodes.codeBlock;
    expect(cb.spec.code).toBe(true);
    expect(cb.allowsMarkType(s.marks.rl_del)).toBe(true);
    expect(cb.allowsMarkType(s.marks.rl_ins)).toBe(true);
    expect(cb.allowsMarkType(s.marks.bold)).toBe(false);
    expect(cb.allowsMarkType(s.marks.italic)).toBe(false);
  });

  it("actually lands an rl_del mark added inside a code block", () => {
    // doc > codeBlock > text("const x = 1;"): the text occupies positions 1..13.
    const cb = s.nodes.codeBlock.create({ language: "ts" }, s.text("const x = 1;"));
    const doc = s.nodes.doc.create(null, cb);
    const state = EditorState.create({ schema: s, doc });

    // Strike "const" (positions 1..6) exactly as trackedDelete would.
    const tr = state.tr.addMark(1, 6, s.marks.rl_del.create({ status: "pending" }));
    const next = state.apply(tr);

    let struck = "";
    next.doc.nodesBetween(1, 6, (n) => {
      if (n.isText && n.marks.some((m) => m.type.name === "rl_del")) {
        struck += n.text ?? "";
      }
    });
    // Before the fix this was "" — the mark vanished on a marks:'' node.
    expect(struck).toBe("const");
  });
});
