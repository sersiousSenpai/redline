// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { drafterExtensions } from "./drafterExtensions";
import { resolveInstructionBlock } from "./InstructionTrigger";

const editors: Editor[] = [];
function makeEditor(
  content?: object,
  onInstruct?: (blockId: string, text: string) => void,
): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: drafterExtensions({ onInstruct }),
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

describe("resolveInstructionBlock", () => {
  it("resolves the caret's non-empty paragraph to its blockId + text", () => {
    const editor = makeEditor({
      type: "doc",
      content: [para("draft a summary of X")],
    });
    editor.commands.setTextSelection(5);
    const r = resolveInstructionBlock(editor.state);
    expect(r).not.toBeNull();
    expect(r!.blockId).toMatch(/^blk-/);
    expect(r!.text).toBe("draft a summary of X");
  });

  it("declines empty paragraphs, code blocks and pending-mark blocks", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        para("fine"),
        { type: "paragraph" },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    });
    // Empty paragraph (block 2): caret inside it.
    editor.commands.setTextSelection(7);
    expect(resolveInstructionBlock(editor.state)).toBeNull();
    // Code block: caret inside it.
    editor.commands.setTextSelection(12);
    expect(resolveInstructionBlock(editor.state)).toBeNull();
    // A paragraph whose text carries a pending mark is mid-proposal.
    editor.commands.setSuggesting(true);
    editor.commands.setTextSelection(1);
    editor.commands.insertContentAt(1, "Z");
    editor.commands.setTextSelection(2);
    expect(resolveInstructionBlock(editor.state)).toBeNull();
  });
});

describe("instructAtCaret", () => {
  it("fires onInstruct with the caret block's identity and text", () => {
    const seen = vi.fn();
    const editor = makeEditor(
      { type: "doc", content: [para("please draft the intro")] },
      seen,
    );
    editor.commands.setTextSelection(3);
    expect(editor.commands.instructAtCaret()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    const [blockId, text] = seen.mock.calls[0];
    expect(blockId).toMatch(/^blk-/);
    expect(text).toBe("please draft the intro");
  });

  it("returns false when the caret block can't carry an instruction", () => {
    const seen = vi.fn();
    const editor = makeEditor(
      { type: "doc", content: [para("x"), { type: "paragraph" }] },
      seen,
    );
    editor.commands.setTextSelection(4);
    expect(editor.commands.instructAtCaret()).toBe(false);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("setGeneratingBlocks", () => {
  function blockIdAt(editor: Editor, index: number): string {
    return editor.state.doc.child(index).attrs.blockId as string;
  }

  it("paints the target block .rl-generating and survives doc edits", () => {
    const editor = makeEditor({
      type: "doc",
      content: [para("target"), para("other")],
    });
    const bid = blockIdAt(editor, 0);
    editor.commands.setGeneratingBlocks([bid]);
    expect(editor.view.dom.querySelectorAll(".rl-generating").length).toBe(1);

    // An edit elsewhere keeps the paint (decorations rebuild from the ids).
    editor.commands.insertContentAt(9, "X");
    expect(editor.view.dom.querySelectorAll(".rl-generating").length).toBe(1);

    // Clearing removes it.
    editor.commands.setGeneratingBlocks([]);
    expect(editor.view.dom.querySelectorAll(".rl-generating").length).toBe(0);
  });
});
