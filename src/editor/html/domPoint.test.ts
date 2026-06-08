// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it } from "vitest";

import {
  findAnchoredAncestor,
  offsetWithinAnchor,
  pointFromDomSelection,
} from "./domPoint";
import { charRangeToDomRange } from "./domRange";

function mountBlock(inner: string): HTMLElement {
  const el = document.createElement("p");
  el.dataset.anchorId = "A.p1";
  el.dataset.blockId = "blk-x";
  el.innerHTML = inner;
  document.body.appendChild(el);
  return el;
}

/** Mount a structured block (its outer tag is inferred from `html`) carrying a
 *  redline anchor + block id, mirroring how the editor renders it. */
function mountStructured(html: string, blockId: string): HTMLElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  const el = tpl.content.firstElementChild as HTMLElement;
  el.dataset.anchorId = "A.b1";
  el.dataset.blockId = blockId;
  document.body.appendChild(el);
  return el;
}

/** Select `[from, to)` of `el`'s textContent and return the captured point. */
function captureSelection(el: HTMLElement, from: number, to: number) {
  const range = charRangeToDomRange(el, from, to)!;
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return { point: pointFromDomSelection(el), selected: range.toString() };
}

/** Select `[from, to)` *within a single text node* and capture against
 *  `anchorEl`. Mirrors how a real browser anchors a selection inside the target
 *  unit's text node (rather than on a sibling boundary, as the char-offset
 *  walker can). */
function captureWithin(
  anchorEl: HTMLElement,
  textNode: Node,
  from: number,
  to: number,
) {
  const range = document.createRange();
  range.setStart(textNode, from);
  range.setEnd(textNode, to);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return { point: pointFromDomSelection(anchorEl), selected: range.toString() };
}

/** The single text node holding `el`'s rendered text. */
function textNodeOf(el: Element): Node {
  return document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;
}

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("offsetWithinAnchor ↔ charRangeToDomRange round-trip", () => {
  it("recovers the original char offsets from a built range", () => {
    const el = mountBlock("alpha <strong>beta</strong> gamma");
    // textContent === "alpha beta gamma"; pick "beta" at [6,10).
    const range = charRangeToDomRange(el, 6, 10)!;
    const start = offsetWithinAnchor(el, range.startContainer, range.startOffset);
    const end = offsetWithinAnchor(el, range.endContainer, range.endOffset);
    expect(start).toBe(6);
    expect(end).toBe(10);
    expect(range.toString()).toBe("beta");
  });
});

describe("findAnchoredAncestor", () => {
  it("walks up from a text node to the data-anchor-id element", () => {
    const el = mountBlock("hello <em>there</em>");
    const emText = el.querySelector("em")!.firstChild!;
    expect(findAnchoredAncestor(emText)).toBe(el);
  });

  it("returns null outside any anchored block", () => {
    const loose = document.createElement("div");
    loose.textContent = "x";
    document.body.appendChild(loose);
    expect(findAnchoredAncestor(loose.firstChild!)).toBeNull();
  });
});

describe("pointFromDomSelection", () => {
  it("returns null when there is no selection in the root", () => {
    const el = mountBlock("hello world");
    window.getSelection()?.removeAllRanges();
    expect(pointFromDomSelection(el)).toBeNull();
  });

  it("captures a range selection with block-relative offsets", () => {
    const el = mountBlock("Hello brave world");
    const range = charRangeToDomRange(el, 6, 11)!; // "brave"
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const pt = pointFromDomSelection(el);
    expect(pt).not.toBeNull();
    expect(pt!.blockId).toBe("blk-x");
    expect(pt!.anchorId).toBe("A.p1");
    expect(pt!.charStart).toBe(6);
    expect(pt!.charEnd).toBe(11);
    expect(pt!.collapsed).toBe(false);
  });

  it("captures a collapsed caret as a zero-width point", () => {
    const el = mountBlock("Hello world");
    const caret = charRangeToDomRange(el, 5, 5)!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(caret);
    const pt = pointFromDomSelection(el);
    expect(pt).not.toBeNull();
    expect(pt!.collapsed).toBe(true);
    expect(pt!.charStart).toBe(5);
    expect(pt!.charEnd).toBe(5);
  });
});

describe("line-axis capture — mints `.lN` ids the unit resolver round-trips", () => {
  // The id strings below are the capture half of the round-trip whose resolve
  // half lives in `unitResolve.test.ts` (same logical selections, same ids).

  it("mints a whole-item / single-word id for a bullet list item", () => {
    const ul = mountStructured(
      "<ul><li><p>First bullet item</p></li><li><p>Second bullet item</p></li><li><p>Third bullet item</p></li></ul>",
      "blk-list1",
    );
    const item2 = textNodeOf(ul.querySelectorAll("li")[1]); // "Second bullet item"
    // Whole item 2.
    expect(captureWithin(ul, item2, 0, 18).point!.subBlockId).toBe(
      "blk-list1.l2",
    );
    // "Second" → word 1 of item 2.
    expect(captureWithin(ul, item2, 0, 6).point!.subBlockId).toBe(
      "blk-list1.l2.w1",
    );
  });

  it("mints a row-major cell id for a table cell", () => {
    const table = mountStructured(
      "<table><tbody>" +
        "<tr><th><p>Name</p></th><th><p>Role</p></th></tr>" +
        "<tr><td><p>Alice</p></td><td><p>Admin</p></td></tr>" +
        "<tr><td><p>Bob</p></td><td><p>User</p></td></tr>" +
        "</tbody></table>",
      "blk-tbl1",
    );
    // td order (row-major, after the two header cells): Alice=cell 3 → l3.
    const alice = textNodeOf(table.querySelectorAll("td")[0]);
    const cap = captureWithin(table, alice, 0, 5);
    expect(cap.selected).toBe("Alice");
    expect(cap.point!.subBlockId).toBe("blk-tbl1.l3");
    // Bob = cell 5 → l5.
    const bob = textNodeOf(table.querySelectorAll("td")[2]);
    expect(captureWithin(table, bob, 0, 3).point!.subBlockId).toBe(
      "blk-tbl1.l5",
    );
  });

  it("mints a source-line id for a code block", () => {
    const pre = mountStructured(
      "<pre><code>const a = 1;\nconst b = 2;\nconst c = 3;</code></pre>",
      "blk-code1",
    );
    const code = textNodeOf(pre); // one text node spanning all three lines
    // Line 2 "const b = 2;" spans chars 13..25 of the flat text.
    const cap = captureWithin(pre, code, 13, 25);
    expect(cap.selected).toBe("const b = 2;");
    expect(cap.point!.subBlockId).toBe("blk-code1.l2");
    // Word 1 of line 2 = "const".
    expect(captureWithin(pre, code, 13, 18).point!.subBlockId).toBe(
      "blk-code1.l2.w1",
    );
  });

  it("emits no sub id for a cross-unit selection (falls back to char tier)", () => {
    const ul = mountStructured(
      "<ul><li><p>First bullet item</p></li><li><p>Second bullet item</p></li></ul>",
      "blk-list1",
    );
    // Spans item 1 into item 2 — no single unit owns it.
    expect(captureSelection(ul, 5, 25).point!.subBlockId).toBeUndefined();
  });
});
