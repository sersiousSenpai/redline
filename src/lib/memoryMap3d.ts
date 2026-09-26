import { NODE_CAP, subtreeMasses, type MapNode, type MemoryMapData } from "./memoryMap";
import type { TimelineFocus } from "./timeline";

export interface Point3 { x: number; y: number; z: number }
export interface CosmosNode extends MapNode, Point3 { r: number; depth: number }
export interface CosmosLayout { nodes: CosmosNode[]; hidden: number; center: Point3; radius: number }
export interface CosmosCamera { position: [number, number, number]; target: [number, number, number] }
export interface CosmosView { camera?: CosmosCamera; selectedId?: string | null; positions?: CosmosNode[] }

export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function seeded(id: string) {
  let a = seedOf(id);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function nodeFocus(node: MapNode): TimelineFocus | null {
  if (node.classNodeId) return { classNodeId: node.classNodeId, label: node.label };
  if (node.sessionId) return { sessionId: node.sessionId, label: node.label };
  if (node.browseId) return { browseId: node.browseId, label: node.label };
  if (node.threadId) return { threadId: node.threadId, label: node.label };
  return null;
}

/** The layout has no viewport or edge-filter inputs. Existing landmarks are
 * immutable on refresh; only newcomers take part in separation. */
export function layoutMap3d(data: MemoryMapData, previous: CosmosNode[] = [], cap = NODE_CAP): CosmosLayout {
  const unique = [...new Map(data.nodes.map(n => [n.id, n])).values()];
  const masses = subtreeMasses(unique);
  const nodes = unique.sort((a, b) => (masses.get(b.id)! - masses.get(a.id)!) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Math.min(NODE_CAP, cap))).sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const prior = new Map(previous.filter(n => [n.x, n.y, n.z].every(Number.isFinite)).map(n => [n.id, n]));
  const placed = new Map<string, CosmosNode>();
  const parentOf = (node: MapNode) => {
    let id = node.parentId;
    const seen = new Set([node.id]);
    while (id && byId.has(id)) {
      if (seen.has(id)) return null;
      seen.add(id); id = byId.get(id)!.parentId;
    }
    return node.parentId ? byId.get(node.parentId) ?? null : null;
  };
  const place = (n: MapNode): CosmosNode => {
    const cached = placed.get(n.id); if (cached) return cached;
    const parent = parentOf(n);
    const anchor = parent ? place(parent) : null;
    const rand = seeded(n.id);
    const theta = rand() * 2 * Math.PI, y = rand() * 2 - 1;
    const radial = Math.sqrt(1 - y * y);
    const depth = anchor ? anchor.depth + 1 : 0;
    const r = Math.min(30, 8 + Math.sqrt(Math.max(0, Number.isFinite(n.mass) ? n.mass : 0)) * 1.8);
    const distance = anchor ? Math.max(65, 165 * Math.pow(0.75, depth - 1)) + rand() * 45 : 240 + rand() * 310;
    const old = prior.get(n.id);
    const p = { ...n, r, depth,
      x: old?.x ?? (anchor?.x ?? 0) + Math.cos(theta) * radial * distance,
      y: old?.y ?? (anchor?.y ?? 0) + y * distance,
      z: old?.z ?? (anchor?.z ?? 0) + Math.sin(theta) * radial * distance };
    placed.set(n.id, p); return p;
  };
  const out = nodes.map(place);
  for (let pass = 0; pass < 48; pass++) {
    let any = false;
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j], frozenA = prior.has(a.id), frozenB = prior.has(b.id);
      if (frozenA && frozenB) continue;
      let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      let d = Math.hypot(dx, dy, dz);
      const min = (a.r + b.r) * 1.25 + 14;
      if (d >= min) continue;
      if (d < 0.001) { dx = 1; dy = 0.7; dz = -0.6; d = Math.hypot(dx, dy, dz); }
      const shift = (min - d) / d;
      const shareA = frozenA ? 0 : frozenB ? 1 : 0.5;
      const shareB = frozenB ? 0 : frozenA ? 1 : 0.5;
      a.x -= dx * shift * shareA; a.y -= dy * shift * shareA; a.z -= dz * shift * shareA;
      b.x += dx * shift * shareB; b.y += dy * shift * shareB; b.z += dz * shift * shareB;
      any = true;
    }
    if (!any) break;
  }
  const center = { x: 0, y: 0, z: 0 };
  for (const n of out) { center.x += n.x / out.length; center.y += n.y / out.length; center.z += n.z / out.length; }
  const radius = Math.max(35, ...out.map(n => Math.hypot(n.x - center.x, n.y - center.y, n.z - center.z) + n.r));
  return { nodes: out, hidden: unique.length - out.length, center, radius };
}

export function isSceneClick(start: { x: number; y: number }, end: { x: number; y: number }, maxTravel = 0) {
  return Math.max(maxTravel, Math.hypot(start.x - end.x, start.y - end.y)) < 5;
}
