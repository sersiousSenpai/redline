// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isLiveNode, normalizeGraph, type RunGraph } from "../lib/runner/schema";
import { applyOps, type Applied, type RunOp } from "../lib/runner/ops";
import { appendStream, type NodeStream, type RunStreamEvent } from "../lib/runner/stream";

export function useRunGraphList(active: boolean) {
  const [runs, setRuns] = useState<RunGraph[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let disposed = false, loading = false;
    const unlisteners: UnlistenFn[] = [];
    const refresh = async () => {
      if (loading || disposed) return;
      loading = true;
      try {
        const rows = await invoke<RunGraph[]>("runner_list");
        if (!disposed) { setRuns(rows.map(normalizeGraph)); setError(null); }
      } catch (e) { if (!disposed) setError(String(e)); }
      finally { loading = false; }
    };
    void Promise.all(["run-graph", "run-finished"].map(async (event) => {
      const un = await listen(event, () => void refresh());
      if (disposed) un(); else unlisteners.push(un);
    }))
      .then(() => { if (!disposed) void refresh(); })
      .catch((e) => { if (!disposed) { setError(String(e)); void refresh(); } });
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => { disposed = true; unlisteners.forEach((un) => un()); clearInterval(timer); };
  }, [active]);
  return { runs, error };
}

export function useRunGraph(runId: string | null, active: boolean) {
  const [graph, setGraph] = useState<RunGraph | null>(null);
  const [streams, setStreams] = useState<Record<string, NodeStream>>({});
  const [nextIds, setNextIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const graphRef = useRef(graph); graphRef.current = graph;
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const currentRun = useRef(runId); currentRun.current = runId;

  const accept = useCallback((raw: RunGraph) => {
    if (raw.runId !== currentRun.current) return;
    setGraph((previous) => {
      if (previous?.runId === raw.runId && previous.rev > raw.rev) return previous;
      const next = normalizeGraph(raw);
      // Preserve untouched node objects for memoized canvas cards.
      next.nodes = next.nodes.map((node) => {
        const old = previous?.nodes.find((n) => n.id === node.id);
        return old && JSON.stringify(old) === JSON.stringify(node) ? old : node;
      });
      graphRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    setGraph(null); graphRef.current = null; setStreams({}); setNextIds([]); setError(null);
    if (!active || !runId) return;
    let disposed = false, loading = false, again = false, frame = 0;
    let pending: RunStreamEvent[] = [];
    let baseline: Record<string, NodeStream> = {};
    const attempts = new Map<string, number>();
    const unlisteners: UnlistenFn[] = [];
    const flush = () => {
      frame = 0;
      if (disposed) return;
      const remaining: RunStreamEvent[] = [];
      let changed = false;
      for (const event of pending) {
        const previous = baseline[event.nodeId];
        if (!previous || event.attempt > previous.attempt) { remaining.push(event); continue; }
        if (event.attempt < previous.attempt) continue;
        if (event.kind === "delta" && event.seq > previous.seq + 1) void refresh();
        const next = appendStream(previous, event);
        if (next !== previous) { baseline[event.nodeId] = next; changed = true; }
      }
      pending = remaining;
      if (changed) setStreams({ ...baseline });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(flush); };
    const refresh = async () => {
      if (disposed) return;
      if (loading) { again = true; return; }
      loading = true;
      try {
        const doc = await invoke<RunGraph>("runner_get", { runId });
        if (disposed) return;
        const live = doc.nodes.filter((n) => isLiveNode(n.status));
        pending = pending.filter((event) => live.some((node) => node.id === event.nodeId && node.attempt <= event.attempt));
        for (const node of doc.nodes) {
          if (attempts.get(node.id) !== node.attempt || !isLiveNode(node.status)) delete baseline[node.id];
          attempts.set(node.id, node.attempt);
        }
        accept(doc);
        const snapshots = await Promise.all(live.map(async (node) => {
          try { return [node.id, await invoke<NodeStream>("runner_node_status", { runId, nodeId: node.id })] as const; }
          catch { return null; }
        }));
        if (disposed) return;
        for (const snapshot of snapshots) if (snapshot) {
          const [id, next] = snapshot;
          if (!baseline[id] || next.seq >= baseline[id].seq) baseline[id] = next;
        }
        setStreams({ ...baseline }); schedule(); setError(null);
        try {
          const preview = await invoke<string[]>("runner_preview", { runId });
          if (!disposed) setNextIds(preview);
        } catch { /* a graph remains readable when preview is unavailable */ }
      } catch (e) { if (!disposed) setError(String(e)); }
      finally { loading = false; if (again && !disposed) { again = false; void refresh(); } }
    };
    refreshRef.current = refresh;
    const onStream = (event: RunStreamEvent) => {
      if (event.runId !== runId) return;
      pending.push(event); schedule();
      if (!baseline[event.nodeId] || event.attempt > baseline[event.nodeId].attempt) void refresh();
    };
    // Subscribe before probing: events racing a status reply are deduplicated
    // against the reply's seq, so remounting cannot lose or double output.
    void Promise.all([
      listen<Omit<Extract<RunStreamEvent, { kind: "delta" }>, "kind">>("run-delta", ({ payload }) => onStream({ ...payload, kind: "delta" })),
      listen<Omit<Extract<RunStreamEvent, { kind: "meter" }>, "kind">>("run-meter", ({ payload }) => onStream({ ...payload, kind: "meter" })),
      listen<RunGraph>("run-graph", ({ payload }) => { if (payload.runId === runId) void refresh(); }),
      ...["run-done", "run-error"].map((event) => listen<{ runId: string }>(event, ({ payload }) => { if (payload.runId === runId) void refresh(); })),
    ].map(async (subscription) => {
      const un = await subscription;
      if (disposed) un(); else unlisteners.push(un);
    })).then(() => {
      if (!disposed) void refresh();
    }).catch((e) => { if (!disposed) { setError(String(e)); void refresh(); } });
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => { disposed = true; unlisteners.forEach((un) => un()); clearInterval(timer); cancelAnimationFrame(frame); };
  }, [runId, active, accept]);

  const command = useCallback(async <T,>(name: string, args: Record<string, unknown>, getDoc: (value: T) => RunGraph) => {
    const doc = graphRef.current;
    if (!doc || doc.runId !== currentRun.current) return;
    setBusy(true); setError(null);
    try {
      const value = await invoke<T>(name, { runId: doc.runId, baseRev: doc.rev, ...args });
      accept(getDoc(value)); void refreshRef.current(); return value;
    } catch (e) {
      const message = String(e);
      setError(message.includes("409") ? "The graph changed. It has been reloaded; review your edit and apply it again." : message);
      if (message.includes("409")) void refreshRef.current();
      throw e;
    } finally { setBusy(false); }
  }, [accept]);
  const apply = useCallback(async (ops: RunOp[]) => {
    const doc = graphRef.current;
    if (!doc) return;
    try { applyOps(doc, doc.rev, ops); } catch (e) { setError(String(e)); throw e; }
    return command<Applied>("runner_apply", { ops }, (value) => value.doc);
  }, [command]);
  return { graph, streams, nextIds, error, busy, apply,
    start: () => command<RunGraph>("runner_start", {}, (value) => value),
    intervene: (action: string, nodeId?: string, message?: string) => command<RunGraph>("runner_intervene", { action, nodeId, message }, (value) => value),
    refresh: () => void refreshRef.current(),
  };
}
