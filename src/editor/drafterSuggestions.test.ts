// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { drafterExtensions } from "./extensions/drafterExtensions";
import { planDocToMarkdown } from "./markdown/serializer";
import {
  acceptDraftSuggestion,
  applyDraftSuggestion,
  docIsEmpty,
  rejectDraftSuggestion,
  type DraftSuggestionRow,
} from "./drafterSuggestions";

const editors: Editor[] = [];
function makeEditor(content?: object): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: drafterExtensions(),
    content,
  });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

function para(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function suggestion(over: Partial<DraftSuggestionRow>): DraftSuggestionRow {
  return {
    id: "sug-1",
    draftId: "d-1",
    op: "append",
    blockId: null,
    original: null,
    markdown: "",
    agentId: "draft-agent",
    body: null,
    status: "pending",
    createdAt: 0,
    ...over,
  };
}

function blockIds(editor: Editor): (string | null)[] {
  const ids: (string | null)[] = [];
  editor.state.doc.forEach((n) => ids.push(n.attrs.blockId ?? null));
  return ids;
}

describe("DraftBlockIds", () => {
  it("mints blk- ids for every top-level block on load and keeps them stable", () => {
    const editor = makeEditor({
      type: "doc",
      content: [para("one"), para("two")],
    });
    const ids = blockIds(editor).filter(Boolean) as string[];
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) expect(id).toMatch(/^blk-/);
    expect(new Set(ids).size).toBe(ids.length);

    // Editing a block keeps its identity.
    editor.commands.insertContentAt(2, "X");
    const after = blockIds(editor).filter(Boolean) as string[];
    expect(after[0]).toBe(ids[0]);
  });

  it("emits the ids as rl:blk sidecars in the markdown mirror", () => {
    const editor = makeEditor({ type: "doc", content: [para("hello")] });
    const md = planDocToMarkdown(editor.state.doc, { sidecars: true });
    expect(md).toMatch(/<!-- rl:blk-[a-z0-9]+ -->/);
    expect(md).toContain("hello");
  });
});

describe("applyDraftSuggestion", () => {
  it("append into an empty doc applies directly (whole-cloth drafting)", () => {
    const editor = makeEditor();
    expect(docIsEmpty(editor)).toBe(true);
    const outcome = applyDraftSuggestion(
      editor,
      suggestion({ op: "append", markdown: "# Goal\n\nShip auth." }),
    );
    expect(outcome).toBe("applied");
    expect(editor.state.doc.textContent).toContain("Ship auth.");
    // Settled content — no pending marks anywhere.
    let pending = 0;
    editor.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === "rl_ins")) pending++;
      return true;
    });
    expect(pending).toBe(0);
  });

  it("append into a non-empty doc lands as pending tracked insertions", () => {
    const editor = makeEditor({ type: "doc", content: [para("existing")] });
    const outcome = applyDraftSuggestion(
      editor,
      suggestion({ op: "append", markdown: "new tail" }),
    );
    expect(outcome).toBe("proposed");
    let marked = "";
    editor.state.doc.descendants((n) => {
      if (
        n.isText &&
        n.marks.some(
          (m) => m.type.name === "rl_ins" && m.attrs.suggestionId === "sug-1",
        )
      ) {
        marked += n.text;
      }
      return true;
    });
    expect(marked).toContain("new tail");
  });

  it("replace_block paints an inline word-diff; reject restores; accept settles", () => {
    const editor = makeEditor({
      type: "doc",
      content: [para("keep this old ending")],
    });
    const bid = blockIds(editor)[0]!;
    const s = suggestion({
      op: "replace_block",
      blockId: bid,
      original: "keep this old ending",
      markdown: "keep this new ending",
    });
    expect(applyDraftSuggestion(editor, s)).toBe("proposed");
    // Both the struck old word and the proposed new word are present.
    expect(editor.state.doc.textContent).toContain("old");
    expect(editor.state.doc.textContent).toContain("new");

    // Reject → back to the original text.
    expect(rejectDraftSuggestion(editor, s)).toBe(true);
    expect(editor.state.doc.textContent.trim()).toBe("keep this old ending");

    // Re-apply and accept → the rewrite settles.
    expect(applyDraftSuggestion(editor, s)).toBe("proposed");
    expect(acceptDraftSuggestion(editor, s)).toBe(true);
    expect(editor.state.doc.textContent.trim()).toBe("keep this new ending");
  });

  it("delete_block strikes the block; accept removes it", () => {
    const editor = makeEditor({
      type: "doc",
      content: [para("first"), para("doomed")],
    });
    const bid = blockIds(editor)[1]!;
    const s = suggestion({ op: "delete_block", blockId: bid, markdown: "" });
    expect(applyDraftSuggestion(editor, s)).toBe("proposed");
    expect(editor.state.doc.textContent).toContain("doomed");
    expect(acceptDraftSuggestion(editor, s)).toBe(true);
    expect(editor.state.doc.textContent).not.toContain("doomed");
    expect(editor.state.doc.textContent).toContain("first");
  });

  it("a stale blockId reports stale", () => {
    const editor = makeEditor({ type: "doc", content: [para("text")] });
    expect(
      applyDraftSuggestion(
        editor,
        suggestion({ op: "replace_block", blockId: "blk-gone", markdown: "x" }),
      ),
    ).toBe("stale");
  });
});
