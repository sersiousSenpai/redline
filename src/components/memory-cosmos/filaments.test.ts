import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import type { CosmosNode } from "../../lib/memoryMap3d";
import type { MapEdge } from "../../lib/memoryMap";
import { filaments } from "./filaments";

const node = (id: string, x: number, y: number, z: number): CosmosNode => ({
  id, x, y, z, r: 10, depth: 0, kind: "class", label: id, mass: 20, parentId: null,
  pinned: false, projectPath: null, classNodeId: id, sessionId: null, browseId: null, threadId: null,
});
const edge = (from: string, to: string, kind: MapEdge["kind"] = "contains"): MapEdge => ({ from, to, kind, weight: 1, basis: null });

describe("neural fibers", () => {
  it("draws one continuous, forward-moving arc with no curls or decorative branches", () => {
    const a = node("a", -70, 20, 40), b = node("b", 180, -90, 130), relation = edge("a", "b");
    const web = filaments([relation], [a, b]);
    try {
      expect(web.spans.map(s => s.edge)).toEqual([relation]);
      const positions = web.line.geometry.getAttribute("position");
      const origin = new Vector3(a.x, a.y, a.z), end = new Vector3(b.x, b.y, b.z), axis = end.clone().sub(origin).normalize();
      let previous = -Infinity;
      for (let i = 0; i < positions.count; i++) {
        const point = new Vector3().fromBufferAttribute(positions, i);
        const along = point.clone().sub(origin).dot(axis);
        expect(along).toBeGreaterThanOrEqual(previous - 1e-5); previous = along;
        expect(point.distanceTo(origin)).toBeGreaterThan(a.r);
        expect(point.distanceTo(end)).toBeGreaterThan(b.r);
        if (i > 0 && i % 2 === 0) expect(point.distanceTo(new Vector3().fromBufferAttribute(positions, i - 1))).toBe(0);
      }
    } finally { web.dispose(); }
  });

  it("keeps picking spans tied to valid relationships, including directed arrows", () => {
    const nodes = [node("a", 0, 0, 0), node("b", 100, 40, 0), node("c", 250, 0, 20)];
    const relations = [edge("a", "missing"), edge("a", "a"), edge("a", "b"), edge("b", "c", "supersedes")];
    const web = filaments(relations, nodes);
    try {
      expect(web.spans.map(s => s.edge)).toEqual(relations.slice(2));
      expect(web.spans[0].start).toBe(0);
      expect(web.spans[0].end).toBe(web.spans[1].start);
      expect(web.spans[1].end).toBe(web.line.geometry.getAttribute("position").count);
      expect(web.spans[1].end - web.spans[1].start).toBeGreaterThan(web.spans[0].end);
    } finally { web.dispose(); }
  });

  it("isolates a selected neighborhood and restores every connection when cleared", () => {
    const web = filaments([edge("a", "b"), edge("b", "c")], [node("a", 0, 0, 0), node("b", 100, 40, 0), node("c", 250, 0, 20)]);
    try {
      const colors = web.line.geometry.getAttribute("color"), original = Array.from(colors.array);
      web.select("a", null);
      expect(colors.getX(0)).toBeGreaterThan(original[0]);
      expect(colors.getX(web.spans[1].start)).toBeLessThan(original[web.spans[1].start * 3] * .2);
      web.select(null, null); expect(Array.from(colors.array)).toEqual(original);
    } finally { web.dispose(); }
  });
});
