// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePersistedState } from "../theme/usePersistedState";
import type {
  LoopCheckpointEvent,
  LoopDeltaEvent,
  LoopDoneEvent,
  LoopErrorEvent,
  LoopHeartbeatEvent,
  LoopRun,
  LoopRunStatusEvent,
  LoopSnapshot,
  LoopSubtaskStatusEvent,
} from "../types";

/** Args for `loop_start` — the caps default backend-side when omitted. */
export interface LoopStartArgs {
  sessionId: string;
  title: string;
  planMd: string;
  repoPath: string;
  baseRef: string;
  maxParallel?: number;
  maxAttempts?: number;
  turnBudget?: number;
}

/** Bucket key for run-level (non-subtask) planner chatter. */
export const RUN_LEVEL = "__run__";

/** A turn's latest heartbeat: how long it has run, and when we heard it (client
 *  clock) so the UI can tell a live pulse from a stale one. */
export interface LoopBeat {
  elapsedMs: number;
  receivedAt: number;
}

/** Owns the Loop Orchestrator surface: the resumable run list, the active run's
 *  live snapshot (run + subtasks + checkpoints), and each subtask's streaming
 *  transcript. Subscribes to the whole `loop-*` event family and keeps the
 *  active run's state live in place, the sibling of `useMission` for the loop
 *  pane. The active run id is persisted client-side so the pane restores on
 *  reload. */
