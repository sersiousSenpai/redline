// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Merging tabs by drag (W5): a tab dragged down out of the strip and over a
// pane of the tab on screen lands on that pane's nearest edge, splitting it
// that way with the dragged tab's whole layout (`mergeTab`). Pure: the
// stage measures the panes (`paneBoxes`), this picks the target and the box
// to light. Small: App reads `paneBoxes` for ⌃⌘ + an arrow.

import type { DropEdge, PaneRect } from "./reducer";

export interface DropTarget {
  paneId: string;
  edge: DropEdge;
  /** The half of the pane the merged tab will take, to light. */
  zone: PaneRect;
}

/** The edge of `rect` nearest the point: its left, right, top or bottom
 *  quarter, and the nearest edge from the middle too. */
export function dropEdgeAt(rect: PaneRect, x: number, y: number): DropEdge {
  const fx = rect.width > 0 ? (x - rect.left) / rect.width : 0.5;
  const fy = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;
  const edges: [DropEdge, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  return edges.reduce((best, e) => (e[1] < best[1] ? e : best))[0];
}

/** The half of `rect` a merge on `edge` gives the merged tab. */
export function dropZone(rect: PaneRect, edge: DropEdge): PaneRect {
  const w = rect.width / 2;
  const h = rect.height / 2;
  switch (edge) {
    case "left":
      return { left: rect.left, top: rect.top, width: w, height: rect.height };
    case "right":
      return { left: rect.left + w, top: rect.top, width: w, height: rect.height };
    case "top":
      return { left: rect.left, top: rect.top, width: rect.width, height: h };
    case "bottom":
      return { left: rect.left, top: rect.top + h, width: rect.width, height: h };
  }
}

/** The pane under the point among `rects`, and where a drop there lands;
 *  null outside every pane. */
export function dropTargetAt(rects: Readonly<Record<string, PaneRect>>, x: number, y: number): DropTarget | null {
  for (const [paneId, r] of Object.entries(rects)) {
    if (x < r.left || x > r.left + r.width || y < r.top || y > r.top + r.height) continue;
    const edge = dropEdgeAt(r, x, y);
    return { paneId, edge, zone: dropZone(r, edge) };
  }
  return null;
}

/** Each pane's box in the tab `tabId` under `scope`, in the viewport's
 *  coordinates: what ⌃⌘ + an arrow and a merge drop measure. `shownOnly`
 *  leaves out the panes a zoom hides. */
export function paneBoxes(scope: ParentNode | null, tabId: string, shownOnly = false): Record<string, PaneRect> {
  const out: Record<string, PaneRect> = {};
  const body = [...(scope?.querySelectorAll<HTMLElement>(".rl-wb-tab-body[data-wb-tab]") ?? [])].find((el) => el.dataset.wbTab === tabId);
  const zoomed = shownOnly && !!body?.hasAttribute("data-zoomed");
  for (const el of body?.querySelectorAll<HTMLElement>(".rl-wb-pane[data-pane-id]") ?? []) {
    if (zoomed && !el.hasAttribute("data-zoomed")) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out[el.dataset.paneId!] = { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  return out;
}
