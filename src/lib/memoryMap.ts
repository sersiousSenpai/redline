// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The Memory Map's pure core (Second Brain P5, §3): wire shapes of the
// `memory_map` command and the deterministic seeded layout. The four rules
// live here as code: nodes are classes and sessions (the backend never sends
// raw prompts; the ~150 cap is enforced in `layoutMap` and reported, never
// silent); the layout is radial-tree-first with a bounded, fixed-seed force
// refinement so the same record always draws the same picture (spatial
// memory); edges carry declared kinds the renderer toggles; and every node
// carries exactly one Timeline focus handle so a click filters, never
// decorates. No graph library — hand-rolled, dependency-free, unit-tested
// (the `virtual.ts` discipline). No Date.now / Math.random anywhere.

/** Mirror of `context::MapNode`. */
export interface MapNode {
  id: string;
  kind: "class" | "digest" | "session" | "thread";
  label: string;
  /** Classes: filed-link count; threads: message count. Radius, never dots. */
  mass: number;
  /** Structural parent in the same keyspace — the layout prior. */
  parentId: string | null;
  pinned: boolean;
  projectPath: string | null;
  classNodeId: string | null;
  sessionId: string | null;
  browseId: string | null;
  threadId: string | null;
}

export type EdgeKind = "contains" | "lineage" | "supersedes" | "co_occurs";

/** Mirror of `context::MapEdge`. */
export interface MapEdge {
  kind: EdgeKind;
  from: string;
  to: string;
  weight: number;
  basis: string | null;
}

/** Mirror of `context::MemoryMapView`. */
export interface MemoryMapData {
  generatedTs: number;
  nodes: MapNode[];
  edges: MapEdge[];
}

/** §3 rule 1's ceiling: past ~150 nodes a map is a hairball, so the layout
 *  keeps the heaviest subtrees and REPORTS the rest via `hidden`. */
export const NODE_CAP = 150;

export const EDGE_KINDS: readonly EdgeKind[] = [
  "contains",
  "lineage",
  "supersedes",
  "co_occurs",
];

export const EDGE_LABEL: Record<EdgeKind, string> = {
  contains: "Contains",
  lineage: "Lineage",
  supersedes: "Supersedes",
  co_occurs: "Co-occurs",
};

/** The derived edge is opt-in (§3 rule 3); the declared three start on. */
export const DEFAULT_EDGE_TOGGLES: Record<EdgeKind, boolean> = {
  contains: true,
  lineage: true,
  supersedes: true,
  co_occurs: false,
};

export interface PlacedNode extends MapNode {
  x: number;
  y: number;
  /** Pixel radius — area ∝ mass (sqrt scale), floored so 0-mass stays visible. */
  r: number;
  depth: number;
}

export interface MapLayout {
  nodes: PlacedNode[];
  /** Nodes the cap dropped — the UI states this, never swallows it. */
  hidden: number;
  width: number;
  height: number;
}

const R_MIN = 6;
const R_MAX = 26;
const FORCE_ITERATIONS = 120;
const PAIR_PADDING = 6;
const ANCHOR_PULL = 0.04;

/** FNV-1a over a string — the per-node seed source (id-stable, order-free). */
function hashId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — a tiny deterministic PRNG; the "fixed seed" of §3 rule 2. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TreeEntry {
  node: MapNode;
  children: TreeEntry[];
  subtreeMass: number;
  leaves: number;
}

/** Subtree mass (own + descendants) per node id — the cap's ranking and the
 *  treemap's rollup share this. Cycle-safe: a parent chain revisiting itself
 *  breaks out rather than recursing forever. */
