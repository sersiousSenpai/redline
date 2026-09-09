// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// Pure wire contract shared with runner_graph.rs. No canvas or IPC dependency.
import type { TurnMeter } from "../turnMeter";

export interface XY { x: number; y: number }
export type NodeKind = "task" | "check" | "review" | "gate";
export type NodeStatus = "pending" | "running" | "verifying" | "passed" | "failed" | "awaiting_human" | "skipped";
export type RunStatus = "draft" | "ready" | "running" | "paused" | "done" | "abandoned";
export interface RunNode {
  id: string; kind: NodeKind; title: string; brief: string;
  planBlockId?: string | null; seat?: string | null; backend?: string | null;
  model?: string | null; effort?: string | null;
  scopeHint: string[]; enforceScope: boolean; verifyCmd?: string | null;
  checkGlobal: boolean; status: NodeStatus; attempt: number; maxAttempts: number;
  childSessionId?: string | null; startedAt?: number | null; endedAt?: number | null;
  meter?: TurnMeter | null; output: string; exitCode?: number | null;
  attemptMeters: TurnMeter[];
  queuedMessages: string[]; position?: XY | null;
}
export interface RunEdge { id: string; from: string; to: string; type: "blocks" | "parent-child" }
export interface RunGraph {
  runId: string; planSessionId?: string | null; projectPath: string; status: RunStatus;
  rev: number; maxWriteParallel: number; nodes: RunNode[]; edges: RunEdge[];
  createdAt: number; updatedAt: number;
  pauseReason?: string | null;
}
export interface RunClaim { path: string; nodeId: string; claimedAt: number; releasedAt?: number | null }
export const isLiveNode = (status: string) => status === "running" || status === "verifying";
export const isSatisfied = (status: string) => status === "passed" || status === "skipped";
export const editableGraph = (doc: RunGraph) => ["draft", "ready", "paused"].includes(doc.status) && !doc.nodes.some((n) => isLiveNode(n.status));
export function newNode(id: string, kind: NodeKind = "task"): RunNode {
  return { id, kind, title: kind === "check" ? "Verify changes" : kind === "gate" ? "Review before continuing" : "New task",
    brief: "", scopeHint: [], enforceScope: false, checkGlobal: true, status: "pending", attempt: 0,
    maxAttempts: 2, output: "", queuedMessages: [], attemptMeters: [], ...(kind === "check" ? { verifyCmd: "npm test" } : {}) };
}
export function normalizeGraph(doc: RunGraph): RunGraph {
  return { ...doc, nodes: doc.nodes.map((node) => ({ ...newNode(node.id, node.kind), ...node })) };
}
const idOk = (id: string) => /^[a-zA-Z0-9_.-]{1,120}$/.test(id);
export function validateGraph(doc: RunGraph): string | null {
  if (!idOk(doc.runId) || !doc.projectPath.trim()) return "Run id and project path are required";
  if (!["draft", "ready", "running", "paused", "done", "abandoned"].includes(doc.status)) return "Unknown run status";
  if (!Number.isInteger(doc.maxWriteParallel) || doc.maxWriteParallel < 1 || doc.maxWriteParallel > 16) return "Parallelism must be 1–16";
  if (doc.nodes.length > 128 || doc.edges.length > 512) return "Run exceeds graph size limit";
  const ids = new Set<string>();
  for (const n of doc.nodes) {
    if (!idOk(n.id) || ids.has(n.id)) return `Invalid or duplicate node ${n.id}`;
    ids.add(n.id);
    if (!["task", "check", "review", "gate"].includes(n.kind)) return "Unknown node kind";
    if (!n.title.trim() || new TextEncoder().encode(n.brief).length > 65536) return `Invalid title or brief for ${n.id}`;
    if (!["pending", "running", "verifying", "passed", "failed", "awaiting_human", "skipped"].includes(n.status)) return "Unknown node status";
    if (!Number.isInteger(n.maxAttempts) || n.maxAttempts < 1 || n.maxAttempts > 10) return "Attempts must be 1–10";
    if (n.kind === "check" && !n.verifyCmd?.trim()) return `Check ${n.id} needs a command`;
    if (n.enforceScope && !n.scopeHint.length) return "Cannot enforce an empty scope";
    if (n.scopeHint.length > 64 || n.scopeHint.some((s) => new TextEncoder().encode(s).length > 1024)) return "Scope hints exceed the size limit";
    if (n.scopeHint.some((s) => s.startsWith("/") || s.split("/").includes(".."))) return "Scope hints must be repository relative";
    if (n.kind === "task" && n.backend && n.backend !== "claude") return "Only the Claude task backend is available";
    if (n.position && (!Number.isFinite(n.position.x) || !Number.isFinite(n.position.y))) return "Invalid position";
  }
  const edgeIds = new Set<string>(), endpoints = new Set<string>();
  const degrees = new Map(doc.nodes.map((n) => [n.id, 0]));
  for (const e of doc.edges) {
    if (!idOk(e.id) || edgeIds.has(e.id)) return "Invalid or duplicate edge id";
    edgeIds.add(e.id);
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) return "Invalid edge endpoints";
    if (!["blocks", "parent-child"].includes(e.type)) return "Unknown edge type";
    const key = `${e.from}|${e.to}|${e.type}`;
    if (endpoints.has(key)) return "Duplicate edge endpoints";
    endpoints.add(key);
    degrees.set(e.to, degrees.get(e.to)! + 1);
  }
  const ready = [...degrees].filter(([, count]) => count === 0).map(([id]) => id);
  let seen = 0;
  while (ready.length) {
    const id = ready.pop()!; seen++;
    for (const edge of doc.edges.filter((e) => e.from === id)) {
      const count = degrees.get(edge.to)! - 1; degrees.set(edge.to, count);
      if (!count) ready.push(edge.to);
    }
  }
  return seen === doc.nodes.length ? null : "Run graph contains a cycle";
}
