// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { usePoll } from "./usePoll";
import { isLiveNode, normalizeGraph, type RunGraph } from "../lib/runner/schema";
import { applyOps, type Applied, type RunOp } from "../lib/runner/ops";
import { appendStream, type NodeStream, type RunStreamEvent } from "../lib/runner/stream";

/** `runner_graph_view`'s reply. `next` is null when the preview can't be read. */
interface RunGraphView { graph: RunGraph; streams: Record<string, NodeStream>; next: string[] | null }
/** One poll tick's read. A failure is a result too, so it reaches the error
 *  line only while the poll that made it is still current. */
type Read<T> = { value: T } | { error: string };
const read = <T,>(call: Promise<T>): Promise<Read<T>> => call.then((value) => ({ value }), (e) => ({ error: String(e) }));

export function useRunGraphList(active: boolean) {
  const [runs, setRuns] = useState<RunGraph[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Every read, the clock's and the events', goes through the poll: one at a
  // time, none while the window is hidden, and a list that didn't change
  // costs the surface no render.
  const refresh = usePoll(
    () => read(invoke<RunGraph[]>("runner_list")),
    active ? 4000 : null,
    {
      pauseWhenHidden: true, skipIfUnchanged: true, leading: false,
      onResult: (result) => {
        if ("error" in result) setError(result.error);
        else { setRuns(result.value.map(normalizeGraph)); setError(null); }
      },
    },
    [active],
  );
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    void Promise.all(["run-graph", "run-finished"].map(async (event) => {
      const un = await listen(event, () => refresh());
      if (disposed) un(); else unlisteners.push(un);
    }))
      .then(() => { if (!disposed) refresh(); })
      .catch((e) => { if (!disposed) { setError(String(e)); refresh(); } });
    return () => { disposed = true; unlisteners.forEach((un) => un()); };
  }, [active, refresh]);
  return { runs, error };
}

export function useRunGraph(runId: string | null, active: boolean) {
  const [graph, setGraph] = useState<RunGraph | null>(null);
  const [streams, setStreams] = useState<Record<string, NodeStream>>({});
  const [nextIds, setNextIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const graphRef = useRef(graph); graphRef.current = graph;
  const currentRun = useRef(runId); currentRun.current = runId;
  // The view the poll reads lands in the effect below, which owns this run's
  // stream bookkeeping.
  const applyRef = useRef<(result: Read<RunGraphView>) => void>(() => {});

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

  // Every read goes through the poll, whoever asks for it: the clock, an
  // event, a seq gap or a command's reload. One at a time (a read asked for
  // mid-read runs once that one lands), none while the window is hidden, and
  // the first once the effect has subscribed. One call: the graph, each live
  // node's stream snapshot and the scheduler's next nodes.
  const refresh = usePoll(
    () => (active && runId ? read(invoke<RunGraphView>("runner_graph_view", { runId })) : null),
    active && runId ? 4000 : null,
    { pauseWhenHidden: true, leading: false, onResult: (result) => { if (result) applyRef.current(result); } },
    [runId, active],
  );

  useEffect(() => {
    setGraph(null); graphRef.current = null; setStreams({}); setNextIds([]); setError(null);
    if (!active || !runId) return;
    let disposed = false, frame = 0;
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
        if (event.kind === "delta" && event.seq > previous.seq + 1) refresh();
        const next = appendStream(previous, event);
        if (next !== previous) { baseline[event.nodeId] = next; changed = true; }
      }
      pending = remaining;
      if (changed) setStreams({ ...baseline });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(flush); };
    applyRef.current = (result) => {
      if (disposed) return;
      if ("error" in result) { setError(result.error); return; }
      try {
        const view = result.value;
        const doc = view.graph;
        const live = doc.nodes.filter((n) => isLiveNode(n.status));
        pending = pending.filter((event) => live.some((node) => node.id === event.nodeId && node.attempt <= event.attempt));
        for (const node of doc.nodes) {
          if (attempts.get(node.id) !== node.attempt || !isLiveNode(node.status)) delete baseline[node.id];
          attempts.set(node.id, node.attempt);
        }
        accept(doc);
        for (const node of live) {
          const next = view.streams[node.id];
          if (next && (!baseline[node.id] || next.seq >= baseline[node.id].seq)) baseline[node.id] = next;
        }
        setStreams({ ...baseline }); schedule(); setError(null);
        // A graph remains readable when the preview is unavailable.
        if (view.next) setNextIds(view.next);
      } catch (e) { setError(String(e)); }
    };
    const onStream = (event: RunStreamEvent) => {
      if (event.runId !== runId) return;
      pending.push(event); schedule();
      if (!baseline[event.nodeId] || event.attempt > baseline[event.nodeId].attempt) refresh();
    };
    // Subscribe before probing: events racing a status reply are deduplicated
    // against the reply's seq, so remounting cannot lose or double output.
    void Promise.all([
      listen<Omit<Extract<RunStreamEvent, { kind: "delta" }>, "kind">>("run-delta", ({ payload }) => onStream({ ...payload, kind: "delta" })),
      listen<Omit<Extract<RunStreamEvent, { kind: "meter" }>, "kind">>("run-meter", ({ payload }) => onStream({ ...payload, kind: "meter" })),
      // The event names a run and its revision; a revision this view already
      // holds (the reply to its own edit) needs no second fetch.
      listen<{ runId: string; rev: number }>("run-graph", ({ payload }) => {
        const held = graphRef.current;
        if (payload.runId === runId && !(held?.runId === runId && held.rev >= payload.rev)) refresh();
      }),
      ...["run-done", "run-error"].map((event) => listen<{ runId: string }>(event, ({ payload }) => { if (payload.runId === runId) refresh(); })),
    ].map(async (subscription) => {
      const un = await subscription;
      if (disposed) un(); else unlisteners.push(un);
    })).then(() => {
      if (!disposed) refresh();
    }).catch((e) => { if (!disposed) { setError(String(e)); refresh(); } });
    return () => { disposed = true; unlisteners.forEach((un) => un()); cancelAnimationFrame(frame); };
  }, [runId, active, accept, refresh]);

  const command = useCallback(async <T,>(name: string, args: Record<string, unknown>, getDoc: (value: T) => RunGraph) => {
    const doc = graphRef.current;
    if (!doc || doc.runId !== currentRun.current) return;
    setBusy(true); setError(null);
    try {
      const value = await invoke<T>(name, { runId: doc.runId, baseRev: doc.rev, ...args });
      accept(getDoc(value)); refresh(); return value;
    } catch (e) {
      const message = String(e);
      setError(message.includes("409") ? "The graph changed. It has been reloaded; review your edit and apply it again." : message);
      if (message.includes("409")) refresh();
      throw e;
    } finally { setBusy(false); }
  }, [accept, refresh]);
  const apply = useCallback(async (ops: RunOp[]) => {
    const doc = graphRef.current;
    if (!doc) return;
    try { applyOps(doc, doc.rev, ops); } catch (e) { setError(String(e)); throw e; }
    return command<Applied>("runner_apply", { ops }, (value) => value.doc);
  }, [command]);
  return { graph, streams, nextIds, error, busy, apply,
    start: () => command<RunGraph>("runner_start", {}, (value) => value),
    intervene: (action: string, nodeId?: string, message?: string) => command<RunGraph>("runner_intervene", { action, nodeId, message }, (value) => value),
    refresh,
  };
}
