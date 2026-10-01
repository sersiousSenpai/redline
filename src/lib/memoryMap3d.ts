import { NODE_CAP, subtreeMasses, type MapNode, type MemoryMapData } from "./memoryMap";
import type { TimelineFocus } from "./timeline";

export interface Point3 { x: number; y: number; z: number }
export interface CosmosNode extends MapNode, Point3 { r: number; depth: number }
export interface CosmosLayout { nodes: CosmosNode[]; hidden: number; center: Point3; radius: number }
export interface CosmosCamera { position: [number, number, number]; target: [number, number, number] }
export interface CosmosView { camera?: CosmosCamera; selectedId?: string | null; positions?: CosmosNode[]; layoutVersion?: number }

export const COSMOS_LAYOUT_VERSION = 2;
export const PHI = (1 + Math.sqrt(5)) / 2;
export const GOLDEN_ANGLE = 2 * Math.PI / (PHI * PHI);

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

/** A forest of dendritic neighborhoods in two balanced lobes. Golden-angle
 * phyllotaxis distributes the neighborhoods; shrinking branch lengths and
 * leaf-weighted sectors keep each tree legible. This is a visual analogy,
 * not an anatomical or quantum model. No viewport or edge-filter inputs;
 * existing landmarks stay fixed on refresh. */
export function layoutMap3d(data: MemoryMapData, previous: CosmosNode[] = [], cap = NODE_CAP): CosmosLayout {
  const unique = [...new Map(data.nodes.map(n => [n.id, n])).values()];
  const masses = subtreeMasses(unique);
  const nodes = unique.sort((a, b) => (masses.get(b.id)! - masses.get(a.id)!) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Math.min(NODE_CAP, cap))).sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const prior = new Map(previous.filter(n => [n.x, n.y, n.z].every(Number.isFinite)).map(n => [n.id, n]));
  const parentOf = (node: MapNode) => {
    let id = node.parentId;
    const seen = new Set([node.id]);
    while (id && byId.has(id)) {
      if (seen.has(id)) return null;
      seen.add(id); id = byId.get(id)!.parentId;
    }
    return node.parentId ? byId.get(node.parentId) ?? null : null;
  };
  const children = new Map<string, MapNode[]>(), parents = new Map<string, MapNode | null>();
  for (const n of nodes) {
    const parent = parentOf(n); parents.set(n.id, parent);
    if (parent) { const siblings = children.get(parent.id) ?? []; siblings.push(n); children.set(parent.id, siblings); }
  }
  const leaves = new Map<string, number>();
  const countLeaves = (n: MapNode): number => {
    const count = (children.get(n.id) ?? []).reduce((sum, child) => sum + countLeaves(child), 0) || 1;
    leaves.set(n.id, count); return count;
  };
  const roots = nodes.filter(n => !parents.get(n.id))
    .sort((a, b) => masses.get(b.id)! - masses.get(a.id)! || a.id.localeCompare(b.id));
  roots.forEach(countLeaves);
  const size = (n: MapNode) => Math.min(23, 6 + Math.sqrt(Math.max(0, Number.isFinite(n.mass) ? n.mass : 0)) * 1.25);
  const neighborhoods = roots.map((root, index) => {
    const members: CosmosNode[] = [];
    const grow = (n: MapNode, depth: number, radius: number, lo: number, hi: number) => {
      const angle = (lo + hi) / 2;
      members.push({ ...n, depth, r: size(n), x: Math.cos(angle) * radius, y: Math.sin(angle) * radius,
        z: depth ? Math.sin(angle * PHI + depth * GOLDEN_ANGLE) * radius / (PHI * PHI * PHI) : 0 });
      const kids = children.get(n.id) ?? [];
      let cursor = lo;
      for (const child of kids) {
        const span = (hi - lo) * leaves.get(child.id)! / leaves.get(n.id)!;
        const step = Math.max(62, 118 / Math.pow(PHI, depth / 2));
        // Dense fans need enough arc length for the somas, even at deep levels.
        const nextRadius = Math.max(radius + step, (size(child) * 2 + 22) / Math.max(.05, span));
        grow(child, depth + 1, nextRadius, cursor, cursor + span); cursor += span;
      }
    };
    const phase = index * GOLDEN_ANGLE;
    grow(root, 0, 0, phase, phase + Math.PI * 2);
    const radius = Math.max(35, ...members.map(n => Math.hypot(n.x, n.y, n.z) + n.r));
    return { members, radius, x: 0, y: 0, z: 0, side: index % 2 ? 1 : -1 };
  });
  const lobeRadius = Math.sqrt(neighborhoods.reduce((sum, n) => sum + n.radius * n.radius, 0) / 2);
  for (let i = 0; i < neighborhoods.length; i++) {
    const n = neighborhoods[i], rank = Math.floor(i / 2), count = Math.ceil((neighborhoods.length - i % 2) / 2);
    const angle = rank * GOLDEN_ANGLE + Math.PI / (PHI * PHI);
    const distance = count > 1 ? lobeRadius * Math.sqrt((rank + .5) / count) : 0;
    n.x = neighborhoods.length === 1 ? 0 : n.side * (lobeRadius / PHI + 28 + Math.cos(angle) * distance / PHI);
    n.y = Math.sin(angle) * distance;
    n.z = Math.cos(angle + i * GOLDEN_ANGLE) * distance / (PHI * PHI * PHI);
  }
  // Pack whole neighborhoods before resolving individual somas, preserving
  // both the branching structure and the quiet space between the lobes.
  for (let pass = 0; pass < 80; pass++) {
    let any = false;
    for (let i = 0; i < neighborhoods.length; i++) for (let j = i + 1; j < neighborhoods.length; j++) {
      const a = neighborhoods[i], b = neighborhoods[j];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      const min = a.radius + b.radius + 34;
      if (d >= min) continue;
      const angle = (i + j) * GOLDEN_ANGLE, ux = d > .001 ? dx / d : Math.cos(angle), uy = d > .001 ? dy / d : Math.sin(angle);
      const shift = (min - d) / 2;
      a.x -= ux * shift; a.y -= uy * shift; b.x += ux * shift; b.y += uy * shift; any = true;
    }
    if (!any) break;
  }
  const placed = new Map<string, CosmosNode>();
  for (const neighborhood of neighborhoods) for (const n of neighborhood.members) {
    n.x += neighborhood.x; n.y += neighborhood.y; n.z += neighborhood.z; placed.set(n.id, n);
  }
  // Anchor new branches to their nearest retained ancestor, even if the root
  // ranking changed. Refreshes must not scatter an established neighborhood.
  const offsets = new Map<string, Point3>();
  const restoreOffset = (n: MapNode): Point3 => {
    const cached = offsets.get(n.id); if (cached) return cached;
    const p = placed.get(n.id)!, old = prior.get(n.id), parent = parents.get(n.id);
    const offset = old ? { x: old.x - p.x, y: old.y - p.y, z: old.z - p.z }
      : parent ? restoreOffset(parent) : { x: 0, y: 0, z: 0 };
    offsets.set(n.id, offset); return offset;
  };
  for (const n of nodes) restoreOffset(n);
  const out = nodes.map(n => {
    const p = placed.get(n.id)!, offset = offsets.get(n.id)!, old = prior.get(n.id);
    return { ...p, x: old?.x ?? p.x + offset.x, y: old?.y ?? p.y + offset.y, z: old?.z ?? p.z + offset.z };
  });
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
