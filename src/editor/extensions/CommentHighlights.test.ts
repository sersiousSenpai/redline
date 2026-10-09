// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Editor } from "@tiptap/core";
import type { DecorationSet } from "@tiptap/pm/view";
import { afterEach, describe, expect, it } from "vitest";

import { planMarkdownToDoc } from "../markdown";
import {
  resolveRange,
  type CommentHighlightRange,
} from "../resolveHighlightRange";
import { CommentHighlights, commentHighlightsKey } from "./CommentHighlights";
import { planExtensions } from "./planExtensions";

const range = (over: Partial<CommentHighlightRange>): CommentHighlightRange => ({
  commentId: "c1",
  blockId: "blk-x",
  charStart: 0,
  charEnd: 0,
  quotedText: "",
  muted: false,
  ...over,
});

describe("resolveRange — sub-block tier is self-validating", () => {
  // "First sentence. Second sentence." — s1 = "First sentence.", s2 begins at 16.
  const text = "First sentence. Second sentence.";

  it("falls through to the char range when a stale sub-block id resolves to the wrong text", () => {
    // The stored sub-block id points at sentence 1, but the comment actually
    // quotes sentence 2 (block content drifted since capture). The guard must
    // reject the mismatched sub-block hit and honor the char range instead.
    const r = resolveRange(
      text,
      "P",
      range({
        charStart: 16,
        charEnd: 31,
        quotedText: "Second sentence",
        subBlockId: "blk-x.s1",
      }),
    );
    expect(r).toEqual({ from: 16, to: 31 });
  });

  it("honors a sub-block id whose slice matches the quoted text", () => {
    const r = resolveRange(
      text,
      "P",
      range({
        charStart: 0,
        charEnd: 15,
        quotedText: "First sentence.",
        subBlockId: "blk-x.s1",
      }),
    );
    expect(r).toEqual({ from: 0, to: 15 });
  });

  it("self-heals via quotedText when char offsets drift and no sub-block id is set", () => {
    const r = resolveRange(
      text,
      "P",
      range({
        charStart: 99,
        charEnd: 110,
        quotedText: "Second sentence",
      }),
    );
    expect(r).toEqual({ from: 16, to: 31 });
  });
});

describe("resolveRange — quotedText self-heal", () => {
  it("picks the occurrence nearest the captured charStart", () => {
    const text = "foo one foo two foo three";
    // Stale range near the SECOND "foo" (slice ≠ quote, so tier 3 runs).
    const r = resolveRange(
      text,
      "P",
      range({ charStart: 9, charEnd: 12, quotedText: "foo" }),
    );
    expect(r).toEqual({ from: 8, to: 11 });
  });

  it("matches a newline-split quote against newline-free block text", () => {
    // Selection.toString() over two list items yields "one\nBeta"; the
    // block's textContent joins the items with nothing.
    const text = "Alpha oneBeta two";
    expect(
      resolveRange(
        text,
        "UL",
        range({ charStart: 6, charEnd: 13, quotedText: "one\nBeta" }),
      ),
    ).toEqual({ from: 6, to: 13 });
    // Drifted offsets: the collapsed quote still self-heals by search.
    expect(
      resolveRange(
        text,
        "UL",
        range({ charStart: 40, charEnd: 49, quotedText: "one\n\nBeta" }),
      ),
    ).toEqual({ from: 6, to: 13 });
  });

  it("keeps a genuine newline verbatim (code blocks) before collapsing", () => {
    const text = "ab\na\nb";
    // Stale offsets sit on the collapsed "ab" at 0, but the verbatim "a\nb"
    // at 3 is still in the block and must win.
    expect(
      resolveRange(
        text,
        "PRE",
        range({ charStart: 0, charEnd: 3, quotedText: "a\nb" }),
      ),
    ).toEqual({ from: 3, to: 6 });
  });

  it("never collapses a code block's newlines, which are its own text", () => {
    // The quoted lines were since joined; "ab" elsewhere in the code is not
    // what the reviewer selected.
    expect(
      resolveRange(
        "x = ab;\ny = 1;",
        "PRE",
        range({ charStart: 4, charEnd: 7, quotedText: "a\nb" }),
      ),
    ).toBeNull();
  });

  it("returns null when even the collapsed quote is absent", () => {
    expect(
      resolveRange(
        "Alpha oneBeta two",
        "UL",
        range({ charStart: 0, charEnd: 5, quotedText: "gone\nwords" }),
      ),
    ).toBeNull();
  });
});

