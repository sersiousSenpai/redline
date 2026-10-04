import { BufferGeometry, Color, Float32BufferAttribute, LineBasicMaterial, LineSegments, QuadraticBezierCurve3, Vector3 } from "three";
import type { MapEdge } from "../../lib/memoryMap";
import { PHI, type CosmosNode } from "../../lib/memoryMap3d";
const COLORS = { contains: "#79aaa7", lineage: "#9997c9", supersedes: "#d6b67b", co_occurs: "#689baf" };

/** One restrained arc per recorded relationship. The control point stays on
 * the chord's bisector, so fibers cannot loop back or invent branch endings. */
export function filaments(edges: MapEdge[], nodes: CosmosNode[]) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const xyz: number[] = [], colors: number[] = [], spans: Array<{ start: number; end: number; edge: MapEdge }> = [];
  const point = (v: Vector3, color: Color) => { xyz.push(v.x, v.y, v.z); colors.push(color.r, color.g, color.b); };
  const segment = (a: Vector3, b: Vector3, color: Color) => { point(a, color); point(b, color); };
  const samples = edges.length > 1000 ? 12 : 24;
  for (const edge of edges) {
    const from = byId.get(edge.from), to = byId.get(edge.to); if (!from || !to) continue;
    const a = new Vector3(from.x, from.y, from.z), b = new Vector3(to.x, to.y, to.z);
    const delta = b.clone().sub(a), length = delta.length(); if (!length) continue;
    const start = xyz.length / 3;
    const color = new Color(COLORS[edge.kind]).multiplyScalar(edge.kind === "contains" ? .9 : edge.kind === "co_occurs" ? .32 : .52);
    const dir = delta.clone().normalize();
    const u = new Vector3().crossVectors(dir, Math.abs(dir.z) > .9 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1)).normalize();
    const lo = a.clone().addScaledVector(dir, Math.min(length * .2, from.r * 1.04));
    const hi = b.clone().addScaledVector(dir, -Math.min(length * .2, to.r * 1.04));
    const control = a.clone().lerp(b, .5).addScaledVector(u, Math.min(32, length / (PHI ** 5)));
    const curve = new QuadraticBezierCurve3(lo, control, hi);
    let prev = lo;
    for (let i = 1; i <= samples; i++) { const next = curve.getPoint(i / samples); segment(prev, next, color); prev = next; }
    if (edge.kind === "supersedes") {
      const back = hi.clone().addScaledVector(curve.getTangent(1), -Math.min(9, length * .1));
      segment(hi, back.clone().addScaledVector(u, 3), color); segment(hi, back.clone().addScaledVector(u, -3), color);
    }
    spans.push({ start, end: xyz.length / 3, edge });
  }
  const geometry = new BufferGeometry(); geometry.setAttribute("position", new Float32BufferAttribute(xyz, 3)); geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  const material = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .62, depthWrite: false });
  const line = new LineSegments(geometry, material), base = new Float32Array(colors);
  return { line, spans, select(id: string | null, selected: MapEdge | null) {
    const attribute = geometry.getAttribute("color"), focused = id !== null || selected !== null;
    for (const span of spans) {
      const on = span.edge === selected || span.edge.from === id || span.edge.to === id;
      const emphasis = on ? 2.4 : focused ? .16 : 1;
      for (let i = span.start * 3; i < span.end * 3; i++) (attribute.array as Float32Array)[i] = base[i] * emphasis;
    }
    attribute.needsUpdate = true;
  }, dispose() { geometry.dispose(); material.dispose(); } };
}
