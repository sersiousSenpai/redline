// SPDX-License-Identifier: Apache-2.0

export const TAB_DRAG_THRESHOLD = 4;
export const TAB_REORDER_HYSTERESIS = 3;
export const TAB_STRIP_SLOP = 40;
export const crossedDragThreshold = (dx: number, dy = 0) => Math.hypot(dx, dy) >= TAB_DRAG_THRESHOLD;

/** Move to the target tab's original array index, matching the preview in
 * either direction. The destination is a final slot, not an insert-before ID. */
export function reorderTabs<T extends { id: string }>(tabs: T[], dragId: string, targetId: string): T[] {
  const from = tabs.findIndex(tab => tab.id === dragId);
  const to = tabs.findIndex(tab => tab.id === targetId);
  if (from < 0 || to < 0 || from === to) return tabs;
  const next = tabs.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Cross a neighbor's midpoint with the tab's leading edge, regardless of
 * where it was grabbed. Keep the preview stable under small pointer jitters. */
export function tabDropIndex(midpoints: number[], from: number, center: number, width: number, current = from): number {
  const boundary = (index: number) => index < from ? midpoints[index] + width / 2 : midpoints[index + 1] - width / 2;
  let to = current;
  while (to < midpoints.length - 1 && center > boundary(to) + TAB_REORDER_HYSTERESIS) to++;
  while (to > 0 && center < boundary(to - 1) - TAB_REORDER_HYSTERESIS) to--;
  return to;
}

const settling = new WeakMap<HTMLElement, Animation>();

/** DOM transforms preview the order; onDrop must commit its DOM change
 * synchronously so the release animation can measure the new slots. */
export function startTabPointerDrag(event: PointerEvent, node: HTMLElement, options: {
  onDragging: (dragging: boolean) => void;
  onDrop: (targetSlotTabId: string | null, tileIndex: number | null) => void;
}): () => void {
  event.preventDefault();
  node.setPointerCapture(event.pointerId);
  const strip = node.parentElement!;
  const nodes = [...strip.querySelectorAll<HTMLElement>("[data-tab-id]")];
  nodes.forEach(tab => settling.get(tab)?.finish());
  const rects = nodes.map(tab => tab.getBoundingClientRect());
  const midpoints = rects.map(rect => rect.left + rect.width / 2);
  const from = nodes.indexOf(node), scrollLeft = strip.scrollLeft;
  const gap = rects.length > 1 ? rects[1].left - rects[0].right : 0;
  let moved = false, ended = false, to = from, tile: HTMLElement | null = null;
  let x = event.clientX, y = event.clientY, frame = 0, lastTime = 0;
  strip.classList.add("rb-tabs-dragging");

  const render = (elapsed = 0) => {
    const edge = strip.getBoundingClientRect();
    const inStrip = y >= edge.top - TAB_STRIP_SLOP && y <= edge.bottom + TAB_STRIP_SLOP;
    const beforeScroll = strip.scrollLeft;
    if (inStrip && elapsed) {
      const margin = Math.min(48, edge.width / 4);
      const speed = x > edge.right - margin ? Math.min(1, (x - edge.right + margin) / margin)
        : x < edge.left + margin ? -Math.min(1, (edge.left + margin - x) / margin) : 0;
      strip.scrollLeft = Math.max(0, Math.min(strip.scrollWidth - strip.clientWidth, strip.scrollLeft + speed * elapsed * .65));
    }
    const scroll = strip.scrollLeft - scrollLeft;
    const delta = Math.max(rects[0].left - rects[from].left,
      Math.min(rects[rects.length - 1].right - rects[from].right, x - event.clientX + scroll));
    node.style.setProperty("--tab-drag-x", `${delta}px`);
    to = tabDropIndex(midpoints, from, midpoints[from] + delta, rects[from].width, to);
    const order = nodes.map((_, i) => i);
    order.splice(from, 1); order.splice(to, 0, from);
    let left = rects[0].left;
    for (const index of order) {
      if (index !== from) nodes[index].style.setProperty("--tab-drag-x", `${left - rects[index].left}px`);
      left += rects[index].width + gap;
    }
    tile?.removeAttribute("data-tile-drop");
    // A slightly diagonal reorder is still a reorder. Tile assignment only
    // starts after deliberately leaving the strip and its generous margin.
    tile = !inStrip ? document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-tile-index]") ?? null : null;
    tile?.setAttribute("data-tile-drop", "true");
    return strip.scrollLeft !== beforeScroll;
  };
  const tick = (time: number) => {
    frame = 0;
    const keepScrolling = render(lastTime ? Math.min(32, time - lastTime) : 16);
    lastTime = time;
    if (keepScrolling && !ended) frame = requestAnimationFrame(tick);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId || ended) return;
    x = e.clientX; y = e.clientY;
    if (!moved && !crossedDragThreshold(x - event.clientX, y - event.clientY)) return;
    if (!moved) { moved = true; node.dataset.dragging = "true"; options.onDragging(true); }
    if (!frame) { lastTime = 0; frame = requestAnimationFrame(tick); }
  };
  const finish = (commit: boolean) => {
    if (ended) return;
    ended = true; cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", key); node.removeEventListener("lostpointercapture", cancel);
    const before = moved ? nodes.map(tab => tab.getBoundingClientRect().left) : [];
    const tileIndex = tile ? Number(tile.dataset.tileIndex) : null;
    strip.classList.remove("rb-tabs-dragging");
    nodes.forEach(tab => { tab.style.removeProperty("--tab-drag-x"); delete tab.dataset.dragging; });
    tile?.removeAttribute("data-tile-drop");
    if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    if (moved) options.onDragging(false);
    if (moved && commit) options.onDrop(nodes[to]?.dataset.tabId ?? null, tileIndex);
    if (!moved || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    // FLIP from the actual on-screen positions to the committed DOM order.
    // Removing CSS transforms alone would make siblings jump twice on release.
    nodes.forEach((tab, index) => {
      if (!tab.isConnected || !tab.animate) return;
      const delta = before[index] - tab.getBoundingClientRect().left;
      if (Math.abs(delta) < .5) return;
      const animation = tab.animate([{ transform: `translateX(${delta}px)` }, { transform: "translateX(0px)" }],
        { duration: 160, easing: "cubic-bezier(.2,.8,.2,1)" });
      settling.set(tab, animation);
      animation.onfinish = animation.oncancel = () => { if (settling.get(tab) === animation) settling.delete(tab); };
    });
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId || ended) return;
    if (moved) { x = e.clientX; y = e.clientY; render(); }
    finish(true);
  };
  const cancel = () => finish(false);
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); cancel(); } };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel);
  window.addEventListener("keydown", key); node.addEventListener("lostpointercapture", cancel);
  return cancel;
}