export function subtreeMasses(nodes: MapNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, number>();
  for (const n of nodes) out.set(n.id, 0);
  for (const n of nodes) {
    // Add this node's own mass to itself and every ancestor.
    let cur: MapNode | undefined = n;
    const visited = new Set<string>();
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      out.set(cur.id, (out.get(cur.id) ?? 0) + Math.max(0, n.mass));
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return out;
}

/**
 * The deterministic seeded layout. Radial tree first (roots on a ring in
 * mass order, each subtree owning an angular sector proportional to its leaf
 * count, children one ring outward inside their parent's sector), then a
 * bounded force refinement (fixed iteration count, fixed order, id-seeded
 * jitter) that separates overlaps without destroying the tree shape — physics
 * second, never in charge. Same input + same viewport → identical output.
 */
export function layoutMap(
  data: MemoryMapData,
  width: number,
  height: number,
  cap: number = NODE_CAP,
): MapLayout {
  const w = Math.max(80, width);
  const h = Math.max(80, height);
  if (!data.nodes.length) return { nodes: [], hidden: 0, width: w, height: h };

  // --- cap by subtree mass, stated not silent ------------------------------
  const subtree = subtreeMasses(data.nodes);
  const ranked = data.nodes
    .slice()
    .sort(
      (a, b) =>
        (subtree.get(b.id) ?? 0) - (subtree.get(a.id) ?? 0) ||
        (a.id < b.id ? -1 : 1),
    );
  const kept = ranked.slice(0, Math.max(1, cap));
  const hidden = data.nodes.length - kept.length;
  const keptIds = new Set(kept.map((n) => n.id));

  // --- forest (a kept node whose parent was dropped becomes a root) --------
  const entries = new Map<string, TreeEntry>();
  for (const n of kept) {
    entries.set(n.id, { node: n, children: [], subtreeMass: subtree.get(n.id) ?? 0, leaves: 0 });
  }
  const roots: TreeEntry[] = [];
  // A parent chain that loops back (impossible from the backend, cheap to
  // survive anyway) re-roots the node instead of orphaning the whole cycle.
  const createsCycle = (e: TreeEntry): boolean => {
    const seen = new Set<string>([e.node.id]);
    let pid = e.node.parentId;
    while (pid && keptIds.has(pid)) {
      if (seen.has(pid)) return true;
      seen.add(pid);
      pid = entries.get(pid)?.node.parentId ?? null;
    }
    return false;
  };
  for (const e of entries.values()) {
    const pid = e.node.parentId;
    const parent = pid && keptIds.has(pid) ? entries.get(pid) : undefined;
    if (parent && parent !== e && !createsCycle(e)) parent.children.push(e);
    else roots.push(e);
  }
  const order = (a: TreeEntry, b: TreeEntry) =>
    b.subtreeMass - a.subtreeMass || (a.node.id < b.node.id ? -1 : 1);
  roots.sort(order);
  const countLeaves = (e: TreeEntry): number => {
    e.children.sort(order);
    e.leaves = e.children.length
      ? e.children.reduce((s, c) => s + countLeaves(c), 0)
      : 1;
    return e.leaves;
  };
  let totalLeaves = 0;
  for (const r of roots) totalLeaves += countLeaves(r);

  // --- radial placement ----------------------------------------------------
  const cx = w / 2;
  const cy = h / 2;
  const rim = 0.46 * Math.min(w, h);
  const ringRoot = 0.3 * Math.min(w, h);
  let maxDepth = 0;
  const walkDepth = (e: TreeEntry, d: number) => {
    maxDepth = Math.max(maxDepth, d);
    for (const c of e.children) walkDepth(c, d + 1);
  };
  for (const r of roots) walkDepth(r, 0);
  const ringGap = maxDepth > 0 ? (rim - ringRoot) / maxDepth : 0;

  const maxMass = Math.max(1, ...kept.map((n) => n.mass));
  const placed: PlacedNode[] = [];
  const place = (e: TreeEntry, a0: number, a1: number, depth: number) => {
    const rng = mulberry32(hashId(e.node.id));
    const mid = (a0 + a1) / 2 + (rng() - 0.5) * 0.04;
    const radius = ringRoot + depth * ringGap + (rng() - 0.5) * 4;
    placed.push({
      ...e.node,
      x: cx + radius * Math.cos(mid),
      y: cy + radius * Math.sin(mid),
      r:
        e.node.mass <= 0
          ? R_MIN
          : R_MIN + (R_MAX - R_MIN) * Math.sqrt(e.node.mass / maxMass),
      depth,
    });
    let acc = a0;
    for (const c of e.children) {
      const span = ((a1 - a0) * c.leaves) / Math.max(1, e.leaves);
      place(c, acc, acc + span, depth + 1);
      acc += span;
    }
  };
  let angle = -Math.PI / 2;
  for (const r of roots) {
    const span = (2 * Math.PI * r.leaves) / Math.max(1, totalLeaves);
    place(r, angle, angle + span, 0);
    angle += span;
  }

  // --- bounded force refinement (fixed order, fixed seed) ------------------
  placed.sort((a, b) => (a.id < b.id ? -1 : 1));
  const anchors = placed.map((p) => ({ x: p.x, y: p.y }));
  const margin = R_MAX + 4;
  for (let iter = 0; iter < FORCE_ITERATIONS; iter++) {
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const minDist = a.r + b.r + PAIR_PADDING;
        if (dist >= minDist) continue;
        let ux: number;
        let uy: number;
        if (dist > 1e-6) {
          ux = dx / dist;
          uy = dy / dist;
        } else {
          // Coincident points: a stable, id-seeded separation direction.
          const theta = mulberry32(hashId(a.id + b.id))() * 2 * Math.PI;
          ux = Math.cos(theta);
          uy = Math.sin(theta);
        }
        const push = (minDist - dist) / 2;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
      }
    }
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      p.x += (anchors[i].x - p.x) * ANCHOR_PULL;
      p.y += (anchors[i].y - p.y) * ANCHOR_PULL;
      p.x = Math.min(w - margin, Math.max(margin, p.x));
      p.y = Math.min(h - margin, Math.max(margin, p.y));
    }
  }

  return { nodes: placed, hidden, width: w, height: h };
}

