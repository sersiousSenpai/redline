// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// Adapted from feature/app-map's atomic shadow reducer with immutable ids,
// allowlisted patches and inverse batches. runner_graph.rs is the authority.
import { editableGraph, normalizeGraph, validateGraph, type RunGraph, type RunNode, type RunEdge } from "./schema";

export type NodePatch = Partial<Pick<RunNode, "kind" | "title" | "brief" | "planBlockId" | "seat" | "backend" | "model" | "effort" | "scopeHint" | "enforceScope" | "verifyCmd" | "checkGlobal" | "maxAttempts" | "position">>;
export type RunOp =
  | { op: "add_node"; node: RunNode } | { op: "update_node"; id: string; set: NodePatch } | { op: "remove_node"; id: string }
  | { op: "add_edge"; edge: RunEdge } | { op: "update_edge"; id: string; set: { type?: RunEdge["type"] } } | { op: "remove_edge"; id: string }
  | { op: "move_node"; id: string; beforeId?: string | null }
  | { op: "set_parallelism"; value: number };
export interface Applied { doc: RunGraph; inverses: RunOp[]; warnings: string[] }
const KEYS = ["kind", "title", "brief", "planBlockId", "seat", "backend", "model", "effort", "scopeHint", "enforceScope", "verifyCmd", "checkGlobal", "maxAttempts", "position"];
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function patch<T extends object>(target: T, set: object, allowed: string[]): object {
  const row = target as Record<string, unknown>, inverse: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(set)) {
    if (!allowed.includes(key)) throw new Error(`Immutable or unknown patch key ${key}`);
    inverse[key] = row[key] ?? null;
    if (value === null) {
      if (["kind", "title", "type"].includes(key)) throw new Error(`Required field ${key} cannot be cleared`);
      delete row[key];
    } else row[key] = value;
  }
  return inverse;
}
export function applyOps(doc: RunGraph, baseRev: number, ops: RunOp[]): Applied {
  if (baseRev !== doc.rev) throw new Error(`409: stale revision; current revision is ${doc.rev}`);
  if (!ops.length || ops.length > 256) throw new Error("Empty or oversized op batch");
  if (!editableGraph(doc)) throw new Error("Pause and wait for active nodes before editing the graph");
  let next = clone(doc);
  let inverses: RunOp[] = [];
  for (const op of ops) {
    const undo: RunOp[] = [];
    switch (op.op) {
      case "add_node":
        if (op.node.status !== "pending" || op.node.attempt !== 0 || op.node.childSessionId || op.node.startedAt != null || op.node.endedAt != null || op.node.meter != null || op.node.exitCode != null || (op.node.attemptMeters?.length ?? 0) || op.node.output || op.node.queuedMessages.length) throw new Error("New nodes must be pending with no execution state");
        next.nodes.push(clone(op.node)); undo.push({ op: "remove_node", id: op.node.id }); break;
      case "update_node": {
        const node = next.nodes.find((n) => n.id === op.id);
        if (!node) throw new Error("Unknown node");
        if (node.status === "passed") throw new Error("Retry a completed node before changing its specification");
        undo.push({ op: "update_node", id: op.id, set: patch(node, op.set, KEYS) as NodePatch }); break;
      }
      case "remove_node": {
        const node = next.nodes.find((n) => n.id === op.id);
        if (!node) throw new Error("Unknown node");
        if (node.attempt > 0) throw new Error("Skip an executed node to preserve its measured record");
        undo.push({ op: "add_node", node });
        for (const edge of next.edges.filter((e) => e.from === op.id || e.to === op.id)) undo.push({ op: "add_edge", edge });
        next.nodes = next.nodes.filter((n) => n.id !== op.id);
        next.edges = next.edges.filter((e) => e.from !== op.id && e.to !== op.id); break;
      }
      case "add_edge": next.edges.push(clone(op.edge)); undo.push({ op: "remove_edge", id: op.edge.id }); break;
      case "update_edge": {
        const edge = next.edges.find((e) => e.id === op.id);
        if (!edge) throw new Error("Unknown edge");
        undo.push({ op: "update_edge", id: op.id, set: patch(edge, op.set, ["type"]) }); break;
      }
      case "remove_edge": {
        const edge = next.edges.find((e) => e.id === op.id);
        if (!edge) throw new Error("Unknown edge");
        undo.push({ op: "add_edge", edge }); next.edges = next.edges.filter((e) => e.id !== op.id); break;
      }
      case "set_parallelism": undo.push({ op: "set_parallelism", value: next.maxWriteParallel }); next.maxWriteParallel = op.value; break;
      case "move_node": {
        const index = next.nodes.findIndex((node) => node.id === op.id);
        if (index < 0) throw new Error("Unknown node");
        if (op.beforeId === op.id) throw new Error("Cannot move a node before itself");
        const beforeId = next.nodes[index + 1]?.id ?? null;
        const [node] = next.nodes.splice(index, 1);
        const target = op.beforeId ? next.nodes.findIndex((n) => n.id === op.beforeId) : next.nodes.length;
        if (target < 0) throw new Error("Unknown target node");
        next.nodes.splice(target, 0, node); undo.push({ op: "move_node", id: op.id, beforeId }); break;
      }
    }
    next = normalizeGraph(next);
    const error = validateGraph(next); if (error) throw new Error(error);
    inverses = [...undo, ...inverses];
  }
  next.rev++;
  return { doc: next, inverses, warnings: next.nodes.filter((n) => n.planBlockId && !n.planBlockId.replace(/^rl:/, "").startsWith("blk-")).map((n) => `${n.id} has an unrecognized plan block anchor`) };
}
