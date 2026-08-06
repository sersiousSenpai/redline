// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDGE_TOGGLES,
  edgeHitTest,
  hitTest,
  layoutMap,
  NODE_CAP,
  rootMasses,
  subtreeMasses,
  visibleEdges,
  type MapEdge,
  type MapNode,
  type MemoryMapData,
  type PlacedNode,
} from "./memoryMap";

function node(partial: Partial<MapNode> & { id: string }): MapNode {
  return {
    kind: "class",
    label: partial.id,
    mass: 1,
    parentId: null,
    pinned: false,
    projectPath: null,
    classNodeId: partial.id.startsWith("class:") ? partial.id.slice(6) : null,
    sessionId: null,
    browseId: null,
    threadId: null,
    ...partial,
  };
}

function data(nodes: MapNode[], edges: MapEdge[] = []): MemoryMapData {
  return { generatedTs: 0, nodes, edges };
}

const FIXTURE = data(
  [
    node({ id: "class:a", mass: 10 }),
    node({ id: "class:a1", parentId: "class:a", mass: 4 }),
    node({ id: "class:a2", parentId: "class:a", mass: 0 }),
    node({ id: "class:b", mass: 7 }),
    node({ id: "thread:session:s1", kind: "session", mass: 3, sessionId: "s1" }),
    node({
      id: "thread:browse:t1",
      kind: "thread",
      mass: 2,
      parentId: "thread:session:s1",
      browseId: "t1",
    }),
  ],
  [
    { kind: "contains", from: "class:a", to: "class:a1", weight: 1, basis: null },
    { kind: "contains", from: "class:a", to: "class:a2", weight: 1, basis: null },
    { kind: "lineage", from: "thread:session:s1", to: "thread:browse:t1", weight: 1, basis: null },
    { kind: "co_occurs", from: "class:a", to: "class:b", weight: 2, basis: "2 shared sessions" },
  ],
);

describe("layoutMap", () => {
  it("is deterministic: the same record draws the same picture (§3 rule 2)", () => {
    const one = layoutMap(FIXTURE, 800, 600);
    const two = layoutMap(FIXTURE, 800, 600);
    expect(two).toEqual(one);
  });

  it("places every node inside the viewport with finite coordinates", () => {
    const { nodes } = layoutMap(FIXTURE, 800, 600);
    expect(nodes).toHaveLength(FIXTURE.nodes.length);
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(800);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(600);
    }
  });

  it("separates nodes — no two centers coincide after refinement", () => {
    const { nodes } = layoutMap(FIXTURE, 800, 600);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        expect(d).toBeGreaterThan(1);
      }
    }
  });

  it("scales radius by mass: bigger mass, bigger dot; zero mass stays visible", () => {
    const byId = new Map(layoutMap(FIXTURE, 800, 600).nodes.map((n) => [n.id, n]));
    const a = byId.get("class:a")!;
    const a1 = byId.get("class:a1")!;
    const a2 = byId.get("class:a2")!;
    expect(a.r).toBeGreaterThan(a1.r);
    expect(a1.r).toBeGreaterThan(a2.r);
    expect(a2.r).toBeGreaterThan(0);
  });

  it("caps at NODE_CAP by subtree mass and REPORTS the hidden count (rule 1)", () => {
    const many = data(
      Array.from({ length: NODE_CAP + 50 }, (_, i) =>
        node({ id: `class:n${String(i).padStart(3, "0")}`, mass: i }),
      ),
    );
    const layout = layoutMap(many, 800, 600);
    expect(layout.nodes).toHaveLength(NODE_CAP);
    expect(layout.hidden).toBe(50);
    // The heaviest survive; the 50 lightest are the hidden ones.
    const keptIds = new Set(layout.nodes.map((n) => n.id));
    expect(keptIds.has("class:n199")).toBe(true);
    expect(keptIds.has("class:n000")).toBe(false);
  });

  it("re-roots a kept child whose parent the cap dropped (no orphan crash)", () => {
    // A parent's subtree mass always ≥ its child's, so orphaning takes the id
    // tiebreak: equal subtree masses, child id sorting first.
    const orphaned = data([
      node({ id: "class:a-kept", parentId: "class:z-gone", mass: 9 }),
      node({ id: "class:z-gone", mass: 0 }),
    ]);
    const layout = layoutMap(orphaned, 400, 400, 1);
    expect(layout.nodes.map((n) => n.id)).toEqual(["class:a-kept"]);
    expect(layout.hidden).toBe(1);
  });

  it("handles the empty lake and a single node without NaN", () => {
    expect(layoutMap(data([]), 800, 600)).toEqual({
      nodes: [],
      hidden: 0,
      width: 800,
      height: 600,
    });
    const one = layoutMap(data([node({ id: "class:only" })]), 300, 200);
    expect(one.nodes).toHaveLength(1);
    expect(Number.isFinite(one.nodes[0].x)).toBe(true);
  });
});

