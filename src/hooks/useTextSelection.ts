// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState, type RefObject } from "react";

import {
  blockKindForTag,
  computeSubBlockId,
} from "../editor/subBlockResolve";
import {
  findAnchoredAncestor,
  offsetWithinAnchor,
} from "../editor/html/domPoint";

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
  /** Sub-block sidecar id naming the selection's range structurally — set
   *  only when the selection lands on whole-word / whole-line /
   *  whole-sentence boundaries. Lets the highlight resolver re-locate the
   *  range across revises without depending on the byte-fragile
   *  (charStart, charEnd, quotedText) tier. */
  subBlockId?: string;
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
      // Sub-block id, if the selection lands on a clean unit boundary.
      // `data-block-id` is surfaced by `BlockIdAttribute`; absent = legacy
      // / sidebar-only block, in which case the sub-id is undefined and the
      // comment resolves via the (charStart, charEnd, quotedText) tier.
      const blockId = anchorEl.dataset.blockId;
      let subBlockId: string | undefined;
      const kind = blockKindForTag(anchorEl.tagName);
      // Only mint sub-block ids on the sentence axis (paragraphs / headings).
      // The line axis (lists, code, blockquote) computes its id against the
      // block's flat DOM textContent, which concatenates items with no
      // newlines — but the highlight resolver reads only the first inner
      // textblock, so the id never round-trips. Those blocks fall back to the
      // (charStart, charEnd, quotedText) tier, which is stable for them.
      if (blockId && kind === "sentence") {
        subBlockId = computeSubBlockId({
          blockId,
          blockText: anchorEl.textContent ?? "",
          kind,
          charStart,
          charEnd,
        });
      }
      setState({
        anchorId: anchorEl.dataset.anchorId ?? "",
        text,
        rect,
        charStart,
        charEnd,
        subBlockId,
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
