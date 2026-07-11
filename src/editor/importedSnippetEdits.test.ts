// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildChangeSet, diffToCommentOps } from "./changeLedger";
import { serializeBlocks } from "./docModel";
import {
  acceptBlockSuggestions,
  materializeSuggestions,
  rejectBlockSuggestions,
} from "./suggestions";
import { planExtensions } from "./extensions/planExtensions";
import { planMarkdownToDoc } from "./markdown";
import type { Comment } from "../types";

/**
 * Share-viewer returns arrive as *selection-scoped* edits (edit.original is
 * the reviewer's selected words, not the block). These tests pin the two
 * halves of the fix for the whole-paragraph-strike bug:
 *
 *  - a reconstructed whole-block edit materializes as a fine-grained word
 *    diff (only the touched words struck/inserted);
 *  - a snippet-shaped edit that reaches the editor anyway (persisted before
 *    the import normalization existed) heals in place — or, when its snippet
 *    can't be located, stays card-only rather than striking the paragraph.
 */

const editors: Editor[] = [];
function makeEditor(markdown: string): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: planExtensions({}),
    content: planMarkdownToDoc(markdown).toJSON(),
  });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

const BODY =
  "The plan evaluates each facet against the actual codebase and turns the surviving ideas into a phased roadmap.";

const PLAN = [
  "<!-- rl:blk-aaaa1111 -->",
  "# Title",
  "",
  "<!-- rl:blk-bbbb2222 -->",
  BODY,
  "",
].join("\n");

const anchors = new Map([
  ["blk-aaaa1111", "A"],
  ["blk-bbbb2222", "A.p1"],
]);

function seedOf(editor: Editor): Map<string, string> {
  return new Map(
    serializeBlocks(editor, anchors).map((b) => [b.blockId, b.markdown]),
  );
}

function importedComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c-101",
    type: "edit",
    anchorId: "A.p1",
    blockId: "blk-bbbb2222",
    body: "(edit)",
    createdAt: 0,
    status: "draft",
    reviewer: "Joe",
    ...overrides,
  };
}

/** The words carrying the given mark — the LCS is free to attach whitespace
 *  (and reuse equal separator tokens) around a changed run, so assertions
 *  compare word sets, not exact byte runs. */
function wordsByMark(editor: Editor, name: string): string[] {
  let out = "";
  editor.state.doc.descendants((n) => {
    if (n.isText && n.marks.some((m) => m.type.name === name)) {
      out += (n.text ?? "") + " ";
    }
    return true;
  });
  return out.split(/\s+/).filter(Boolean);
}

describe("imported whole-block edits materialize fine-grained", () => {
  it("marks only the edited words, the rest stays unmarked", () => {
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    const comment = importedComment({
      edit: {
        original: BODY,
        revised: BODY.replace("each facet", "every single facet"),
      },
    });

    expect(materializeSuggestions(editor, [comment], seed)).toEqual([
      "blk-bbbb2222",
    ]);
    // Only the changed words carry marks — not the paragraph.
    expect(wordsByMark(editor, "rl_del")).toEqual(["each"]);
    expect(wordsByMark(editor, "rl_ins")).toEqual(["every", "single"]);
  });
});

describe("legacy snippet-shaped edits (persisted pre-normalization)", () => {
  const quoted = "each facet";
  const snippetComment = () =>
    importedComment({
      edit: { original: quoted, revised: "every single facet" },
      selection: {
        charStart: BODY.indexOf(quoted),
        charEnd: BODY.indexOf(quoted) + quoted.length,
        quotedText: quoted,
      },
    });

  it("heals on materialize: fine-grained marks, not a paragraph strike", () => {
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);

    expect(materializeSuggestions(editor, [snippetComment()], seed)).toEqual([
      "blk-bbbb2222",
    ]);
    expect(wordsByMark(editor, "rl_del")).toEqual(["each"]);
    expect(wordsByMark(editor, "rl_ins")).toEqual(["every", "single"]);
  });

  it("the sync flush then persists the whole-block edit (healing converges)", () => {
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    const comment = snippetComment();
    materializeSuggestions(editor, [comment], seed);

    const base = [...seed].map(([blockId, markdown]) => ({
      blockId,
      anchorId: anchors.get(blockId) ?? blockId,
      markdown,
    }));
    const ops = diffToCommentOps(
      buildChangeSet(base, serializeBlocks(editor, anchors)),
      [comment],
    );
    expect(ops).toEqual([
      {
        op: "update",
        id: "c-101",
        update: {
          edit: {
            original: BODY,
            revised: BODY.replace("each facet", "every single facet"),
          },
        },
      },
    ]);
  });

  it("accept-all yields the revised block; reject restores the seed", () => {
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    materializeSuggestions(editor, [snippetComment()], seed);

    expect(acceptBlockSuggestions(editor, "blk-bbbb2222")).toBe(true);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      BODY.replace("each facet", "every single facet"),
    );

    const editor2 = makeEditor(PLAN);
    materializeSuggestions(editor2, [snippetComment()], seedOf(editor2));
    expect(
      rejectBlockSuggestions(editor2, "blk-bbbb2222", seed.get("blk-bbbb2222")),
    ).toBe(true);
    expect(serializeBlocks(editor2, anchors)[1].markdown).toBe(BODY);
  });

  it("stays card-only when the snippet can't be located (no false strike)", () => {
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    const orphaned = importedComment({
      edit: { original: "vanished words", revised: "whatever" },
      selection: { charStart: 0, charEnd: 14, quotedText: "vanished words" },
    });

    const before = editor.state.doc.toJSON();
    expect(materializeSuggestions(editor, [orphaned], seed)).toEqual([]);
    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(wordsByMark(editor, "rl_del")).toEqual([]);
    expect(wordsByMark(editor, "rl_ins")).toEqual([]);
  });

  it("stays card-only when the snippet edit carries no selection", () => {
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    const noSelection = importedComment({
      edit: { original: "each facet", revised: "every facet" },
    });

    const before = editor.state.doc.toJSON();
    expect(materializeSuggestions(editor, [noSelection], seed)).toEqual([]);
    expect(editor.state.doc.toJSON()).toEqual(before);
  });
});

describe("multiple edit comments on one block", () => {
  it("materializes exactly one; the doc stays consistent", () => {
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    const first = importedComment({
      edit: { original: BODY, revised: BODY.replace("each", "every") },
    });
    const second = importedComment({
      id: "c-102",
      edit: { original: BODY, revised: BODY.replace("roadmap", "program") },
    });

    expect(materializeSuggestions(editor, [first, second], seed)).toEqual([
      "blk-bbbb2222",
    ]);
    // First wins; the block reads as its accept-all serialization.
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      BODY.replace("each", "every"),
    );
    // And a re-run keeps the doc stable (pending marks → skip).
    expect(
      materializeSuggestions(editor, [first, second], seed),
    ).toEqual([]);
  });
});
