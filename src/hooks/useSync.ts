import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SyncCheck, ActionResult } from "../components/guided/types";
export function useSync(repo: string | null) {
  const [check, setCheck] = useState<SyncCheck | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const epoch = useRef(0),
    repoRef = useRef(repo);
  repoRef.current = repo;
  const refresh = useCallback(async () => {
    if (!repo) return null;
    const request = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<SyncCheck>("sync_check", { repo });
      if (epoch.current !== request || repoRef.current !== repo) return null;
      setCheck(result);
      return result;
    } catch (e) {
      if (epoch.current === request && repoRef.current === repo)
        setError(String(e));
      return null;
    } finally {
      if (epoch.current === request && repoRef.current === repo) setBusy(false);
    }
  }, [repo]);
  // Exactly one check when the surface opens; no network polling.
  useEffect(() => {
    setCheck(null);
    setError(null);
    setBusy(false);
    void refresh();
    return () => {
      epoch.current++;
    };
  }, [refresh]);
  const bringIn = useCallback(
    () => invoke<ActionResult>("sync_bring_in", { repo }),
    [repo],
  );
  return { check, busy, error, refresh, bringIn };
}
