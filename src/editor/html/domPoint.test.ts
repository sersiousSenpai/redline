// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it } from "vitest";

import {
  findAnchoredAncestor,
  offsetWithinAnchor,
  subBlockIdForSelection,
} from "./domPoint";

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

/** What the selection hook mints for `range` inside `anchorEl`: block-relative
 *  offsets through `offsetWithinAnchor`, then the sub-block id. */
function capture(anchorEl: HTMLElement, range: Range) {
  const charStart = offsetWithinAnchor(anchorEl, range.startContainer, range.startOffset);
  const charEnd = offsetWithinAnchor(anchorEl, range.endContainer, range.endOffset);
  const subBlockId = subBlockIdForSelection({
    anchorEl,
    blockId: anchorEl.dataset.blockId!,
    range,
    charStart,
    charEnd,
  });
  return { subBlockId, charStart, charEnd, selected: range.toString() };
}

/** Select `[from, to)` *within a single text node* and capture against
 *  `anchorEl`. Mirrors how a real browser anchors a selection inside the target
 *  unit's text node (rather than on a sibling boundary). */
function captureWithin(
  anchorEl: HTMLElement,
  textNode: Node,
  from: number,
  to: number,
) {
  const range = document.createRange();
  range.setStart(textNode, from);
  range.setEnd(textNode, to);
  return capture(anchorEl, range);
}

/** Select from `from` in one text node to `to` in another (a selection that
 *  crosses a unit boundary). */
function captureAcross(
  anchorEl: HTMLElement,
  startNode: Node,
  from: number,
  endNode: Node,
  to: number,
) {
  const range = document.createRange();
  range.setStart(startNode, from);
  range.setEnd(endNode, to);
  return capture(anchorEl, range);
}

/** The single text node holding `el`'s rendered text. */
function textNodeOf(el: Element): Node {
  return document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;
}

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("offsetWithinAnchor", () => {
  it("sums the text before a text-node endpoint, mirroring textContent", () => {
    const el = mountBlock("alpha <strong>beta</strong> gamma");
    // textContent === "alpha beta gamma"; "beta" sits at [6,10).
    const beta = el.querySelector("strong")!.firstChild!;
    expect(offsetWithinAnchor(el, beta, 0)).toBe(6);
    expect(offsetWithinAnchor(el, beta, 4)).toBe(10);
  });

  it("translates an element endpoint ('before child N') into a text offset", () => {
    const el = mountBlock("alpha <strong>beta</strong> gamma");
    expect(offsetWithinAnchor(el, el, 1)).toBe(6);
    expect(offsetWithinAnchor(el, el, 2)).toBe(10);
  });

  it("round-trips a range over inline markup to the selected characters", () => {
    const el = mountBlock("Hello brave world");
    const text = textNodeOf(el);
    const cap = captureWithin(el, text, 6, 11);
    expect(cap.selected).toBe("brave");
    expect(cap.charStart).toBe(6);
    expect(cap.charEnd).toBe(11);
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
    expect(captureWithin(ul, item2, 0, 18).subBlockId).toBe("blk-list1.l2");
    // "Second" → word 1 of item 2.
    expect(captureWithin(ul, item2, 0, 6).subBlockId).toBe("blk-list1.l2.w1");
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
    expect(cap.subBlockId).toBe("blk-tbl1.l3");
    // Bob = cell 5 → l5.
    const bob = textNodeOf(table.querySelectorAll("td")[2]);
    expect(captureWithin(table, bob, 0, 3).subBlockId).toBe("blk-tbl1.l5");
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
    expect(cap.subBlockId).toBe("blk-code1.l2");
    // Word 1 of line 2 = "const".
    expect(captureWithin(pre, code, 13, 18).subBlockId).toBe("blk-code1.l2.w1");
  });

  it("emits no sub id for a cross-unit selection (falls back to char tier)", () => {
    const ul = mountStructured(
      "<ul><li><p>First bullet item</p></li><li><p>Second bullet item</p></li></ul>",
      "blk-list1",
    );
    const [item1, item2] = Array.from(ul.querySelectorAll("li")).map(textNodeOf);
    // Spans item 1 into item 2 — no single unit owns it.
    const cap = captureAcross(ul, item1, 5, item2, 8);
    expect(cap.charStart).toBe(5);
    expect(cap.charEnd).toBe(25);
    expect(cap.subBlockId).toBeUndefined();
  });
});
