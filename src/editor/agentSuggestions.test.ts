// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

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
 * M4 — agent-in-doc. An agent suggestion is a draft [edit] comment carrying
 * `author`; the editor materializes it as pending marks with the agent's
 * authorId. These tests pin the two landmines the design works around:
 *
 *  #1 Accepting must NOT trigger the seen-then-gone rejection (including its
 *     seed-restore fallback for mark-less blocks): accept settles the marks
 *     in place while the comment stays draft — still owning the block, still
 *     a zero-op for the flush, still in the submit payload.
 *  #3 `status:"accepted"` text is settled content: Backspace strikes it like
 *     any original text instead of hard-deleting it as a pending insertion.
 */

const editors: Editor[] = [];
function makeEditor(
  markdown: string,
  onLockedEdit?: (blockId: string) => void,
): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: planExtensions({ onLockedEdit }),
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

function agentComment(overrides: Partial<Comment> = {}): Comment {
  return {
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
    author: "claude-code",
    ...overrides,
  };
}

function seedOf(editor: Editor): Map<string, string> {
  return new Map(
    serializeBlocks(editor, anchors).map((b) => [b.blockId, b.markdown]),
  );
}

function marksByName(editor: Editor, name: string) {
  const found: { text: string; attrs: Record<string, unknown> }[] = [];
  editor.state.doc.descendants((n) => {
    if (!n.isText) return true;
    const m = n.marks.find((mk) => mk.type.name === name);
    if (m) found.push({ text: n.text ?? "", attrs: m.attrs });
    return true;
  });
  return found;
}

describe("agent authorship threading", () => {
  it("materializes an agent comment as pending marks with the agent authorId", () => {
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    expect(materializeSuggestions(editor, [agentComment()], seed)).toEqual([
      "blk-bbbb2222",
    ]);

    const ins = marksByName(editor, "rl_ins");
    const del = marksByName(editor, "rl_del");
    expect(ins.length).toBeGreaterThan(0);
    expect(del.length).toBeGreaterThan(0);
    for (const m of [...ins, ...del]) {
      expect(m.attrs.authorId).toBe("claude-code");
      expect(m.attrs.status).toBe("pending");
    }

    // Author-less comments still stamp the local reviewer.
    const editor2 = makeEditor(PLAN);
    materializeSuggestions(
      editor2,
      [agentComment({ author: undefined })],
      seedOf(editor2),
    );
    expect(marksByName(editor2, "rl_ins")[0]?.attrs.authorId).toBe("user");
  });

  it("is idempotent over a doc already carrying the agent marks (re-hydration)", () => {
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    materializeSuggestions(editor, [agentComment()], seed);
    expect(materializeSuggestions(editor, [agentComment()], seed)).toEqual([]);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body sentence.",
    );
  });
});

