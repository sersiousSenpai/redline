// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// The thin canvas adapter consumes these pure, deterministic derivations.
import { isLiveNode, type RunGraph, type RunNode } from "./schema";
import type { TurnMeter } from "../turnMeter";
import type { RunOp } from "./ops";

export function measuredSummary(doc: RunGraph, liveMeters: Record<string, TurnMeter | null> = {}) {
  const meters = doc.nodes.flatMap((node) => {
    const completed = node.attemptMeters.length ? node.attemptMeters : !isLiveNode(node.status) && node.meter ? [node.meter] : [];
    return isLiveNode(node.status) && liveMeters[node.id] ? [...completed, liveMeters[node.id]!] : completed;
  });
  return {
    passed: doc.nodes.filter((n) => n.status === "passed").length,
    failed: doc.nodes.filter((n) => n.status === "failed" || n.status === "awaiting_human").length,
    checks: doc.nodes.filter((n) => n.kind === "check" && n.exitCode === 0 && n.status === "passed").length,
    totalChecks: doc.nodes.filter((n) => n.kind === "check").length,
    outputTokens: meters.reduce((sum, meter) => sum + meter.outputTokens, 0),
    costUsd: meters.reduce((sum, meter) => sum + (meter.costUsd ?? 0), 0),
    hasCost: meters.some((meter) => meter.costUsd != null),
  };
}
/** Semantic diff adapted from app-map: positions and meters are not brief edits. */
export function changedNodeIds(before: RunGraph, after: RunGraph): Set<string> {
  const keys: (keyof RunNode)[] = ["title", "brief", "kind", "model", "effort", "seat", "scopeHint", "verifyCmd", "checkGlobal", "enforceScope"];
  return new Set(after.nodes.filter((node) => {
    const old = before.nodes.find((n) => n.id === node.id);
    return !old || keys.some((key) => JSON.stringify(node[key]) !== JSON.stringify(old[key]));
  }).map((node) => node.id));
}
export function mergeNodeOps(doc: RunGraph, sourceId: string, targetId: string): RunOp[] {
  const source = doc.nodes.find((n) => n.id === sourceId), target = doc.nodes.find((n) => n.id === targetId);
  if (!source || !target || sourceId === targetId) throw new Error("Choose two different nodes");
  if (source.kind !== target.kind) throw new Error("Merge nodes of the same kind");
  if (source.attempt || target.attempt) throw new Error("Only unstarted nodes can be merged");
  const ops: RunOp[] = [{ op: "update_node", id: targetId, set: {
    brief: [target.brief, source.brief].filter(Boolean).join("\n\n"),
    scopeHint: [...new Set([...target.scopeHint, ...source.scopeHint])],
    ...(target.kind === "check" ? { verifyCmd: `(\n${target.verifyCmd}\n) && (\n${source.verifyCmd}\n)`, checkGlobal: target.checkGlobal || source.checkGlobal } : {}),
  } }, { op: "remove_node", id: sourceId }];
  const existing = new Set(doc.edges.filter((e) => e.from !== sourceId && e.to !== sourceId).map((e) => `${e.from}|${e.to}|${e.type}`));
  for (const edge of doc.edges.filter((e) => e.from === sourceId || e.to === sourceId)) {
    const from = edge.from === sourceId ? targetId : edge.from, to = edge.to === sourceId ? targetId : edge.to;
    const key = `${from}|${to}|${edge.type}`;
    if (from === to || existing.has(key)) continue;
    existing.add(key); ops.push({ op: "add_edge", edge: { ...edge, from, to } });
  }
  return ops;
}
export function splitNodeOps(doc: RunGraph, id: string, nextId: string): RunOp[] {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node || node.attempt) throw new Error("Only an unstarted node can be split");
  const paragraphs = node.brief.split(/\n\s*\n/), mid = Math.max(1, Math.ceil(paragraphs.length / 2));
  const ops: RunOp[] = [
    { op: "update_node", id, set: { brief: paragraphs.slice(0, mid).join("\n\n") } },
    { op: "add_node", node: { ...node, id: nextId, title: `${node.title} — follow-up`, brief: paragraphs.slice(mid).join("\n\n"), position: null } },
  ];
  for (const edge of doc.edges.filter((e) => e.from === id && e.type === "blocks")) {
    ops.push({ op: "remove_edge", id: edge.id }, { op: "add_edge", edge: { ...edge, from: nextId } });
  }
  ops.push({ op: "add_edge", edge: { id: `e-${nextId}`, from: id, to: nextId, type: "blocks" } });
  return ops;
}
