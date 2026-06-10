// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import type { Comment } from "../types";
import { buildChangeSet, diffToCommentOps } from "./changeLedger";
import { serializeBlocks } from "./docModel";
import { planExtensions } from "./extensions/planExtensions";
import { planMarkdownToDoc } from "./markdown";

/**
 * GOLDEN — the editor→backend wire contract, byte-pinned.
 *
 * These assertions capture the exact comment payloads the editor pipeline
 * emitted BEFORE the M3 marks-as-truth rework. The Claude Code hook contract
 * (feedback.rs [edit]/[feedback]/[question] tags, REDLINE_RESOLUTIONS) is a
 * pure function of these payloads, so as long as this file passes unchanged,
 * the hook contract is preserved. Do not "re-baseline" this file casually:
 * a diff here is a wire-format break, not a refactor.
 */

const editors: Editor[] = [];
function makeEditor(markdown: string): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: planExtensions(),
    content: planMarkdownToDoc(markdown).toJSON(),
  });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

const PLAN = [
  "<!-- rl:blk-aaaa1111 -->",
  "# Title",
  "",
  "<!-- rl:blk-bbbb2222 -->",
  "Original body paragraph.",
  "",
  "<!-- rl:blk-cccc3333 -->",
  "Second body paragraph.",
  "",
].join("\n");

const anchors = new Map([
  ["blk-aaaa1111", "A"],
  ["blk-bbbb2222", "A.p1"],
  ["blk-cccc3333", "A.p2"],
]);

/** The revision's published per-block markdown — the diff basis. */
function seedBlocks() {
  return [
    { blockId: "blk-aaaa1111", anchorId: "A", markdown: "# Title" },
    {
      blockId: "blk-bbbb2222",
      anchorId: "A.p1",
      markdown: "Original body paragraph.",
    },
    {
      blockId: "blk-cccc3333",
      anchorId: "A.p2",
      markdown: "Second body paragraph.",
    },
  ];
}

/** Caret position just inside a block's first text. */
function textStart(editor: Editor, blockId: string): number {
  let at = -1;
  editor.state.doc.forEach((node, pos) => {
    if (node.attrs?.blockId === blockId) at = pos + 1;
  });
  return at;
}

function ops(editor: Editor, comments: Comment[] = []) {
  return diffToCommentOps(
    buildChangeSet(seedBlocks(), serializeBlocks(editor, anchors)),
    comments,
  );
}

describe("GOLDEN editor→backend sync ops", () => {
  it("typed insertion → one edit add with exact {original, revised}", () => {
    const editor = makeEditor(PLAN);
    const end =
      textStart(editor, "blk-bbbb2222") + "Original body paragraph.".length;
    editor.chain().setTextSelection(end).insertContent(" Now appended.").run();

    expect(ops(editor)).toEqual([
      {
        op: "add",
        request: {
          type: "edit",
          anchorId: "A.p1",
          blockId: "blk-bbbb2222",
          body: "(edit)",
          edit: {
            original: "Original body paragraph.",
            revised: "Original body paragraph. Now appended.",
          },
        },
      },
    ]);
  });

  it("tracked deletion (Backspace strike) → edit add with struck word dropped", () => {
    const editor = makeEditor(PLAN);
    const start = textStart(editor, "blk-bbbb2222");
    editor
      .chain()
      .setTextSelection({ from: start + 9, to: start + 14 }) // "body "
      .run();
    editor.commands.keyboardShortcut("Backspace");

    expect(ops(editor)).toEqual([
      {
        op: "add",
        request: {
          type: "edit",
          anchorId: "A.p1",
          blockId: "blk-bbbb2222",
          body: "(edit)",
          edit: {
            original: "Original body paragraph.",
            revised: "Original paragraph.",
          },
        },
      },
    ]);
  });

  it("combined insert+strike in one block → single edit comment, then update on further edits", () => {
    const editor = makeEditor(PLAN);
    const start = textStart(editor, "blk-cccc3333");
    editor
      .chain()
      .setTextSelection({ from: start, to: start + 7 }) // "Second "
      .run();
    editor.commands.keyboardShortcut("Backspace");
    const first = ops(editor);
    expect(first).toEqual([
      {
        op: "add",
        request: {
          type: "edit",
          anchorId: "A.p2",
          blockId: "blk-cccc3333",
          body: "(edit)",
          edit: {
            original: "Second body paragraph.",
            revised: "body paragraph.",
          },
        },
      },
    ]);

    // Persisted as c-001 → a further edit becomes an update, never a new add.
    const persisted: Comment = {
      id: "c-001",
      type: "edit",
      anchorId: "A.p2",
      blockId: "blk-cccc3333",
      body: "(edit)",
      edit: first[0].op === "add" ? first[0].request.edit! : { original: "", revised: "" },
      createdAt: 0,
      status: "draft",
    };
    const end = textStart(editor, "blk-cccc3333") + "Second body paragraph.".length;
    editor.chain().setTextSelection(end).insertContent(" More.").run();
    expect(ops(editor, [persisted])).toEqual([
      {
        op: "update",
        id: "c-001",
        update: {
          edit: {
            original: "Second body paragraph.",
            revised: "body paragraph. More.",
          },
        },
      },
    ]);
  });

  it("whole-block removal → block-delete structural op with exact payload", () => {
    const editor = makeEditor(PLAN);
    let from = -1;
    let to = -1;
    editor.state.doc.forEach((node, pos) => {
      if (node.attrs?.blockId === "blk-cccc3333") {
        from = pos;
        to = pos + node.nodeSize;
      }
    });
    editor.view.dispatch(editor.state.tr.delete(from, to));

    expect(ops(editor)).toEqual([
      {
        op: "add",
        request: {
          type: "block-delete",
          anchorId: "A.p2",
          blockId: "blk-cccc3333",
          body: "(structural)",
          structural: {
            op: "delete",
            blockId: "blk-cccc3333",
            fromAnchor: "A.p2",
            markdown: "Second body paragraph.",
          },
        },
      },
    ]);
  });

  it("reopened edit comment is updated in place (reopen continuity)", () => {
    const editor = makeEditor(PLAN);
    const reopened: Comment = {
      id: "c-007",
      type: "edit",
      anchorId: "A.p1",
      blockId: "blk-bbbb2222",
      body: "(edit)",
      edit: {
        original: "Original body paragraph.",
        revised: "Original body paragraph. Prior round.",
      },
      createdAt: 0,
      status: "reopened",
      reopenNote: "still want this",
    };
    const end =
      textStart(editor, "blk-bbbb2222") + "Original body paragraph.".length;
    editor.chain().setTextSelection(end).insertContent(" New round.").run();

    expect(ops(editor, [reopened])).toEqual([
      {
        op: "update",
        id: "c-007",
        update: {
          edit: {
            original: "Original body paragraph.",
            revised: "Original body paragraph. New round.",
          },
        },
      },
    ]);
  });

  it("reverted document → zero ops against empty comment set; delete op against a stale draft", () => {
    const editor = makeEditor(PLAN);
    expect(ops(editor)).toEqual([]);

    const stale: Comment = {
      id: "c-002",
      type: "edit",
      anchorId: "A.p1",
      blockId: "blk-bbbb2222",
      body: "(edit)",
      edit: { original: "Original body paragraph.", revised: "Gone." },
      createdAt: 0,
      status: "draft",
    };
    expect(ops(editor, [stale])).toEqual([{ op: "delete", id: "c-002" }]);
  });
});
