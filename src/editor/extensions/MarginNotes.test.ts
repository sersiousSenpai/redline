// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { planMarkdownToDoc } from "../markdown";
import { MarginNotes, type MarginNote } from "./MarginNotes";
import { planExtensions } from "./planExtensions";

const MD = [
  "<!-- rl:blk-a -->",
  "First paragraph.",
  "",
  "<!-- rl:blk-b -->",
  "1. Compile the build.",
  "2. Apply the migration.",
  "",
  "<!-- rl:blk-c -->",
  "Last paragraph.",
  "",
].join("\n");

const editors: Editor[] = [];
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

function editorWith(notes: MarginNote[]): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [...planExtensions(), MarginNotes],
    content: planMarkdownToDoc(MD).toJSON(),
  });
  editors.push(editor);
  editor.commands.setMarginNotes(notes);
  return editor;
}

const note = (over: Partial<MarginNote>): MarginNote => ({
  commentId: "c-1",
  blockId: "blk-b",
  initials: "IM",
  body: "Run this against staging first, not prod.",
  ...over,
});

describe("MarginNotes", () => {
  it("draws a note under the block it marks, between it and the next", () => {
    const editor = editorWith([note({})]);
    const card = editor.view.dom.querySelector<HTMLElement>(".rl-margin-note");
    expect(card).not.toBeNull();
    expect(card!.textContent).toBe("IMRun this against staging first, not prod.");
    expect(card!.getAttribute("contenteditable")).toBe("false");
    expect(card!.previousElementSibling?.tagName).toBe("OL");
    expect(card!.nextElementSibling?.textContent).toBe("Last paragraph.");
  });

  it("is presentation only: the document and its text are unchanged", () => {
    const plain = editorWith([]);
    const noted = editorWith([note({}), note({ commentId: "c-2", blockId: "blk-a", body: "Second" })]);
    expect(noted.getJSON()).toEqual(plain.getJSON());
    expect(noted.state.doc.textContent).toBe(plain.state.doc.textContent);
    expect(noted.view.dom.querySelectorAll(".rl-margin-note")).toHaveLength(2);
  });

  it("draws none for an empty list, and clears when told to", () => {
    const editor = editorWith([note({})]);
    editor.commands.setMarginNotes([]);
    expect(editor.view.dom.querySelector(".rl-margin-note")).toBeNull();
  });

  it("ignores a note whose block isn't in this revision", () => {
    const editor = editorWith([note({ blockId: "blk-gone" })]);
    expect(editor.view.dom.querySelector(".rl-margin-note")).toBeNull();
  });

  it("hands a click to the bound handler with the comment's id", () => {
    const editor = editorWith([note({})]);
    const onClick = vi.fn();
    editor.commands.bindMarginNoteClick(onClick);
    editor.view.dom.querySelector<HTMLElement>(".rl-margin-note")!.click();
    expect(onClick).toHaveBeenCalledWith("c-1");
  });
});