export function useLoop() {
  const [runs, setRuns] = useState<LoopRun[]>([]);
  const [activeRunId, setActiveRunId] = usePersistedState<string | null>(
    "redline.loop.activeRunId",
    null,
  );
  const [snapshot, setSnapshot] = useState<LoopSnapshot | null>(null);
  // subtaskId (or RUN_LEVEL) → concatenated live transcript for that unit.
  const [transcripts, setTranscripts] = useState<Record<string, string>>({});
  // subtaskId (or RUN_LEVEL) → latest heartbeat for that turn.
  const [beats, setBeats] = useState<Record<string, LoopBeat>>({});
  const [error, setError] = useState<string | null>(null);

  // The events carry a runId; the subscription effect keys on `activeRunId`
  // alone, reading the freshest id through a ref so a run switch mid-stream
  // doesn't tear down + re-add listeners and drop deltas.
  const activeRunIdRef = useRef(activeRunId);
  activeRunIdRef.current = activeRunId;

  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await invoke<LoopRun[]>("loop_list"));
    } catch {
      /* ignore — empty list is a fine fallback */
    }
  }, []);

  const loadSnapshot = useCallback(async (runId: string | null) => {
    if (!runId) {
      setSnapshot(null);
      return;
    }
    try {
      setSnapshot(await invoke<LoopSnapshot>("loop_get", { runId }));
    } catch {
      setSnapshot(null);
    }
  }, []);

  // Load the run list once on mount.
  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  // Load (and reset transcripts for) the active run whenever it changes.
  useEffect(() => {
    setTranscripts({});
    setBeats({});
    setError(null);
    void loadSnapshot(activeRunId);
  }, [activeRunId, loadSnapshot]);

  // One durable subscription to the whole loop-* family; every handler filters
  // to the active run and edits its snapshot in place.
  useEffect(() => {
    let alive = true;
    const mine = (runId: string) => runId === activeRunIdRef.current;

    const deltaP = listen<LoopDeltaEvent>("loop-delta", (e) => {
      if (!alive || !mine(e.payload.runId)) return;
      const key = e.payload.subtaskId ?? RUN_LEVEL;
      setTranscripts((t) => ({ ...t, [key]: (t[key] ?? "") + e.payload.text }));
    });

    const beatP = listen<LoopHeartbeatEvent>("loop-heartbeat", (e) => {
      if (!alive || !mine(e.payload.runId)) return;
      const key = e.payload.subtaskId ?? RUN_LEVEL;
      setBeats((b) => ({
        ...b,
        [key]: { elapsedMs: e.payload.elapsedMs, receivedAt: Date.now() },
      }));
    });

    const subP = listen<LoopSubtaskStatusEvent>("loop-subtask-status", (e) => {
      if (!alive || !mine(e.payload.runId)) return;
      const next = e.payload;
      setSnapshot((s) => {
        if (!s) return s;
        const exists = s.subtasks.some((t) => t.subtaskId === next.subtaskId);
        const subtasks = exists
          ? s.subtasks.map((t) => (t.subtaskId === next.subtaskId ? next : t))
          : [...s.subtasks, next];
        return { ...s, subtasks };
      });
    });

    const runP = listen<LoopRunStatusEvent>("loop-run-status", (e) => {
      if (!alive || !mine(e.payload.runId)) return;
      setSnapshot((s) =>
        s ? { ...s, run: { ...s.run, status: e.payload.status } } : s,
      );
      setRuns((rs) =>
        rs.map((r) =>
          r.runId === e.payload.runId ? { ...r, status: e.payload.status } : r,
        ),
      );
    });

    const ckP = listen<LoopCheckpointEvent>("loop-checkpoint", (e) => {
      if (!alive || !mine(e.payload.runId)) return;
      const cp = e.payload;
      setSnapshot((s) => {
        if (!s) return s;
        const exists = s.checkpoints.some(
          (c) => c.checkpointId === cp.checkpointId,
        );
        const checkpoints = exists
          ? s.checkpoints.map((c) =>
              c.checkpointId === cp.checkpointId ? cp : c,
            )
          : [...s.checkpoints, cp];
        return { ...s, checkpoints };
      });
    });

    const doneP = listen<LoopDoneEvent>("loop-done", (e) => {
      if (!alive || !mine(e.payload.runId)) return;
      setSnapshot((s) =>
        s ? { ...s, run: { ...s.run, status: e.payload.status } } : s,
      );
      setRuns((rs) =>
        rs.map((r) =>
          r.runId === e.payload.runId ? { ...r, status: e.payload.status } : r,
        ),
      );
    });

    const errP = listen<LoopErrorEvent>("loop-error", (e) => {
      if (!alive || !mine(e.payload.runId)) return;
      setError(e.payload.error);
    });

    return () => {
      alive = false;
      void deltaP.then((un) => un());
      void beatP.then((un) => un());
      void subP.then((un) => un());
      void runP.then((un) => un());
      void ckP.then((un) => un());
      void doneP.then((un) => un());
      void errP.then((un) => un());
    };
  }, []);

  const startLoop = useCallback(
    async (args: LoopStartArgs): Promise<LoopRun | null> => {
      try {
        const run = await invoke<LoopRun>("loop_start", {
          sessionId: args.sessionId,
          title: args.title,
          planMd: args.planMd,
          repoPath: args.repoPath,
          baseRef: args.baseRef,
          maxParallel: args.maxParallel ?? null,
          maxAttempts: args.maxAttempts ?? null,
          turnBudget: args.turnBudget ?? null,
        });
        await refreshRuns();
        setActiveRunId(run.runId);
        return run;
      } catch (err) {
        // Surface the real backend reason (dirty repo, base ref doesn't
        // resolve, not a git repo, …) to the caller instead of swallowing it.
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw new Error(msg);
      }
    },
    [refreshRuns, setActiveRunId],
  );

  const resumeRun = useCallback(
    (runId: string) => setActiveRunId(runId),
    [setActiveRunId],
  );

  const closeRun = useCallback(
    () => setActiveRunId(null),
    [setActiveRunId],
  );

  const decideCheckpoint = useCallback(
    async (
      checkpointId: string,
      action: string,
      note?: string | null,
      editedInstructions?: string | null,
    ) => {
      try {
        await invoke("loop_checkpoint_decide", {
          checkpointId,
          action,
          note: note ?? null,
          editedInstructions: editedInstructions ?? null,
        });
        // Optimistically drop the resolved gate from the live snapshot so the
        // card clears immediately; the backend emits a fresh status too.
        setSnapshot((s) =>
          s
            ? {
                ...s,
                checkpoints: s.checkpoints.map((c) =>
                  c.checkpointId === checkpointId
                    ? {
                        ...c,
                        status: action === "deny" ? "denied" : "approved",
                        decidedAt: Date.now(),
                      }
                    : c,
                ),
              }
            : s,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const cancelLoop = useCallback(async (runId: string) => {
    try {
      await invoke("loop_cancel", { runId });
    } catch {
      /* ignore */
    }
  }, []);

  // Delete a run outright (kills its turns, prunes worktrees, drops every row).
  // If the deleted run was active, fall back to the newest remaining run.
  const deleteLoop = useCallback(
    async (runId: string) => {
      try {
        await invoke("loop_delete", { runId });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      const remaining = await invoke<LoopRun[]>("loop_list").catch(
        () => [] as LoopRun[],
      );
      setRuns(remaining);
      if (activeRunIdRef.current === runId) {
        setActiveRunId(remaining[0]?.runId ?? null);
      }
    },
    [setActiveRunId],
  );

  const analyzeLoop = useCallback(async (runId: string) => {
    try {
      await invoke("loop_analyze", { runId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const activeRun =
    snapshot?.run ?? runs.find((r) => r.runId === activeRunId) ?? null;

  return {
    runs,
    activeRunId,
    activeRun,
    snapshot,
    /** subtaskId (or "__run__") → live transcript text. */
    transcripts,
    /** subtaskId (or "__run__") → latest heartbeat for that turn. */
    beats,
    error,
    startLoop,
    resumeRun,
    closeRun,
    loadSnapshot,
    decideCheckpoint,
    cancelLoop,
    deleteLoop,
    analyzeLoop,
    refreshRuns,
  };
}

export type UseLoop = ReturnType<typeof useLoop>;
