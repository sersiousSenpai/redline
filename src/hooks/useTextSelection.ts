// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState, type RefObject } from "react";

export interface SelectionState {
  anchorId: string;
  text: string;
  rect: DOMRect;
  /** Character offset of the selection's start within the anchored block's
   *  `textContent`. Block-relative so it survives Tiptap transactions and
   *  revision regenerations (which preserve `blockId`); absolute PM
   *  positions would drift on every keystroke. */
  charStart: number;
  charEnd: number;
}

export function useTextSelection(
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): [SelectionState | null, () => void] {
  const [state, setState] = useState<SelectionState | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    const handler = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setState(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const root = rootRef.current;
      if (!root || !root.contains(range.commonAncestorContainer)) {
        setState(null);
        return;
      }
      const anchorEl = findAnchoredAncestor(range.commonAncestorContainer);
      if (!anchorEl) {
        setState(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        setState(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      // Compute the selection's start/end as character offsets within the
      // anchored block's flat textContent. Walking the DOM here keeps the
      // hook decoupled from Tiptap internals — any `data-anchor-id` element
      // works.
      const start = offsetWithinAnchor(
        anchorEl,
        range.startContainer,
        range.startOffset,
      );
      const end = offsetWithinAnchor(
        anchorEl,
        range.endContainer,
        range.endOffset,
      );
      const charStart = Math.min(start, end);
      const charEnd = Math.max(start, end);
      setState({
        anchorId: anchorEl.dataset.anchorId ?? "",
        text,
        rect,
        charStart,
        charEnd,
      });
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [rootRef, enabled]);

  const clear = () => {
    setState(null);
    const sel = window.getSelection();
    sel?.removeAllRanges();
  };

  return [state, clear];
}

function findAnchoredAncestor(node: Node): HTMLElement | null {
  let el: Node | null = node;
  if (el.nodeType === Node.TEXT_NODE) el = el.parentNode;
  while (el) {
    if (el instanceof HTMLElement && el.dataset.anchorId) return el;
    el = el.parentNode;
  }
  return null;
}

/** Walk text nodes inside `anchor` in document order, summing lengths, until
 *  we reach `targetNode` — then add `targetOffset`. Mirrors what `textContent`
 *  produces, so a comment selection saved as `(charStart, charEnd)` re-locates
 *  the same characters on render. */
function offsetWithinAnchor(
  anchor: HTMLElement,
  targetNode: Node,
  targetOffset: number,
): number {
  // If the range endpoint is on an element (not a text node), we have to
  // translate it into a text-node coordinate first. DOM convention: an offset
  // of N on an element points "before child N". So sum text up to that child.
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
        if (n === targetNode && childIndex < 0) {
          // targetOffset points to the end (childNodes.length); we already
          // summed all children above, fall through.
        }
      }
      return false;
    };
    const rootChildren = anchor.childNodes;
    for (let i = 0; i < rootChildren.length; i++) {
      if (visit(rootChildren[i], i, anchor)) break;
    }
    if (!found && targetNode === anchor) {
      // Offset on the anchor itself, past the last child: total is the full
      // textContent length up to that point.
    }
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