/** Edges the renderer should draw: toggled-on kinds whose endpoints are both
 *  placed (the cap may have dropped one side). */
export function visibleEdges(
  edges: MapEdge[],
  toggles: Record<EdgeKind, boolean>,
  placedIds: ReadonlySet<string>,
): MapEdge[] {
  return edges.filter(
    (e) => toggles[e.kind] && placedIds.has(e.from) && placedIds.has(e.to),
  );
}

/** The node under the cursor, or null. Among overlapping hits the SMALLEST
 *  wins, so a leaf drawn on top of a fat parent stays clickable. */
export function hitTest(
  nodes: PlacedNode[],
  x: number,
  y: number,
  slop = 3,
): PlacedNode | null {
  let best: PlacedNode | null = null;
  for (const n of nodes) {
    if (Math.hypot(x - n.x, y - n.y) > n.r + slop) continue;
    if (!best || n.r < best.r) best = n;
  }
  return best;
}

/** The edge under the cursor (point-to-segment distance ≤ `slop`), or null —
 *  so a hovered line can say what it means (§3 rule 3: no mystery lines).
 *  Checked only when no node is hit; the closest edge wins. */
export function edgeHitTest(
  edges: MapEdge[],
  byId: ReadonlyMap<string, PlacedNode>,
  x: number,
  y: number,
  slop = 5,
): MapEdge | null {
  let best: MapEdge | null = null;
  let bestDist = slop;
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const lenSq = vx * vx + vy * vy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / lenSq)) : 0;
    const dist = Math.hypot(x - (a.x + t * vx), y - (a.y + t * vy));
    if (dist <= bestDist) {
      bestDist = dist;
      best = e;
    }
  }
  return best;
}

/** "Where does my memory live": root classes with their subtree mass rolled
 *  up — the Health treemap's input. Thread nodes never appear (session mass is
 *  conversation length, not memory). Zero-mass roots are dropped; sorted
 *  heaviest first, ties by label then id so the picture is stable. */
export function rootMasses(
  nodes: MapNode[],
): { id: string; label: string; value: number }[] {
  const classes = nodes.filter((n) => n.kind === "class" || n.kind === "digest");
  const subtree = subtreeMasses(classes);
  return classes
    .filter((n) => !n.parentId)
    .map((n) => ({
      id: n.classNodeId ?? n.id,
      label: n.label,
      value: subtree.get(n.id) ?? 0,
    }))
    .filter((t) => t.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1));
}