describe("visibleEdges", () => {
  const placed = new Set(FIXTURE.nodes.map((n) => n.id));

  it("draws only toggled-on kinds — co-occurs is opt-in by default (rule 3)", () => {
    const vis = visibleEdges(FIXTURE.edges, DEFAULT_EDGE_TOGGLES, placed);
    expect(vis.map((e) => e.kind)).toEqual(["contains", "contains", "lineage"]);
    const withDerived = visibleEdges(
      FIXTURE.edges,
      { ...DEFAULT_EDGE_TOGGLES, co_occurs: true },
      placed,
    );
    expect(withDerived).toHaveLength(4);
  });

  it("drops edges whose endpoint the cap hid", () => {
    const partial = new Set(["class:a", "class:a1"]);
    const vis = visibleEdges(FIXTURE.edges, { ...DEFAULT_EDGE_TOGGLES, co_occurs: true }, partial);
    expect(vis).toHaveLength(1);
    expect(vis[0].to).toBe("class:a1");
  });
});

describe("hitTest", () => {
  const nodes = layoutMap(FIXTURE, 800, 600).nodes;

  it("hits a node at its center and misses far away", () => {
    const target = nodes[0];
    expect(hitTest(nodes, target.x, target.y)?.id).toBe(target.id);
    expect(hitTest(nodes, -50, -50)).toBeNull();
  });

  it("prefers the smallest of overlapping nodes so leaves stay clickable", () => {
    const big = { ...nodes[0], id: "big", x: 100, y: 100, r: 30 };
    const small = { ...nodes[0], id: "small", x: 110, y: 100, r: 8 };
    expect(hitTest([big, small], 110, 100)?.id).toBe("small");
  });
});

describe("edgeHitTest", () => {
  const placed = (id: string, x: number, y: number): PlacedNode => ({
    ...node({ id }),
    x,
    y,
    r: 10,
    depth: 0,
  });
  const byId = new Map<string, PlacedNode>([
    ["class:a", placed("class:a", 100, 100)],
    ["class:b", placed("class:b", 300, 100)],
    ["class:c", placed("class:c", 100, 300)],
  ]);
  const edges: MapEdge[] = [
    { kind: "contains", from: "class:a", to: "class:b", weight: 1, basis: null },
    { kind: "co_occurs", from: "class:a", to: "class:c", weight: 1, basis: "1 shared session" },
  ];

  it("hits along the segment, misses off it, and picks the closest edge", () => {
    expect(edgeHitTest(edges, byId, 200, 103)?.to).toBe("class:b");
    expect(edgeHitTest(edges, byId, 103, 200)?.basis).toBe("1 shared session");
    expect(edgeHitTest(edges, byId, 200, 140)).toBeNull();
  });

  it("ignores edges whose endpoints are not placed", () => {
    const dangling: MapEdge[] = [
      { kind: "lineage", from: "class:a", to: "thread:gone", weight: 1, basis: null },
    ];
    expect(edgeHitTest(dangling, byId, 100, 100)).toBeNull();
  });
});

describe("subtreeMasses / rootMasses", () => {
  it("rolls descendant mass to every ancestor", () => {
    const m = subtreeMasses(FIXTURE.nodes);
    expect(m.get("class:a")).toBe(14); // 10 + 4 + 0
    expect(m.get("class:a1")).toBe(4);
    expect(m.get("thread:session:s1")).toBe(5); // 3 + 2
  });

  it("feeds the treemap roots-only, classes-only, zero-mass dropped, sorted", () => {
    const roots = rootMasses([
      ...FIXTURE.nodes,
      node({ id: "class:empty", mass: 0 }),
    ]);
    expect(roots).toEqual([
      { id: "a", label: "class:a", value: 14 },
      { id: "b", label: "class:b", value: 7 },
    ]);
  });

  it("survives a parent cycle without hanging", () => {
    const cyc = [
      node({ id: "class:x", parentId: "class:y" }),
      node({ id: "class:y", parentId: "class:x" }),
    ];
    const m = subtreeMasses(cyc);
    expect(m.get("class:x")).toBeGreaterThanOrEqual(1);
    const layout = layoutMap(data(cyc), 400, 400);
    expect(layout.nodes).toHaveLength(2);
  });
});
