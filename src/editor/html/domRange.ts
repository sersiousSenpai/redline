// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/**
 * Convert a block-relative character range into a DOM {@link Range} inside
 * `blockEl`. This is the inverse of `offsetWithinAnchor` in
 * `useTextSelection.ts`: that hook walks the block's text nodes in document
 * order summing `nodeValue.length` to turn a DOM point into a character offset
 * (mirroring `textContent`); here we walk the same way to turn a character
 * offset back into a DOM point.
 *
 * Used by the static-HTML annotation overlay to resolve a stored comment
 * selection (already mapped to char offsets via the shared `resolveRange`) into
 * client rects via `range.getClientRects()` — so highlights paint over exactly
 * the same characters the editor mode would.
 *
 * Returns `null` only when the block has no text at all.
 */
export function charRangeToDomRange(
  blockEl: HTMLElement,
  start: number,
  end: number,
): Range | null {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const startPoint = locatePoint(blockEl, lo);
  const endPoint = locatePoint(blockEl, hi);
  if (!startPoint || !endPoint) return null;
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

/** Walk text nodes in document order, accumulating lengths, until the running
 *  total reaches `target` — then the point is that node at the leftover offset.
 *  A target landing exactly on a node boundary resolves to the end of the
 *  earlier node (visually identical to the start of the next), which is fine
 *  for rect computation. Clamps to the final text node's end when `target`
 *  exceeds the block's text length. */
function locatePoint(
  blockEl: HTMLElement,
  target: number,
): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let last: Node | null = null;
  let node = walker.nextNode();
  while (node) {
    const len = node.nodeValue?.length ?? 0;
    if (acc + len >= target) {
      return { node, offset: Math.max(0, target - acc) };
    }
    acc += len;
    last = node;
    node = walker.nextNode();
  }
  // Past the end of the block's text — clamp to the last text node's end.
  if (last) return { node: last, offset: last.nodeValue?.length ?? 0 };
  return null;
}
