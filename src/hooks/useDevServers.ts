// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DevServerScan } from "../types";
import type { StopPlan } from "../lib/devServerTypes";

/** How often the Localhost surface re-sweeps the machine while it is visible.
 *  Each sweep forks three subprocesses, so this is deliberately slower than a
 *  UI-feel poll — a dev server appearing a few seconds late is invisible, a
 *  fork storm is not. */
const POLL_MS = 4000;

export interface UseDevServers {
  scan: DevServerScan | null;
  error: string | null;
  refresh: () => void;
  stopServer: (
    pid: number,
    port: number,
    projectPath: string | null,
  ) => Promise<void>;
  planStop: (pid: number, port: number, projectPath: string | null) => Promise<StopPlan | null>;
}

/** Owns the Localhost surface's data: what is listening, what we remember, and
 *  what else holds a port.
 *
 *  Polling is gated on `active && !document.hidden` — three subprocess spawns
 *  every four seconds must not run behind another surface or a hidden window,
 *  which is the same discipline the terminal's `lsof` poll follows.
 *
 *  A failed sweep keeps the last good scan on screen and surfaces the error
 *  beside it. Blanking the grid because one `lsof` call hiccuped would read as
 *  "all my servers died," which is precisely the wrong thing to tell someone. */
export function useDevServers(active: boolean): UseDevServers {
  const [scan, setScan] = useState<DevServerScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  // Guards against a reply from a sweep that started before the surface closed.
  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    // One sweep at a time: a slow `lsof` must not let ticks pile up.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const next = await invoke<DevServerScan>("dev_servers_scan");
      if (!aliveRef.current) return;
      setScan(next);
      setError(null);
    } catch (e) {
      if (!aliveRef.current) return;
      setError(String(e));
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
    let timer = 0;
    const tick = () => {
      if (!document.hidden) void refreshRef.current();
    };
    tick(); // show something the instant the surface opens
    timer = window.setInterval(tick, POLL_MS);
    // A window that comes back to the front should be current immediately
    // rather than up to a full poll stale.
    const onVisible = () => {
      if (!document.hidden) void refreshRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active]);

  /** Errors from Stop survive the follow-up sweep instead of disappearing
   *  behind a successful scan before the user can read them. */
  const stopServer = useCallback(
    async (pid: number, port: number, projectPath: string | null) => {
      setStopError(null);
      let failure: string | null = null;
      try {
        await invoke("dev_server_stop", { pid, port, projectPath });
      } catch (e) {
        failure = String(e);
      }
      await refreshRef.current();
      if (aliveRef.current) setStopError(failure);
    },
    [],
  );

  const planStop = useCallback(
    async (pid: number, port: number, projectPath: string | null) => {
      try {
        return await invoke<StopPlan>("dev_server_stop_plan", { pid, port, projectPath });
      } catch {
        // Advisory only: the actual stop recomputes and validates its plan.
        return null;
      } finally {
        void refreshRef.current();
      }
    },
    [],
  );

  return { scan, error: stopError ?? error, refresh: () => { setStopError(null); void refreshRef.current(); }, stopServer, planStop };
}
