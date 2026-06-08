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
