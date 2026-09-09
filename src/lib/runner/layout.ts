// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Harvested from feature/app-map: deterministic layered run graph layout.
// Longest-path layering over the acyclic core (back-edges found by a DFS in
// sorted-id order are ignored for layering only — they still render), then a
// fixed-iteration barycenter ordering pass with id tiebreaks, then a plain
// grid projection. No Date.now, no Math.random, no library: the SAME doc must
// produce a BYTE-IDENTICAL layout every call, because the streamed generation
// reveal re-runs this after every applied batch and the picture must grow,
// never reshuffle (the memoryMap.ts discipline).
//
// Pinned nodes (human-dragged, listed in `layout.pinned` with a stored
// `position`) still participate in layering/ordering — their edges shape the
// rest — but their emitted position is their stored one, verbatim: the
// machine NEVER moves a node a human placed.

import type { RunGraph, XY } from "./schema";

export const LAYOUT_COL_GAP = 310;
export const LAYOUT_ROW_GAP = 180;
export const LAYOUT_MARGIN = 40;
const ORDERING_SWEEPS = 4;

export interface RunLayoutResult {
  /** Position per node id, keyed in sorted-id order (stable stringify). */
  positions: Record<string, XY>;
  width: number;
  height: number;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Back-edges under a DFS that visits nodes and neighbours in sorted-id
 *  order — removing exactly these makes the graph acyclic, deterministically. */
function backEdges(
  ids: string[],
  out: Map<string, string[]>,
): Set<string> {
  const back = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>(); // 1 = on stack, 2 = done
  const visit = (id: string) => {
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      const s = state.get(to) ?? 0;
      if (s === 1) back.add(`${id}->${to}`);
      else if (s === 0) visit(to);
    }
    state.set(id, 2);
  };
  for (const id of ids) if ((state.get(id) ?? 0) === 0) visit(id);
  return back;
}

/**
 * The layout pass. Input order never matters: nodes and edges are re-sorted
 * by id internally, so a doc reloaded in a different array order draws the
 * same picture. Returns positions for EVERY node (pinned ones verbatim).
 */
export function layoutRunGraph(doc: RunGraph): RunLayoutResult {
  const ids = doc.nodes.map((n) => n.id).sort(byId);
  if (!ids.length) {
    return { positions: {}, width: 2 * LAYOUT_MARGIN, height: 2 * LAYOUT_MARGIN };
  }
  const idSet = new Set(ids);
  const pinnedPos = new Map<string, XY>();
  for (const pid of doc.nodes.filter((node) => node.position).map((node) => node.id)) {
    const node = doc.nodes.find((n) => n.id === pid);
    if (node?.position) pinnedPos.set(pid, node.position);
    // Unknown pinned ids (or pins without a stored position) are ignored.
  }

  // --- adjacency (sorted, deduped, self-loops dropped) ----------------------
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  for (const id of ids) {
    out.set(id, []);
    into.set(id, []);
  }
  const seen = new Set<string>();
  const pairs = doc.edges
    .map((e) => ({ from: e.from, to: e.to }))
    .filter((e) => idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to)
    .sort((a, b) => byId(a.from, b.from) || byId(a.to, b.to));
  for (const { from, to } of pairs) {
    const key = `${from}->${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.get(from)!.push(to);
    into.get(to)!.push(from);
  }
  const back = backEdges(ids, out);
  const isBack = (from: string, to: string) => back.has(`${from}->${to}`);

  // --- longest-path layering over the acyclic core --------------------------
  const layer = new Map<string, number>();
  const depth = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    layer.set(id, 0); // cycle guard; final value overwrites below
    let d = 0;
    for (const from of into.get(id) ?? []) {
      if (!isBack(from, id)) d = Math.max(d, depth(from) + 1);
    }
    layer.set(id, d);
    return d;
  };
  for (const id of ids) depth(id);
  const layerCount = 1 + Math.max(...ids.map((id) => layer.get(id)!));

  // --- barycenter ordering (fixed sweeps, id tiebreaks) ---------------------
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of ids) layers[layer.get(id)!].push(id); // arrives id-sorted
  const index = new Map<string, number>();
  const reindex = (l: string[]) => l.forEach((id, i) => index.set(id, i));
  layers.forEach(reindex);
  const order = (l: string[], neighbours: Map<string, string[]>) => {
    const bary = new Map<string, number>();
    for (const id of l) {
      const ns = (neighbours.get(id) ?? []).filter((n) => layer.get(n) !== layer.get(id));
      bary.set(
        id,
        ns.length
          ? ns.reduce((s, n) => s + index.get(n)!, 0) / ns.length
          : index.get(id)!,
      );
    }
    l.sort((a, b) => bary.get(a)! - bary.get(b)! || byId(a, b));
    reindex(l);
  };
  for (let sweep = 0; sweep < ORDERING_SWEEPS; sweep++) {
    for (let i = 1; i < layers.length; i++) order(layers[i], into);
    for (let i = layers.length - 2; i >= 0; i--) order(layers[i], out);
  }

  // --- grid projection ------------------------------------------------------
  const positions: Record<string, XY> = {};
  const widest = Math.max(...layers.map((l) => l.length));
  const along = (li: number) => LAYOUT_MARGIN + li * LAYOUT_COL_GAP;
  const across = (i: number, count: number) =>
    LAYOUT_MARGIN + (i + (widest - count) / 2) * LAYOUT_ROW_GAP;
  for (const id of ids) {
    const pin = pinnedPos.get(id);
    if (pin) {
      positions[id] = { x: pin.x, y: pin.y };
      continue;
    }
    const li = layer.get(id)!;
    const i = index.get(id)!;
    positions[id] = { x: along(li), y: across(i, layers[li].length) };
  }
  const xs = ids.map((id) => positions[id].x);
  const ys = ids.map((id) => positions[id].y);
  return {
    positions,
    width: Math.max(...xs) + LAYOUT_MARGIN,
    height: Math.max(...ys) + LAYOUT_MARGIN,
  };
}
