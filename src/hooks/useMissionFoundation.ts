// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { missionFoundation, type MissionFoundationState } from "../lib/missionFoundation";

export function useMissionFoundation(missionId: string) {
  const [state, setState] = useState<MissionFoundationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = useRef(missionId);
  const generation = useRef(0);
  owner.current = missionId;
  const refresh = useCallback(async () => {
    const ticket = ++generation.current;
    try {
      const next = await missionFoundation<MissionFoundationState>(missionId, { op: "read" });
      if (owner.current === missionId && ticket === generation.current) { setState(next); setError(null); }
    } catch (e) {
      if (owner.current === missionId && ticket === generation.current) setError(String(e));
    }
  }, [missionId]);
  useEffect(() => {
    setState(null); setError(null); void refresh();
    const unlisten = ["mission-done", "mission-error", "mission-cancelled", "mission-synthesize-done", "mission-capture-changed"].map(event =>
      listen<{ missionId: string }>(event, ({ payload }) => { if (payload.missionId === missionId) void refresh(); }));
    return () => { generation.current++; for (const handle of unlisten) void handle.then(fn => fn()); };
  }, [missionId, refresh]);
  const act = useCallback(async <T,>(action: { op: string; [key: string]: unknown }): Promise<T | null> => {
    setBusy(true); setError(null);
    try {
      const result = await missionFoundation<T>(missionId, action);
      if (owner.current === missionId) await refresh();
      return result;
    } catch (e) { if (owner.current === missionId) setError(String(e)); return null; }
    finally { if (owner.current === missionId) setBusy(false); }
  }, [missionId, refresh]);
  return { state, error, busy, refresh, act };
}
