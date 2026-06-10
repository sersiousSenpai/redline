// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildChangeSet, diffToCommentOps } from "./changeLedger";
import {
  applyRevisionRedline,
  serializeBlocks,
  type RevisionEdit,
} from "./docModel";
import {
  materializeSuggestions,
  rejectBlockSuggestions,
} from "./suggestions";
import { planExtensions } from "./extensions/planExtensions";
import { planMarkdownToDoc } from "./markdown";
import type { Comment } from "../types";

/**
 * M3: suggestion marks in the document are the source of truth; the sidebar
 * is a projection. serializeBlocks (accept-all) feeds the changeLedger
 * engine against the revision seed, materializeSuggestions imports proposals
 * the doc doesn't carry yet, and rejectBlockSuggestions translates explicit
 * sidebar intent (delete/submit) back into the document.
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
].join("\n");

const anchors = new Map([
  ["blk-aaaa1111", "A"],
  ["blk-bbbb2222", "A.p1"],
]);

describe("PlanEditor doc↔comment sync", () => {
  it("serializeBlocks yields blockId/anchor/markdown per top-level block", () => {
    const editor = makeEditor(PLAN);
    const blocks = serializeBlocks(editor, anchors);
    expect(blocks.map((b) => b.blockId)).toEqual([
      "blk-aaaa1111",
      "blk-bbbb2222",
    ]);
    expect(blocks[0].anchorId).toBe("A");
    expect(blocks[1].markdown).toBe("Original body paragraph.");
  });

  it("an edited block becomes one 'edit' add op via the existing ledger", () => {
    const base = serializeBlocks(makeEditor(PLAN), anchors);
    const edited = serializeBlocks(
      makeEditor(PLAN.replace("Original body paragraph.", "Revised body.")),
      anchors,
    );
    const changes = buildChangeSet(base, edited);
    const ops = diffToCommentOps(changes, []);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe("add");
    if (ops[0].op === "add") {
      expect(ops[0].request.type).toBe("edit");
      expect(ops[0].request.blockId).toBe("blk-bbbb2222");
      expect(ops[0].request.edit).toEqual({
        original: "Original body paragraph.",
        revised: "Revised body.",
      });
    }
  });

  it("materializes an edit comment as pending marks, idempotently", () => {
    const editor = makeEditor(PLAN);
    const seed = new Map(
      serializeBlocks(editor, anchors).map((b) => [b.blockId, b.markdown]),
    );
    const comment: Comment = {
      id: "c-001",
      type: "edit",
      anchorId: "A.p1",
      blockId: "blk-bbbb2222",
      body: "(edit)",
      edit: {
        original: "Original body paragraph.",
        revised: "Original body sentence.",
      },
      createdAt: 0,
      status: "draft",
    };

    const first = materializeSuggestions(editor, [comment], seed);
    expect(first).toEqual(["blk-bbbb2222"]);

    // The document carries Word-style tracked-change marks with suggestion
    // identity (pending status = open proposal feeding the projection)…
    const pending = new Map<string, string>();
    editor.state.doc.descendants((n) => {
      n.marks.forEach((m) => {
        if (m.type.name === "rl_ins" || m.type.name === "rl_del") {
          pending.set(m.type.name, m.attrs.status);
        }
      });
    });
    expect(pending.get("rl_del")).toBe("pending");
    expect(pending.get("rl_ins")).toBe("pending");

    // …yet accept-all serialization yields clean revised text, so the
    // changeLedger projection terminates (no phantom re-edit).
    const blocks = serializeBlocks(editor, anchors);
    expect(blocks[1].markdown).toBe("Original body sentence.");
    expect(blocks[0].blockId).toBe("blk-aaaa1111"); // untouched block intact
    const ops = diffToCommentOps(
      buildChangeSet(
        [...seed].map(([blockId, markdown]) => ({
          blockId,
          anchorId: anchors.get(blockId) ?? blockId,
          markdown,
        })),
        blocks,
      ),
      [comment],
    );
    expect(ops).toEqual([]); // sync sees the edit already mirrored

    // Idempotent: the block now carries pending marks → never rewritten.
    const second = materializeSuggestions(editor, [comment], seed);
    expect(second).toEqual([]);
  });

  it("never rewrites a block the document has diverged on (doc wins)", () => {
    const editor = makeEditor(PLAN);
    const seed = new Map(
      serializeBlocks(editor, anchors).map((b) => [b.blockId, b.markdown]),
    );
    // The user types into the block first (live suggestion marks land)…
    const end = bodyTextStart(editor) + "Original body paragraph.".length;
    editor.chain().setTextSelection(end).insertContent(" typed").run();

    // …then a stale sidebar proposal for the same block must not clobber it.
    const comment: Comment = {
      id: "c-001",
      type: "edit",
      anchorId: "A.p1",
      blockId: "blk-bbbb2222",
      body: "(edit)",
      edit: { original: "Original body paragraph.", revised: "Other text." },
      createdAt: 0,
      status: "draft",
    };
    expect(materializeSuggestions(editor, [comment], seed)).toEqual([]);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body paragraph. typed",
    );
  });

  it("rejectBlockSuggestions removes insertions and unstrikes deletions", () => {
    const editor = makeEditor(PLAN);
    const end = bodyTextStart(editor) + "Original body paragraph.".length;
    editor.chain().setTextSelection(end).insertContent(" extra").run();
    const start = bodyTextStart(editor);
    editor
      .chain()
      .setTextSelection({ from: start + 9, to: start + 14 }) // "body "
      .run();
    editor.commands.keyboardShortcut("Backspace");
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original paragraph. extra",
    );

    // Explicit sidebar intent (comment deleted) → proposal rejected in doc.
    expect(
      rejectBlockSuggestions(editor, "blk-bbbb2222", "Original body paragraph."),
    ).toBe(true);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body paragraph.",
    );
    expect(markNames(editor).has("rl_ins")).toBe(false);
    expect(markNames(editor).has("rl_del")).toBe(false);
    // Already pristine → no-op.
    expect(
      rejectBlockSuggestions(editor, "blk-bbbb2222", "Original body paragraph."),
    ).toBe(false);
  });

  it("rejectBlockSuggestions restores a mark-less edit from the seed", () => {
    const editor = makeEditor(PLAN);
    // Simulate a mark-less divergence (e.g. a formatting toggle) by writing
    // the block body directly with an rl-sync transaction.
    let from = -1;
    let to = -1;
    editor.state.doc.forEach((node, pos) => {
      if (node.attrs?.blockId === "blk-bbbb2222") {
        from = pos;
        to = pos + node.nodeSize;
      }
    });
    const para = editor.schema.nodes.paragraph.create(
      { blockId: "blk-bbbb2222" },
      editor.schema.text("Silently different."),
    );
    const tr = editor.state.tr.replaceWith(from, to, para);
    tr.setMeta("rl-sync", true);
    editor.view.dispatch(tr);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Silently different.",
    );

    expect(
      rejectBlockSuggestions(editor, "blk-bbbb2222", "Original body paragraph."),
    ).toBe(true);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body paragraph.",
    );
  });

  it("folds revision redline into inline insertions only, idempotently", () => {
    const editor = makeEditor(PLAN);
    const revisions = new Map<string, RevisionEdit>([
      [
        "blk-bbbb2222",
        { status: "modified", originalText: "Original draft paragraph." },
      ],
    ]);

    const first = applyRevisionRedline(editor, revisions, new Set());
    expect(first.length).toBe(1);
    const markNames = new Set<string>();
    editor.state.doc.descendants((n) =>
      n.marks.forEach((m) => markNames.add(m.type.name)),
    );
    // Revision diffs no longer strike-through removed words — the section's
    // gutter bar (`.rl-block-modified`/`.rl-block-changed-bar`) is the
    // demarcation, and rl_ins highlights what's new. Edit track-changes keep
    // their own ins/del treatment via a separate path.
    expect(markNames.has("rl_del")).toBe(false);
    expect(markNames.has("rl_ins")).toBe(true); // "body" added

    // Accept-all serialization is still the clean current text.
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body paragraph.",
    );

    const second = applyRevisionRedline(editor, revisions, new Set());
    expect(second).toEqual([]); // idempotent

    // A block owned by an edit comment is left for the comment projection.
    const skipped = applyRevisionRedline(
      makeEditor(PLAN),
      revisions,
      new Set(["blk-bbbb2222"]),
    );
    expect(skipped).toEqual([]);
  });

  it("revision redline never repaints a block carrying open suggestions", () => {
    const editor = makeEditor(PLAN);
    // The user strikes a word — the only record of the proposal is the mark.
    const start = bodyTextStart(editor);
    editor
      .chain()
      .setTextSelection({ from: start + 9, to: start + 14 }) // "body "
      .run();
    editor.commands.keyboardShortcut("Backspace");

    const revisions = new Map<string, RevisionEdit>([
      [
        "blk-bbbb2222",
        { status: "modified", originalText: "Original draft paragraph." },
      ],
    ]);
    expect(applyRevisionRedline(editor, revisions, new Set())).toEqual([]);
    expect(markNames(editor).has("rl_del")).toBe(true); // proposal intact
  });
});

/** Position just inside the body paragraph (blk-bbbb2222) text. */
function bodyTextStart(editor: Editor): number {
  let at = -1;
  editor.state.doc.forEach((node, pos) => {
    if (node.attrs?.blockId === "blk-bbbb2222") at = pos + 1;
  });
  return at;
}
function markNames(editor: Editor): Set<string> {
  const s = new Set<string>();
  editor.state.doc.descendants((n) =>
    n.marks.forEach((m) => s.add(m.type.name)),
  );
  return s;
}

