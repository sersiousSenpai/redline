// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";

import { drafterExtensions } from "./drafterExtensions";
import { planDocToMarkdown } from "../markdown/serializer";
import {
  classifyOrderedToken,
  fromAlpha,
  fromRoman,
  NEXT_BULLET,
  NEXT_ORDERED,
} from "../listMarkers";

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
    // Place the caret INSIDE the second item. (`focus("end")` would land in
    // TrailingNode's trailing paragraph: DraftBlockIds' mount stamp counts as
    // a doc change, so the trailing node exists from the start now — as it
    // always did after the first keystroke in a real session.)
    let inTwo = 0;
    editor.state.doc.descendants((n, pos) => {
      if (n.isText && n.text === "two") inTwo = pos + 1;
      return true;
    });
    editor.commands.focus(inTwo);
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

describe("ListStyle", () => {
  function orderedMd(html: string, style: string): string {
    const editor = makeEditor(html);
    // Land the cursor inside the first list item (pos 3 is within its text) so
    // the style applies to the existing list without wrapping trailing content.
    editor.commands.setTextSelection(3);
    editor.commands.setOrderedListStyle(style);
    return planDocToMarkdown(editor.state.doc, { sidecars: false });
  }

  it("keeps the canonical decimal markers when no style is set", () => {
    const editor = makeEditor(
      "<ol><li><p>one</p></li><li><p>two</p></li></ol>",
    );
    const md = planDocToMarkdown(editor.state.doc, { sidecars: false });
    expect(md).toContain("1. one");
    expect(md).toContain("2. two");
  });

  it("serializes lower-roman markers faithfully", () => {
    const md = orderedMd(
      "<ol><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ol>",
      "lower-roman",
    );
    expect(md).toContain("i. one");
    expect(md).toContain("ii. two");
    expect(md).toContain("iii. three");
  });

  it("serializes upper-alpha with a trailing paren", () => {
    const md = orderedMd(
      "<ol><li><p>a</p></li><li><p>b</p></li></ol>",
      "upper-alpha-paren",
    );
    expect(md).toContain("A) a");
    expect(md).toContain("B) b");
  });

  it("serializes decimal parenthetical markers", () => {
    const md = orderedMd(
      "<ol><li><p>x</p></li><li><p>y</p></li></ol>",
      "decimal-parenthetical",
    );
    expect(md).toContain("(1) x");
    expect(md).toContain("(2) y");
  });

  it("serializes lower-alpha parenthetical markers", () => {
    const md = orderedMd(
      "<ol><li><p>x</p></li><li><p>y</p></li></ol>",
      "lower-alpha-parenthetical",
    );
    expect(md).toContain("(a) x");
    expect(md).toContain("(b) y");
  });

  it("honours the list start attribute for non-decimal styles", () => {
    const editor = makeEditor(
      '<ol start="3"><li><p>c</p></li><li><p>d</p></li></ol>',
    );
    editor.commands.setTextSelection(3);
    editor.commands.setOrderedListStyle("upper-roman");
    const md = planDocToMarkdown(editor.state.doc, { sidecars: false });
    expect(md).toContain("III. c");
    expect(md).toContain("IV. d");
  });

  it("switches a bullet list's marker without leaking CSS into markdown", () => {
    const editor = makeEditor("<ul><li><p>one</p></li></ul>");
    editor.commands.selectAll();
    editor.commands.setBulletListStyle("square");
    expect(editor.getAttributes("bulletList").listStyle).toBe("square");
    const md = planDocToMarkdown(editor.state.doc, { sidecars: false });
    // Bullets always serialize as a plain dash — style is display-only for them.
    expect(md).toContain("- one");
    expect(md).not.toMatch(/square|list-style/i);
  });
});

