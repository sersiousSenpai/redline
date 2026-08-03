// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";

import { drafterExtensions } from "./extensions/drafterExtensions";
import { applyLink } from "./drafterInserts";

// The ribbon's Link button commits through this helper (the popover only
// collects the text). Drive it against a real headless editor so the tested
// path matches what the button actually runs.

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
