// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { blockKindForTag, computeSubBlockId } from "../subBlockResolve";

/**
 * Shared DOM-anchor geometry for the comment system. These helpers turn a DOM
 * selection/caret into block-relative character offsets (mirroring
 * `textContent`), so a selection captured here re-locates the same characters on
 * render. Extracted from `useTextSelection` so both the (range-only) selection
 * hook and the HTML redline surface (which also needs caret points) share one
 * implementation.
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

/** A resolved DOM point — the current selection or caret, mapped to a block. */
export interface DomPoint {
  anchorEl: HTMLElement;
  anchorId: string;
  /** Stable block id (`data-block-id`), if the anchored element carries one. */
  blockId: string | undefined;
  /** Block-relative char offsets. Equal when the selection is a collapsed caret. */
  charStart: number;
  charEnd: number;
  /** Raw selected text (empty for a caret). */
  text: string;
  /** Sub-block sidecar id when a non-empty selection lands on clean unit
   *  boundaries (sentence axis only). */
  subBlockId?: string;
  /** Bounding rect of the range/caret (viewport coords). */
  rect: DOMRect;
  collapsed: boolean;
}

/**
 * Resolve the current window selection (or caret) to a {@link DomPoint} inside
 * `root`. Unlike `useTextSelection`, this accepts a collapsed caret — the HTML
 * redline surface needs the caret position to pin a floating note. Returns null
 * when there's no selection inside `root` or no anchored block.
 */
export function pointFromDomSelection(root: HTMLElement | null): DomPoint | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root || !root.contains(range.commonAncestorContainer)) return null;
  const anchorEl = findAnchoredAncestor(range.commonAncestorContainer);
  if (!anchorEl) return null;
  const start = offsetWithinAnchor(anchorEl, range.startContainer, range.startOffset);
  const end = offsetWithinAnchor(anchorEl, range.endContainer, range.endOffset);
  const charStart = Math.min(start, end);
  const charEnd = Math.max(start, end);
  const blockId = anchorEl.dataset.blockId;
  let subBlockId: string | undefined;
  const kind = blockKindForTag(anchorEl.tagName);
  if (blockId && kind === "sentence" && charEnd > charStart) {
    subBlockId = computeSubBlockId({
      blockId,
      blockText: anchorEl.textContent ?? "",
      kind,
      charStart,
      charEnd,
    });
  }
  return {
    anchorEl,
    anchorId: anchorEl.dataset.anchorId ?? "",
    blockId,
    charStart,
    charEnd,
    text: sel.toString(),
    subBlockId,
    rect: rangeRect(range),
    collapsed: sel.isCollapsed,
  };
}

/** Range bounding rect, tolerant of environments (jsdom) where a selection's
 *  range doesn't implement layout. Real WebViews always have it. */
function rangeRect(range: Range): DOMRect {
  if (typeof range.getBoundingClientRect === "function") {
    return range.getBoundingClientRect();
  }
  return typeof DOMRect !== "undefined"
    ? new DOMRect()
    : ({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
      } as DOMRect);
}