describe("landmine #1 — accept settles in place, never reverts", () => {
  it("accept keeps the revised text, flips rl_ins to accepted, drops rl_del text", () => {
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    materializeSuggestions(editor, [agentComment()], seed);

    expect(acceptBlockSuggestions(editor, "blk-bbbb2222")).toBe(true);

    // Settled: struck text gone, inserted text kept with accepted status…
    expect(editor.state.doc.textContent).toContain(
      "Original body sentence.",
    );
    expect(marksByName(editor, "rl_del")).toEqual([]);
    const ins = marksByName(editor, "rl_ins");
    expect(ins.length).toBeGreaterThan(0);
    for (const m of ins) {
      expect(m.attrs.status).toBe("accepted");
      expect(m.attrs.authorId).toBe("claude-code");
    }
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body sentence.",
    );

    // Mark-less / already-settled block → no-op, NEVER a seed restore.
    expect(acceptBlockSuggestions(editor, "blk-bbbb2222")).toBe(false);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body sentence.",
    );
  });

  it("the comment stays draft: the flush is a zero-op and materialize skips", () => {
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    const comment = agentComment();
    materializeSuggestions(editor, [comment], seed);
    acceptBlockSuggestions(editor, "blk-bbbb2222");

    // The accepted comment is still the block's owner in byBlock, and the
    // block serializes to exactly its `revised` → the debounced flush emits
    // nothing (no duplicate add, no update rewriting the agent's comment).
    const base = [...seed].map(([blockId, markdown]) => ({
      blockId,
      anchorId: anchors.get(blockId) ?? blockId,
      markdown,
    }));
    const ops = diffToCommentOps(
      buildChangeSet(base, serializeBlocks(editor, anchors)),
      [comment],
    );
    expect(ops).toEqual([]);

    // And the reconcile's materialize pass leaves the settled block alone.
    expect(materializeSuggestions(editor, [comment], seed)).toEqual([]);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body sentence.",
    );
  });

  it("submit-time seen-then-gone DOES seed-restore the accepted block (by design)", () => {
    // When the draft is submitted away the block must revert to the
    // published revision while Claude revises — identical to user drafts.
    // This is the seed-restore fallback doing its job; accept relies on the
    // comment staying draft to keep this from firing early.
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    materializeSuggestions(editor, [agentComment()], seed);
    acceptBlockSuggestions(editor, "blk-bbbb2222");

    expect(
      rejectBlockSuggestions(
        editor,
        "blk-bbbb2222",
        seed.get("blk-bbbb2222"),
      ),
    ).toBe(true);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body paragraph.",
    );
  });

  it("reject-via-delete semantics: pending agent marks revert in place", () => {
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    materializeSuggestions(editor, [agentComment()], seed);

    // The card's Reject deletes the comment; the reconcile's seen-then-gone
    // then calls rejectBlockSuggestions — the block reads as published again.
    expect(
      rejectBlockSuggestions(
        editor,
        "blk-bbbb2222",
        seed.get("blk-bbbb2222"),
      ),
    ).toBe(true);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body paragraph.",
    );
    expect(marksByName(editor, "rl_ins")).toEqual([]);
    expect(marksByName(editor, "rl_del")).toEqual([]);
  });
});

describe("accepted re-hydration (agentState)", () => {
  it("materializes an accepted agent comment as plain settled content", () => {
    // Lost Y.Doc copy (IndexedDB cleared / new machine): the persisted
    // comment says accepted, the fresh doc is pristine — the block must
    // read as the settled revised text, not re-open as a pending proposal.
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    const accepted = agentComment({ agentState: "accepted" });

    expect(materializeSuggestions(editor, [accepted], seed)).toEqual([
      "blk-bbbb2222",
    ]);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body sentence.",
    );
    expect(marksByName(editor, "rl_ins")).toEqual([]);
    expect(marksByName(editor, "rl_del")).toEqual([]);

    // Still a zero-op for the flush (comment owns the block, content match).
    const base = [...seed].map(([blockId, markdown]) => ({
      blockId,
      anchorId: anchors.get(blockId) ?? blockId,
      markdown,
    }));
    expect(
      diffToCommentOps(
        buildChangeSet(base, serializeBlocks(editor, anchors)),
        [accepted],
      ),
    ).toEqual([]);
  });
});

