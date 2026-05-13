import { useEffect, useState, type RefObject } from "react";

export interface SelectionState {
  anchorId: string;
  text: string;
  rect: DOMRect;
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
      setState({
        anchorId: anchorEl.dataset.anchorId ?? "",
        text,
        rect,
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
