// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";

import { drafterExtensions } from "./extensions/drafterExtensions";
import { planDocToMarkdown } from "./markdown/serializer";
import { applyFootnote, applyLink } from "./drafterInserts";

// The ribbon's Link and Footnote buttons commit through these helpers (the
// popover only collects the text). Drive them against a real headless editor
// so the tested path matches what the buttons actually run.

const editors: Editor[] = [];
function makeEditor(html: string): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: drafterExtensions(),
    content: html,
  });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

describe("applyFootnote", () => {
  it("inserts a footnote at the caret", () => {
    const editor = makeEditor("<p>Hello</p>");
    editor.commands.focus("end");
    applyFootnote(editor, "a clarifying note");
    const md = planDocToMarkdown(editor.state.doc, { sidecars: false });
    expect(md).toContain("Hello[^1]");
    expect(md).toContain("[^1]: a clarifying note");
  });

  it("updates the selected footnote instead of inserting a second one", () => {
    const editor = makeEditor("<p>Hello</p>");
    editor.commands.focus("end");
    applyFootnote(editor, "first draft");
    // Select the footnote node that now sits after "Hello" (pos 6).
    editor.commands.setNodeSelection(6);
    expect(editor.isActive("footnote")).toBe(true);
    applyFootnote(editor, "revised text");
    const md = planDocToMarkdown(editor.state.doc, { sidecars: false });
    expect(md).toContain("[^1]: revised text");
    expect(md).not.toContain("first draft");
    expect(md).not.toContain("[^2]");
  });
});

describe("applyLink", () => {
  it("links the selection and clears it on empty commit", () => {
    const editor = makeEditor("<p>Hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    applyLink(editor, "https://example.com");
    expect(editor.isActive("link")).toBe(true);
    expect(editor.getAttributes("link").href).toBe("https://example.com");
    // Caret inside the link + empty commit removes the whole mark range.
    editor.commands.setTextSelection(3);
    applyLink(editor, "");
    editor.commands.selectAll();
    expect(editor.isActive("link")).toBe(false);
  });
});