describe("landmine #2 — blocks with pending agent suggestions are locked", () => {
  /** Caret position just inside the body paragraph (blk-bbbb2222) text. */
  function bodyTextStart(editor: Editor): number {
    let at = -1;
    editor.state.doc.forEach((node, pos) => {
      if (node.attrs?.blockId === "blk-bbbb2222") at = pos + 1;
    });
    return at;
  }

  function lockAgentBlock(editor: Editor): Comment {
    const comment = agentComment();
    materializeSuggestions(editor, [comment], seedOf(editor));
    editor.commands.setLockedBlocks(["blk-bbbb2222"]);
    return comment;
  }

  it("typing into the locked block is filtered and onLockedEdit fires", () => {
    const onLocked = vi.fn();
    const editor = makeEditor(PLAN, onLocked);
    lockAgentBlock(editor);
    const before = editor.state.doc.toJSON();

    editor
      .chain()
      .setTextSelection(bodyTextStart(editor) + 3)
      .insertContent("X")
      .run();

    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(onLocked).toHaveBeenCalledWith("blk-bbbb2222");
  });

  it("Backspace strikes in the locked block are filtered too", () => {
    const onLocked = vi.fn();
    const editor = makeEditor(PLAN, onLocked);
    lockAgentBlock(editor);
    const before = editor.state.doc.toJSON();

    const start = bodyTextStart(editor);
    editor.chain().setTextSelection({ from: start, to: start + 8 }).run();
    editor.commands.keyboardShortcut("Backspace");

    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(onLocked).toHaveBeenCalledWith("blk-bbbb2222");
  });

  it("rl-sync transactions (accept/reject projections) pass the lock", () => {
    const editor = makeEditor(PLAN, vi.fn());
    lockAgentBlock(editor);

    expect(acceptBlockSuggestions(editor, "blk-bbbb2222")).toBe(true);
    expect(serializeBlocks(editor, anchors)[1].markdown).toBe(
      "Original body sentence.",
    );
  });

  it("edits in other blocks pass, and the flush never touches the agent comment", () => {
    const onLocked = vi.fn();
    const editor = makeEditor(PLAN, onLocked);
    const seed = seedOf(editor);
    const comment = lockAgentBlock(editor);

    // Edit the title block — allowed, no lock callback.
    let titleEnd = -1;
    editor.state.doc.forEach((node, pos) => {
      if (node.attrs?.blockId === "blk-aaaa1111")
        titleEnd = pos + node.nodeSize - 1;
    });
    editor.chain().setTextSelection(titleEnd).insertContent(" v2").run();
    expect(onLocked).not.toHaveBeenCalled();
    expect(serializeBlocks(editor, anchors)[0].markdown).toBe("# Title v2");

    // The debounced flush emits ops only for the user's block — it never
    // updates or deletes the agent's comment (authorship stays clean).
    const base = [...seed].map(([blockId, markdown]) => ({
      blockId,
      anchorId: anchors.get(blockId) ?? blockId,
      markdown,
    }));
    const ops = diffToCommentOps(
      buildChangeSet(base, serializeBlocks(editor, anchors)),
      [comment],
    );
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(op.op).toBe("add");
      if (op.op === "add") expect(op.request.blockId).toBe("blk-aaaa1111");
    }
  });

  it("unlocking after accept lets the user edit on top of the settled text", () => {
    const onLocked = vi.fn();
    const editor = makeEditor(PLAN, onLocked);
    lockAgentBlock(editor);
    acceptBlockSuggestions(editor, "blk-bbbb2222");
    editor.commands.setLockedBlocks([]); // agentState set → out of lock set

    editor
      .chain()
      .setTextSelection(bodyTextStart(editor) + 3)
      .insertContent("X")
      .run();
    expect(onLocked).not.toHaveBeenCalled();
    expect(serializeBlocks(editor, anchors)[1].markdown).toContain("X");
  });
});

describe("landmine #3 — accepted text is settled, not a pending insertion", () => {
  it("Backspace over accepted rl_ins text strikes it instead of deleting it", () => {
    const editor = makeEditor(PLAN);
    const seed = seedOf(editor);
    materializeSuggestions(editor, [agentComment()], seed);
    acceptBlockSuggestions(editor, "blk-bbbb2222");

    // Select the accepted word ("sentence") and strike it.
    const accepted = marksByName(editor, "rl_ins");
    expect(accepted[0]?.attrs.status).toBe("accepted");
    let from = -1;
    let to = -1;
    editor.state.doc.descendants((n, pos) => {
      if (
        from === -1 &&
        n.isText &&
        n.marks.some((m) => m.type.name === "rl_ins")
      ) {
        from = pos;
        to = pos + n.nodeSize;
      }
      return from === -1;
    });
    expect(from).toBeGreaterThan(-1);
    const before = editor.state.doc.textContent;
    editor.chain().setTextSelection({ from, to }).run();
    editor.commands.keyboardShortcut("Backspace");

    // The characters are still in the document, struck in place…
    expect(editor.state.doc.textContent).toBe(before);
    const struck = marksByName(editor, "rl_del");
    expect(struck.length).toBeGreaterThan(0);
    expect(struck[0].attrs.status).toBe("pending");
    expect(struck[0].attrs.authorId).toBe("user");
  });
});