describe("live track-changes input (suggestion mode)", () => {
  it("marks typed text as a proposed insertion", () => {
    const editor = makeEditor(PLAN);
    const end = bodyTextStart(editor) + "Original body paragraph.".length;
    editor.chain().setTextSelection(end).insertContent(" added").run();

    expect(markNames(editor).has("rl_ins")).toBe(true);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body paragraph. added",
    );
  });

  it("a deletion survives the sidebar-sync reconcile (struck text stays)", () => {
    const editor = makeEditor(PLAN);
    const base = serializeBlocks(editor, anchors).map((b) => ({
      blockId: b.blockId,
      anchorId: b.anchorId,
      markdown: b.markdown,
    }));
    const start = bodyTextStart(editor);
    editor
      .chain()
      .setTextSelection({ from: start + 9, to: start + 14 }) // "body "
      .run();
    editor.commands.keyboardShortcut("Backspace");

    // Deleted text kept struck in place.
    expect(markNames(editor).has("rl_del")).toBe(true);

    // The debounced sync would now create this edit comment…
    const ops = diffToCommentOps(
      buildChangeSet(base, serializeBlocks(editor, anchors)),
      [],
    );
    expect(ops[0]?.op).toBe("add");
    const req = ops[0].op === "add" ? ops[0].request : null;
    const comment: Comment = {
      id: "c-001",
      type: "edit",
      anchorId: req!.anchorId,
      blockId: req!.blockId!,
      body: "(edit)",
      edit: req!.edit!,
      createdAt: 0,
      status: "draft",
    };

    // …and the reconcile must NOT wipe the struck text off the document.
    const baseMap = new Map(base.map((b) => [b.blockId, b.markdown]));
    materializeSuggestions(editor, [comment], baseMap);
    expect(markNames(editor).has("rl_del")).toBe(true);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original paragraph.",
    );
  });

  it("Backspace marks original text struck in place (text not removed)", () => {
    const editor = makeEditor(PLAN);
    const start = bodyTextStart(editor);
    const before = editor.state.doc.textContent;
    editor
      .chain()
      .setTextSelection({ from: start + 9, to: start + 14 }) // "body "
      .run();
    editor.commands.keyboardShortcut("Backspace");

    // The original characters are still in the document (just struck)…
    expect(editor.state.doc.textContent).toBe(before);
    expect(markNames(editor).has("rl_del")).toBe(true);
    // …and accept-all serialization reflects the proposed deletion.
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original paragraph.",
    );
  });

  it("Backspace over your own pending insertion really removes it", () => {
    const editor = makeEditor(PLAN);
    const end = bodyTextStart(editor) + "Original body paragraph.".length;
    editor.chain().setTextSelection(end).insertContent("XY").run();
    const from = bodyTextStart(editor) + "Original body paragraph.".length;
    editor.chain().setTextSelection({ from, to: from + 2 }).run();
    editor.commands.keyboardShortcut("Backspace");

    expect(markNames(editor).has("rl_del")).toBe(false);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body paragraph.",
    );
  });

  it("a freshly added empty bullet can be deleted (not resurrected)", () => {
    const LIST = [
      "<!-- rl:blk-list0001 -->",
      "- First bullet",
      "",
    ].join("\n");
    const editor = makeEditor(LIST);
    const countItems = () => {
      let n = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === "listItem") n += 1;
      });
      return n;
    };
    expect(countItems()).toBe(1);

    // End of "First bullet", press Enter → new empty list item.
    const end = 1 + 1 + 1 + "First bullet".length; // into the list/item/para
    editor.chain().setTextSelection(end).run();
    editor.commands.keyboardShortcut("Enter");
    expect(countItems()).toBe(2);

    // Changed my mind — Backspace on the empty bullet removes it for good.
    editor.commands.keyboardShortcut("Backspace");
    expect(countItems()).toBe(1);
    expect(markNames(editor).has("rl_del")).toBe(false);
  });
});
