// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";

import { drafterExtensions } from "./drafterExtensions";
import { planDocToMarkdown } from "../markdown/serializer";

// Exercise the Word-style formatting commands the ribbon drives (font size,
// line height, indent/outdent, color, font family) against a real headless
// editor, and assert the invariant that matters most: none of these visual
// drafting aids leak into the markdown the drafter sends to Claude.

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

describe("FontSize", () => {
  it("sets and clears a font size on the textStyle mark", () => {
    const editor = makeEditor("<p>Hello world</p>");
    editor.commands.selectAll();
    editor.commands.setFontSize("18px");
    expect(editor.getAttributes("textStyle").fontSize).toBe("18px");
    editor.commands.unsetFontSize();
    expect(editor.getAttributes("textStyle").fontSize ?? null).toBeNull();
  });
});

describe("LineHeight", () => {
  it("sets and clears a line height on the paragraph node", () => {
    const editor = makeEditor("<p>Hello world</p>");
    editor.commands.selectAll();
    editor.commands.setLineHeight("2");
    expect(editor.getJSON().content?.[0].attrs?.lineHeight).toBe("2");
    editor.commands.unsetLineHeight();
    expect(editor.getJSON().content?.[0].attrs?.lineHeight ?? null).toBeNull();
  });
});

describe("Indent", () => {
  it("bumps and clamps a paragraph indent level", () => {
    const editor = makeEditor("<p>Hello world</p>");
    editor.commands.focus("end");
    editor.commands.indent();
    editor.commands.indent();
    expect(editor.getJSON().content?.[0].attrs?.indent).toBe(2);
    // Outdent never falls below zero.
    editor.commands.outdent();
    editor.commands.outdent();
    editor.commands.outdent();
    expect(editor.getJSON().content?.[0].attrs?.indent).toBe(0);
  });

  it("nests the list item instead of indenting margin when in a list", () => {
    const editor = makeEditor(
      "<ul><li><p>one</p></li><li><p>two</p></li></ul>",
    );
    const count = (e: Editor) =>
      JSON.stringify(e.getJSON()).split('"bulletList"').length - 1;
    expect(count(editor)).toBe(1);
    editor.commands.focus("end"); // cursor lands in the second item
    editor.commands.indent();
    // Sinking the second item creates a nested bullet list under the first.
    expect(count(editor)).toBe(2);
  });
});

describe("find and replace", () => {
  // Mirrors PromptDrafter's replace-all: walk SearchHighlight matches
  // right-to-left so earlier positions stay valid as the doc is edited.
  function replaceAll(editor: Editor, query: string, replacement: string) {
    editor.commands.setSearchQuery(query);
    const matches = [...editor.storage.searchHighlight.matches];
    let chain = editor.chain();
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      chain = replacement
        ? chain.insertContentAt(
            { from: m.from, to: m.to },
            { type: "text", text: replacement },
          )
        : chain.deleteRange({ from: m.from, to: m.to });
    }
    chain.run();
  }

  it("finds every occurrence via SearchHighlight", () => {
    const editor = makeEditor("<p>cat cat cat</p>");
    editor.commands.setSearchQuery("cat");
    expect(editor.storage.searchHighlight.matches.length).toBe(3);
  });

  it("replaces all matches without corrupting positions", () => {
    const editor = makeEditor("<p>cat cat cat</p>");
    replaceAll(editor, "cat", "dog");
    expect(editor.getText()).toBe("dog dog dog");
  });

  it("replaces with empty string to delete matches", () => {
    const editor = makeEditor("<p>a-b-c</p>");
    replaceAll(editor, "-", "");
    expect(editor.getText()).toBe("abc");
  });
});

describe("serializer is blind to visual formatting", () => {
  it("drops font size, color, font family, line height, and indent", () => {
    const editor = makeEditor("<p>Hello world</p>");
    editor.commands.selectAll();
    editor.commands.setFontSize("28px");
    editor.commands.setColor("#ff0000");
    editor.commands.setFontFamily("Georgia, serif");
    editor.commands.setLineHeight("2");
    editor.commands.focus("end");
    editor.commands.indent();

    const md = planDocToMarkdown(editor.state.doc, { sidecars: false });
    expect(md).toContain("Hello world");
    // No style noise reaches the sent prompt.
    expect(md).not.toMatch(/28px|ff0000|Georgia|font-|margin-|line-height/i);
  });

  it("still serializes a real table inserted from the ribbon", () => {
    const editor = makeEditor("<p></p>");
    editor.commands.focus("end");
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    const md = planDocToMarkdown(editor.state.doc, { sidecars: false });
    // GitHub-flavoured table pipes survive into the markdown.
    expect(md).toContain("|");
  });
});

describe("TableAlign", () => {
  it("setTableAlign writes the align attr on the table node", () => {
    const editor = makeEditor("<p></p>");
    editor.commands.focus("end");
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    editor.commands.setTableAlign("center");
    const table = (editor.getJSON().content ?? []).find(
      (n) => n.type === "table",
    );
    expect(table?.attrs?.align).toBe("center");
    // Visual-only: it must not leak into the markdown contract.
    const md = planDocToMarkdown(editor.state.doc, { sidecars: false });
    expect(md).not.toMatch(/align|data-align/i);
  });
});

describe("TrailingNode", () => {
  it("keeps an empty paragraph after a trailing horizontal rule", () => {
    const editor = makeEditor("<p>above</p>");
    editor.commands.focus("end");
    editor.commands.setHorizontalRule();
    const content = editor.getJSON().content ?? [];
    const last = content[content.length - 1];
    // The doc must not end in the rule — there's a paragraph to click into.
    expect(last.type).toBe("paragraph");
    expect(content.some((n) => n.type === "horizontalRule")).toBe(true);
  });

  it("does not pile up paragraphs when the doc already ends in one", () => {
    const editor = makeEditor("<p>just text</p>");
    const content = editor.getJSON().content ?? [];
    expect(content.length).toBe(1);
  });
});

describe("TableControls whole-table deletion", () => {
  it("a full-table cell selection is recognized and deletes the table", () => {
    const editor = makeEditor("<p></p>");
    editor.commands.focus("end");
    editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true });

    // Build a CellSelection spanning every cell (first cell → last cell).
    const { doc } = editor.state;
    let firstCell = -1;
    let lastCell = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
        if (firstCell === -1) firstCell = pos;
        lastCell = pos;
      }
    });
    const sel = CellSelection.create(doc, firstCell, lastCell);
    editor.view.dispatch(editor.state.tr.setSelection(sel));

    const cs = editor.state.selection as CellSelection;
    expect(cs instanceof CellSelection).toBe(true);
    // The whole table is selected → the keymap's predicate holds.
    expect(cs.isRowSelection() && cs.isColSelection()).toBe(true);

    // …and the action it runs removes the table entirely.
    editor.commands.deleteTable();
    expect(JSON.stringify(editor.getJSON())).not.toContain('"table"');
  });
});