// Route text through the input-rules pipeline the way real typing does:
// handleTextInput is the prop the inputRules plugin hooks.
function typeText(editor: Editor, text: string) {
  for (const char of text) {
    const { view } = editor;
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) =>
      f(view, from, to, char, () => view.state.tr.insertText(char, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
}

// Place the caret inside the text leaf whose content is `text`.
function focusText(editor: Editor, text: string) {
  let pos = 0;
  editor.state.doc.descendants((n, p) => {
    if (n.isText && n.text === text) pos = p + 1;
    return !pos;
  });
  editor.commands.focus(pos);
}

// Every list in the doc, outermost first, as (type, listStyle, start).
function lists(editor: Editor): { type: string; style: string | null; start: number }[] {
  const out: { type: string; style: string | null; start: number }[] = [];
  editor.state.doc.descendants((n) => {
    if (n.type.name === "orderedList" || n.type.name === "bulletList") {
      out.push({
        type: n.type.name,
        style: (n.attrs.listStyle as string | null) ?? null,
        start: (n.attrs.start as number) ?? 1,
      });
    }
    return true;
  });
  return out;
}

describe("listMarkers inverses", () => {
  it("fromAlpha inverts bijective base-26 and rejects non-lowercase", () => {
    expect(fromAlpha("a")).toBe(1);
    expect(fromAlpha("c")).toBe(3);
    expect(fromAlpha("z")).toBe(26);
    expect(fromAlpha("aa")).toBe(27);
    expect(fromAlpha("A")).toBeNull();
    expect(fromAlpha("")).toBeNull();
  });

  it("fromRoman accepts only canonical lowercase numerals", () => {
    expect(fromRoman("i")).toBe(1);
    expect(fromRoman("iv")).toBe(4);
    expect(fromRoman("xxxviii")).toBe(38);
    expect(fromRoman("mcmxciv")).toBe(1994);
    expect(fromRoman("vv")).toBeNull();
    expect(fromRoman("iiii")).toBeNull();
    expect(fromRoman("IV")).toBeNull();
    expect(fromRoman("")).toBeNull();
  });

  it("classifies tokens with Word's ambiguity policy", () => {
    expect(classifyOrderedToken("3")).toEqual({ family: "decimal", start: 3 });
    expect(classifyOrderedToken("0")).toBeNull();
    // Bare i/I is Roman; every other single letter — v and x included — is alpha.
    expect(classifyOrderedToken("i")).toEqual({ family: "lower-roman", start: 1 });
    expect(classifyOrderedToken("I")).toEqual({ family: "upper-roman", start: 1 });
    expect(classifyOrderedToken("a")).toEqual({ family: "lower-alpha", start: 1 });
    expect(classifyOrderedToken("C")).toEqual({ family: "upper-alpha", start: 3 });
    expect(classifyOrderedToken("v")).toEqual({ family: "lower-alpha", start: 22 });
    expect(classifyOrderedToken("x")).toEqual({ family: "lower-alpha", start: 24 });
    // Multi-letter only as canonical roman over {i,v,x}.
    expect(classifyOrderedToken("iv")).toEqual({ family: "lower-roman", start: 4 });
    expect(classifyOrderedToken("XI")).toEqual({ family: "upper-roman", start: 11 });
    expect(classifyOrderedToken("Iv")).toBeNull();
    expect(classifyOrderedToken("vv")).toBeNull();
    expect(classifyOrderedToken("aa")).toBeNull();
    expect(classifyOrderedToken("cm")).toBeNull();
    expect(classifyOrderedToken("abcdefg")).toBeNull();
  });

  it("cascade maps ring correctly in every family", () => {
    // Word's dot ring, entered from the outline styles.
    expect(NEXT_ORDERED["upper-roman"]).toBe("upper-alpha");
    expect(NEXT_ORDERED["upper-alpha"]).toBe("decimal");
    expect(NEXT_ORDERED["decimal"]).toBe("lower-alpha");
    expect(NEXT_ORDERED["lower-alpha"]).toBe("lower-roman");
    expect(NEXT_ORDERED["lower-roman"]).toBe("decimal");
    // Decimal variants join the ring where decimal does.
    expect(NEXT_ORDERED["decimal-leading-zero"]).toBe("lower-alpha");
    expect(NEXT_ORDERED["lower-greek"]).toBe("lower-alpha");
    // Paren and parenthetical families cascade within themselves.
    expect(NEXT_ORDERED["decimal-paren"]).toBe("lower-alpha-paren");
    expect(NEXT_ORDERED["lower-roman-paren"]).toBe("decimal-paren");
    expect(NEXT_ORDERED["decimal-parenthetical"]).toBe("lower-alpha-parenthetical");
    expect(NEXT_ORDERED["lower-roman-parenthetical"]).toBe("decimal-parenthetical");
    expect(NEXT_BULLET["disc"]).toBe("circle");
    expect(NEXT_BULLET["dash"]).toBe("disc");
  });
});

describe("ListStyle cascade on nesting", () => {
  it("walks Word's outline I. → A. → 1. via indent()", () => {
    const editor = makeEditor(
      '<ol data-list-style="upper-roman"><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ol>',
    );
    focusText(editor, "two");
    editor.commands.indent();
    expect(lists(editor).map((l) => l.style)).toEqual([
      "upper-roman",
      "upper-alpha",
    ]);
    // "three" first joins the stamped sublist, then sinks one deeper.
    focusText(editor, "three");
    editor.commands.indent();
    editor.commands.indent();
    expect(lists(editor).map((l) => l.style)).toEqual([
      "upper-roman",
      "upper-alpha",
      "decimal",
    ]);
    const md = planDocToMarkdown(editor.state.doc, { sidecars: false });
    expect(md).toContain("I. one");
    expect(md).toContain("A. two");
    expect(md).toContain("1. three");
  });

  it("starts the dot ring from an unstyled list and wraps it after roman", () => {
    const plain = makeEditor(
      "<ol><li><p>one</p></li><li><p>two</p></li></ol>",
    );
    focusText(plain, "two");
    plain.commands.indent();
    expect(lists(plain).map((l) => l.style)).toEqual([null, "lower-alpha"]);

    const roman = makeEditor(
      '<ol data-list-style="lower-roman"><li><p>one</p></li><li><p>two</p></li></ol>',
    );
    focusText(roman, "two");
    roman.commands.indent();
    expect(lists(roman).map((l) => l.style)).toEqual([
      "lower-roman",
      "decimal",
    ]);
  });

  it("cascades bullets ● → ○ and keeps markdown dashes", () => {
    const editor = makeEditor(
      "<ul><li><p>one</p></li><li><p>two</p></li></ul>",
    );
    focusText(editor, "two");
    editor.commands.indent();
    expect(lists(editor).map((l) => l.style)).toEqual([null, "circle"]);
    const md = planDocToMarkdown(editor.state.doc, { sidecars: false });
    expect(md).toContain("- one");
    expect(md).toContain("- two");
  });

  it("never restamps a sublist the user styled from the picker", () => {
    const editor = makeEditor(
      "<ol><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ol>",
    );
    focusText(editor, "two");
    editor.commands.indent();
    // The user overrides the stamped lower-alpha with greek…
    editor.commands.setOrderedListStyle("lower-greek");
    expect(lists(editor).map((l) => l.style)).toEqual([null, "lower-greek"]);
    // …and a later sink that merges into that sublist leaves it alone.
    focusText(editor, "three");
    editor.commands.indent();
    expect(lists(editor).map((l) => l.style)).toEqual([null, "lower-greek"]);
  });

  it("Tab in a list nests and stamps like the toolbar indent", () => {
    const editor = makeEditor(
      "<ol><li><p>one</p></li><li><p>two</p></li></ol>",
    );
    focusText(editor, "two");
    const event = new KeyboardEvent("keydown", { key: "Tab" });
    editor.view.someProp("handleKeyDown", (f) => f(editor.view, event));
    expect(lists(editor).map((l) => l.style)).toEqual([null, "lower-alpha"]);
  });

  it("Tab in a table still goes to the next cell, not into list handling", () => {
    const editor = makeEditor("<p></p>");
    editor.commands.focus("end");
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    const before = editor.state.selection.from;
    const event = new KeyboardEvent("keydown", { key: "Tab" });
    editor.view.someProp("handleKeyDown", (f) => f(editor.view, event));
    expect(editor.state.selection.from).not.toBe(before);
    expect(lists(editor)).toEqual([]);
  });
});

describe("ListStyle Word AutoFormat input rules", () => {
  function typed(text: string): Editor {
    const editor = makeEditor("<p></p>");
    editor.commands.focus("start");
    typeText(editor, text);
    return editor;
  }

  it("`a. ` opens a lower-alpha list at start 1", () => {
    expect(lists(typed("a. "))).toEqual([
      { type: "orderedList", style: "lower-alpha", start: 1 },
    ]);
  });

  it("`iv. ` opens a lower-roman list at start 4", () => {
    expect(lists(typed("iv. "))).toEqual([
      { type: "orderedList", style: "lower-roman", start: 4 },
    ]);
  });

  it("`C. ` opens an upper-alpha list at start 3", () => {
    expect(lists(typed("C. "))).toEqual([
      { type: "orderedList", style: "upper-alpha", start: 3 },
    ]);
  });

  it("`I. ` reads as Roman, not alpha", () => {
    expect(lists(typed("I. "))).toEqual([
      { type: "orderedList", style: "upper-roman", start: 1 },
    ]);
  });

  it("`v. ` reads as alpha item 22 (Word's policy), not Roman 5", () => {
    expect(lists(typed("v. "))).toEqual([
      { type: "orderedList", style: "lower-alpha", start: 22 },
    ]);
  });

  it("`3. ` falls through to StarterKit: null style, native start", () => {
    expect(lists(typed("3. "))).toEqual([
      { type: "orderedList", style: null, start: 3 },
    ]);
  });

  it("`1) ` opens a decimal-paren list", () => {
    expect(lists(typed("1) "))).toEqual([
      { type: "orderedList", style: "decimal-paren", start: 1 },
    ]);
  });

  it("`(b) ` opens a lower-alpha-parenthetical list at start 2", () => {
    expect(lists(typed("(b) "))).toEqual([
      { type: "orderedList", style: "lower-alpha-parenthetical", start: 2 },
    ]);
  });

  it("non-markers like `vv. ` stay plain text", () => {
    const editor = typed("vv. ");
    expect(lists(editor)).toEqual([]);
    expect(editor.getText()).toContain("vv.");
  });

  it("consecutive same-style markers join into one list", () => {
    const editor = makeEditor("<p></p>");
    editor.commands.focus("start");
    typeText(editor, "a. first");
    editor.commands.enter();
    // Leaving the list via a fresh paragraph, then typing the successor marker
    // should re-join the styled list above.
    editor.commands.liftListItem("listItem");
    typeText(editor, "b. second");
    expect(lists(editor)).toEqual([
      { type: "orderedList", style: "lower-alpha", start: 1 },
    ]);
    const md = planDocToMarkdown(editor.state.doc, { sidecars: false });
    expect(md).toContain("a. first");
    expect(md).toContain("b. second");
  });
});

describe("Footnote", () => {
  it("emits [^n] inline and a trailing definitions block", () => {
    const editor = makeEditor("<p>Hello</p>");
    editor.commands.focus("end");
    editor.commands.insertFootnote("a clarifying note");
    const md = planDocToMarkdown(editor.state.doc, { sidecars: false });
    expect(md).toContain("Hello[^1]");
    expect(md).toContain("[^1]: a clarifying note");
  });

  it("numbers multiple footnotes in document order", () => {
    const editor = makeEditor("<p>first</p><p>second</p>");
    // Footnote after "first" (end of paragraph 1).
    editor.commands.setTextSelection(6);
    editor.commands.insertFootnote("note one");
    editor.commands.focus("end");
    editor.commands.insertFootnote("note two");
    const md = planDocToMarkdown(editor.state.doc, { sidecars: false });
    expect(md).toContain("first[^1]");
    expect(md).toContain("second[^2]");
    expect(md).toContain("[^1]: note one");
    expect(md).toContain("[^2]: note two");
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