/**
 * Paint path against a real editor. Capture measures `charStart`/`charEnd`
 * against the anchored block's WHOLE flat text (every list item / table cell
 * end to end), so a comment without a clean `.lN` sub-block id must resolve in
 * that coordinate system — not against the block's first textblock, which
 * left every comment past the first item unpainted.
 */
describe("CommentHighlights — paints in whole-block coordinates", () => {
  const editors: Editor[] = [];
  afterEach(() => {
    for (const e of editors.splice(0)) e.destroy();
  });

  function paint(markdown: string, ranges: CommentHighlightRange[]): Editor {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const editor = new Editor({
      element: el,
      extensions: [...planExtensions(), CommentHighlights],
      content: planMarkdownToDoc(markdown).toJSON(),
    });
    editors.push(editor);
    editor.commands.setCommentHighlights(ranges);
    return editor;
  }

  /** Every span painted for `commentId`, in document order. */
  function spans(editor: Editor, commentId: string): HTMLElement[] {
    return Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>(
        `[data-comment-id="${commentId}"]`,
      ),
    );
  }
  const paintedText = (editor: Editor, commentId: string) =>
    spans(editor, commentId)
      .map((s) => s.textContent)
      .join("");

  /** A range quoting `quote` at its position in `blockText` (whole-block
   *  offsets, exactly as capture stores them). */
  function at(
    commentId: string,
    blockId: string,
    blockText: string,
    quote: string,
    over: Partial<CommentHighlightRange> = {},
  ): CommentHighlightRange {
    const charStart = blockText.indexOf(quote.replace(/\n+/g, ""));
    expect(charStart).toBeGreaterThanOrEqual(0);
    return range({
      commentId,
      blockId,
      charStart,
      charEnd: charStart + quote.replace(/\n+/g, "").length,
      quotedText: quote,
      ...over,
    });
  }

  const LIST = [
    "<!-- rl:blk-list1 -->",
    "- Alpha item one",
    "- Beta item two",
    "- Gamma item three",
    "",
  ].join("\n");
  const LIST_TEXT = "Alpha item oneBeta item twoGamma item three";

  it("paints a comment on every list item, not just the first", () => {
    const editor = paint(LIST, [
      at("c-1", "blk-list1", LIST_TEXT, "item one"),
      at("c-2", "blk-list1", LIST_TEXT, "Beta item"),
      at("c-3", "blk-list1", LIST_TEXT, "three"),
      // Partial-word drag — capture mints no sub-block id for these.
      at("c-4", "blk-list1", LIST_TEXT, "amm"),
    ]);
    expect(paintedText(editor, "c-1")).toBe("item one");
    expect(paintedText(editor, "c-2")).toBe("Beta item");
    expect(paintedText(editor, "c-3")).toBe("three");
    expect(paintedText(editor, "c-4")).toBe("amm");
    const items = editor.view.dom.querySelectorAll("li");
    expect(items[1].contains(spans(editor, "c-2")[0])).toBe(true);
    expect(items[2].contains(spans(editor, "c-4")[0])).toBe(true);
  });

  it("starts a selection made at item 2's first character inside item 2", () => {
    // A drag from a line's very beginning starts in the previous <li>; its
    // offset sits on the boundary shared with the end of item 1.
    const editor = paint(LIST, [at("c-1", "blk-list1", LIST_TEXT, "Beta item")]);
    const { state } = editor;
    const plugin = commentHighlightsKey.get(state)!;
    const set = plugin.props.decorations!.call(plugin, state) as DecorationSet;
    const [deco] = set.find();
    expect(state.doc.resolve(deco.from).parent.textContent).toBe(
      "Beta item two",
    );
    expect(state.doc.textBetween(deco.from, deco.to)).toBe("Beta item");
    expect(paintedText(editor, "c-1")).toBe("Beta item");
  });

  it("paints a whole two-paragraph list item quoted with a blank line", () => {
    const markdown = [
      "<!-- rl:blk-list2 -->",
      "1. First item.",
      "",
      "2. Second item, first paragraph.",
      "",
      "   Second item, second paragraph.",
      "",
      "3. Third item.",
      "",
    ].join("\n");
    const text =
      "First item.Second item, first paragraph.Second item, second paragraph.Third item.";
    const quote =
      "Second item, first paragraph.\n\nSecond item, second paragraph.";
    // The whole-unit `.l2` id capture mints here only names the item's first
    // paragraph, so the strict unit tier rejects it and the fallback paints.
    const editor = paint(markdown, [
      at("c-1", "blk-list2", text, quote, { subBlockId: "blk-list2.l2" }),
    ]);
    expect(planMarkdownToDoc(markdown).child(0).textContent).toBe(text);
    expect(spans(editor, "c-1")).toHaveLength(2);
    expect(paintedText(editor, "c-1")).toBe(quote.replace(/\n+/g, ""));
  });

  it("paints a table cell in row 2", () => {
    const markdown = [
      "<!-- rl:blk-tbl1 -->",
      "| Name | Role |",
      "| --- | --- |",
      "| Alice | Admin lead |",
      "| Bob | User |",
      "",
    ].join("\n");
    const text = "NameRoleAliceAdmin leadBobUser";
    const editor = paint(markdown, [
      at("c-1", "blk-tbl1", text, "dmin le"),
      at("c-2", "blk-tbl1", text, "Bob"),
    ]);
    expect(paintedText(editor, "c-1")).toBe("dmin le");
    expect(paintedText(editor, "c-2")).toBe("Bob");
    const cells = editor.view.dom.querySelectorAll("td, th");
    expect(cells[3].contains(spans(editor, "c-1")[0])).toBe(true);
  });

  it("paints both paragraphs of a blockquote at the exact characters", () => {
    // The first paragraph used to paint one character early: the old base
    // skipped only one of the two opening tokens before nested text.
    const markdown = [
      "<!-- rl:blk-q1 -->",
      "> First quoted line.",
      ">",
      "> Second quoted line.",
      "",
    ].join("\n");
    const text = "First quoted line.Second quoted line.";
    const editor = paint(markdown, [
      at("c-1", "blk-q1", text, "First quoted"),
      at("c-2", "blk-q1", text, "Second quoted"),
    ]);
    expect(paintedText(editor, "c-1")).toBe("First quoted");
    expect(paintedText(editor, "c-2")).toBe("Second quoted");
  });

  it("paints inside a nested list", () => {
    const markdown = [
      "<!-- rl:blk-n1 -->",
      "- Top one",
      "  - Nested alpha",
      "  - Nested beta",
      "- Top two",
      "",
    ].join("\n");
    const text = "Top oneNested alphaNested betaTop two";
    const editor = paint(markdown, [
      at("c-1", "blk-n1", text, "Nested beta"),
      at("c-2", "blk-n1", text, "Top two"),
    ]);
    expect(paintedText(editor, "c-1")).toBe("Nested beta");
    expect(paintedText(editor, "c-2")).toBe("Top two");
  });

  it("still resolves a clean `.lN.wM` id through the unit tier", () => {
    // Offsets deliberately stale: only the sub-block id can place it.
    const editor = paint(LIST, [
      range({
        commentId: "c-1",
        blockId: "blk-list1",
        charStart: 0,
        charEnd: 0,
        quotedText: "item three",
        subBlockId: "blk-list1.l3.w2-w3",
      }),
    ]);
    expect(paintedText(editor, "c-1")).toBe("item three");
  });

  it("paints a top-level paragraph exactly as before", () => {
    const editor = paint(
      ["<!-- rl:blk-p1 -->", "Plain **bold** paragraph text.", ""].join("\n"),
      [at("c-1", "blk-p1", "Plain bold paragraph text.", "bold paragraph")],
    );
    expect(paintedText(editor, "c-1")).toBe("bold paragraph");
  });
});
