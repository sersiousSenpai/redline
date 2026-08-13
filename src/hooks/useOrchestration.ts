// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Data hooks for the Orchestration Monitor, on the house patterns:
// useDevServers' gating/single-flight/keep-last-good for polling, and the
// MemorySurface event-refetch (the backend pings `orchestration-live` with
// {planSessionId, seq}; the payload is a doorbell, the snapshot command is
// the data — ping-then-fetch).

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentTailEvent,
  AgentTailResult,
  OrchestrationRow,
  RunSnapshot,
} from "../types";
import { capTailEvents, isLiveRunState } from "../lib/orchestration";

/** Belt-and-braces poll behind the event stream: cheap (one snapshot clone
 *  over IPC), so the monitor stays honest even if an emit is dropped. */
const SNAPSHOT_POLL_MS = 4000;
/** Drawer tail poll — only while a drawer is open (at most one). */
const TAIL_POLL_MS = 1000;
/** The drawer keeps at most this many chars of events (the useAiReview
 *  60k-tail convention). */
const TAIL_CHAR_BUDGET = 60_000;

/** The runs list: every anchored orchestration, refreshed on the lifecycle
 *  events. Keep-last-good: a failed refresh never blanks the list. */
export function useOrchestrationRuns(active: boolean): {
  runs: OrchestrationRow[];
  refresh: () => void;
} {
  const [runs, setRuns] = useState<OrchestrationRow[]>([]);
  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const rows = await invoke<OrchestrationRow[]>("list_orchestrations");
      if (aliveRef.current) setRuns(rows);
    } catch {
      // keep-last-good
    } finally {
      inFlightRef.current = false;
    }
  }, []);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    void refreshRef.current();
    const subs = [
      listen("run-state-changed", () => void refreshRef.current()),
      listen("orchestration-report", () => void refreshRef.current()),
      listen("orchestration-live", () => void refreshRef.current()),
    ];
    return () => {
      for (const p of subs) void p.then((un) => un());
    };
  }, [active]);

  return { runs, refresh: () => void refreshRef.current() };
}

/** One run's live snapshot. Primary signal: the `orchestration-live` ping
 *  filtered by id → single-flight refetch. Belt: a slow poll gated on the
 *  surface being visible, stopping once the run is terminal with its
 *  manifest in hand (nothing left to change). */
export function useOrchestration(
  planSessionId: string | null,
  active: boolean,
): RunSnapshot | null {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);
  // The id the in-flight fetch belongs to — a late reply for a previous run
  // must not clobber the current one's snapshot.
  const idRef = useRef(planSessionId);
  idRef.current = planSessionId;

  const refetch = useCallback(async () => {
    const id = idRef.current;
    if (!id || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const snap = await invoke<RunSnapshot | null>("orchestration_snapshot", {
        planSessionId: id,
      });
      if (aliveRef.current && idRef.current === id) setSnapshot(snap);
    } catch {
      // keep-last-good
    } finally {
      inFlightRef.current = false;
    }
  }, []);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Reset + first fetch on run change.
  useEffect(() => {
    setSnapshot(null);
    if (planSessionId && active) void refetchRef.current();
  }, [planSessionId, active]);

  // Primary: the doorbell, filtered to this run.
  useEffect(() => {
    if (!planSessionId || !active) return;
    const sub = listen<{ planSessionId: string }>("orchestration-live", (e) => {
      if (e.payload.planSessionId === planSessionId) void refetchRef.current();
    });
    return () => void sub.then((un) => un());
  }, [planSessionId, active]);

  // Belt: gated poll, retired once the run is terminal AND the manifest (or
  // the report) landed — a finished snapshot cannot change under us.
  const terminal =
    snapshot != null &&
    !isLiveRunState(snapshot.runState) &&
    (snapshot.manifest != null || snapshot.mode !== "workflow");
  useEffect(() => {
    if (!planSessionId || !active || terminal) return;
    const tick = () => {
      if (!document.hidden) void refetchRef.current();
    };
    const timer = window.setInterval(tick, SNAPSHOT_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void refetchRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [planSessionId, active, terminal]);

  return snapshot;
}

export interface UseAgentTail {
  events: AgentTailEvent[];
  /** The first fetch started mid-file — older transcript exists above. */
  truncated: boolean;
  error: string | null;
}

/** Cursor-polled tail of one agent's transcript, running only while the
 *  drawer is open. The cursor lives in a ref (a render must not restart the
 *  stream); everything resets when the agent changes. */
export function useAgentTail(
  planSessionId: string | null,
  agentId: string | null,
): UseAgentTail {
  const [events, setEvents] = useState<AgentTailEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!planSessionId || !agentId) return;
    let alive = true;
    cursorRef.current = null;
    setEvents([]);
    setTruncated(false);
    setError(null);
    const tick = async () => {
      if (inFlightRef.current || document.hidden) return;
      inFlightRef.current = true;
      try {
        const res = await invoke<AgentTailResult>("orchestration_agent_tail", {
          planSessionId,
          agentId,
          cursor: cursorRef.current,
        });
        if (!alive) return;
        cursorRef.current = res.nextCursor;
        if (res.truncated) setTruncated(true);
        if (res.events.length > 0) {
          setEvents((prev) =>
            capTailEvents([...prev, ...res.events], TAIL_CHAR_BUDGET),
          );
        }
        setError(null);
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        inFlightRef.current = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), TAIL_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [planSessionId, agentId]);

  return { events, truncated, error };
}
