// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  blockKindForTag,
  computeSubBlockId,
  computeWordsInUnit,
} from "../subBlockResolve";
import { segmentSourceLines } from "../sentenceSegment";
import { sidecarIdToString, type SubAxis } from "../markdown/sidecar";

/**
 * Shared DOM-anchor geometry for the comment system. These helpers turn a DOM
 * selection into block-relative character offsets (mirroring `textContent`),
 * so a selection captured here re-locates the same characters on render.
 * Extracted from `useTextSelection`, which is their caller.
 */

/** Walk up from `node` to the nearest element carrying `data-anchor-id`. */
export function findAnchoredAncestor(node: Node): HTMLElement | null {
  let el: Node | null = node;
  if (el.nodeType === Node.TEXT_NODE) el = el.parentNode;
  while (el) {
    if (el instanceof HTMLElement && el.dataset.anchorId) return el;
    el = el.parentNode;
  }
  return null;
}

/** Walk text nodes inside `anchor` in document order, summing lengths, until we
 *  reach `targetNode` — then add `targetOffset`. Mirrors what `textContent`
 *  produces, so a selection saved as `(charStart, charEnd)` re-locates the same
 *  characters on render. */
export function offsetWithinAnchor(
  anchor: HTMLElement,
  targetNode: Node,
  targetOffset: number,
): number {
  // If the range endpoint is on an element (not a text node), translate it into
  // a text-node coordinate first. DOM convention: an offset of N on an element
  // points "before child N". So sum text up to that child.
  if (targetNode.nodeType === Node.ELEMENT_NODE) {
    let total = 0;
    let found = false;
    const visit = (n: Node, childIndex: number, parent: Node): boolean => {
      if (parent === targetNode && childIndex === targetOffset) {
        found = true;
        return true;
      }
      if (n.nodeType === Node.TEXT_NODE) {
        total += n.nodeValue?.length ?? 0;
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const children = n.childNodes;
        for (let i = 0; i < children.length; i++) {
          if (visit(children[i], i, n)) return true;
        }
      }
      return false;
    };
    const rootChildren = anchor.childNodes;
    for (let i = 0; i < rootChildren.length; i++) {
      if (visit(rootChildren[i], i, anchor)) break;
    }
    void found;
    return total;
  }
  // Text-node endpoint: sum every preceding text node's length, then add the
  // node-local offset.
  let total = 0;
  const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node === targetNode) return total + targetOffset;
    total += node.nodeValue?.length ?? 0;
    node = walker.nextNode();
  }
  return total;
}

/** Climb from `node` to the nearest `<li>` / `<td>` / `<th>` *unit* element
 *  inside `anchorEl`, and report its document-order index among same-kind units
 *  in the block. Returns `null` when the selection isn't inside such a unit
 *  (e.g. a blockquote, whose units have no element handle). The index counts
 *  every matching element in `querySelectorAll` order — which is PM descendant
 *  order — so capture and resolve agree on "unit N". */
function findUnitElement(
  anchorEl: HTMLElement,
  node: Node,
): { el: HTMLElement; index: number } | null {
  let cur: Node | null = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
  let unitEl: HTMLElement | null = null;
  while (cur && cur !== anchorEl) {
    if (cur instanceof HTMLElement) {
      const t = cur.tagName.toUpperCase();
      if (t === "LI" || t === "TD" || t === "TH") {
        unitEl = cur;
        break;
      }
    }
    cur = cur.parentNode;
  }
  if (!unitEl) return null;
  const selector = unitEl.tagName.toUpperCase() === "LI" ? "li" : "td,th";
  const all = Array.from(anchorEl.querySelectorAll(selector));
  const index = all.indexOf(unitEl);
  if (index === -1) return null;
  return { el: unitEl, index };
}

/** Build a `.lN[.wM]` line-axis sub-block id for a selection inside a
 *  structured block (list / table / code). Each unit (item / cell / source
 *  line) has its own clean text — no parent flattening — so the word range is
 *  computed against the unit alone and round-trips to {@link findUnitNode} on
 *  the resolve side. Returns `undefined` for partial-word or cross-unit
 *  selections, which fall back to the char/quotedText tier. */
function computeLineSubBlockId(args: {
  anchorEl: HTMLElement;
  blockId: string;
  range: Range;
  charStart: number;
  charEnd: number;
}): string | undefined {
  const { anchorEl, blockId, range, charStart, charEnd } = args;
  const tag = anchorEl.tagName.toUpperCase();

  let unitIndex: number;
  let unitText: string;
  let relStart: number;
  let relEnd: number;

  if (tag === "PRE" || tag === "CODE") {
    // Code block: units are source lines of the flat text. `charStart`/`charEnd`
    // are already block-relative, so locate the line and offset into it.
    const lines = segmentSourceLines(anchorEl.textContent ?? "");
    const lineIdx = lines.findIndex(
      (l) => charStart >= l.start && charStart < l.end,
    );
    if (lineIdx === -1) return undefined;
    const line = lines[lineIdx];
    if (charEnd > line.end) return undefined; // crosses a line boundary
    unitIndex = lineIdx; // 0-based; +1 below
    unitText = line.text;
    relStart = charStart - line.start;
    relEnd = charEnd - line.start;
  } else {
    // List / table: the unit is the enclosing <li>/<td>/<th>; offsets are
    // measured against the unit element's own textContent.
    const unit = findUnitElement(anchorEl, range.startContainer);
    if (!unit) return undefined;
    const a = offsetWithinAnchor(unit.el, range.startContainer, range.startOffset);
    const b = offsetWithinAnchor(unit.el, range.endContainer, range.endOffset);
    unitIndex = unit.index;
    unitText = unit.el.textContent ?? "";
    relStart = Math.min(a, b);
    relEnd = Math.max(a, b);
  }

  const axis: SubAxis = { kind: "line", index: unitIndex + 1 };

  // Whole-unit selection: no word qualifier.
  if (relStart === 0 && relEnd === unitText.length && relEnd > relStart) {
    return sidecarIdToString({ kind: "subBlock", blockId, axis, words: null });
  }
  const words = computeWordsInUnit(unitText, relStart, relEnd);
  if (!words) return undefined;
  return sidecarIdToString({ kind: "subBlock", blockId, axis, words });
}

/** Single entry point for both selection hooks: derive the sub-block id for a
 *  non-empty selection, dispatching on the block's addressing axis. */
export function subBlockIdForSelection(args: {
  anchorEl: HTMLElement;
  blockId: string;
  range: Range;
  charStart: number;
  charEnd: number;
}): string | undefined {
  if (args.charEnd <= args.charStart) return undefined;
  const kind = blockKindForTag(args.anchorEl.tagName);
  if (kind === "line") return computeLineSubBlockId(args);
  return computeSubBlockId({
    blockId: args.blockId,
    blockText: args.anchorEl.textContent ?? "",
    kind,
    charStart: args.charStart,
    charEnd: args.charEnd,
  });
}
