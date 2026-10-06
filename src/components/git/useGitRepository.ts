// SPDX-License-Identifier: Apache-2.0
// Repository state for the git client: working status + refs, refreshed after
// every op, on the backend's `git-gui-changed` event, on window focus, and on a
// 4 s poll while the page is visible. A refresh never overlaps itself: a request
// that arrives mid-flight queues exactly one follow-up.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { GitOpResult, GitRefs, GitWorkingStatus } from "../../lib/git/types";
import { gitApi } from "./api";

export const POLL_MS = 4000;

export interface GitOpRecord {
  label: string;
  ok: boolean;
  output: string;
  conflicts: string[];
  at: number;
}

export function useGitRepository(repo: string) {
  const api = useMemo(() => gitApi(repo), [repo]);
  const [status, setStatus] = useState<GitWorkingStatus | null>(null);
  const [refs, setRefs] = useState<GitRefs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastOp, setLastOp] = useState<GitOpRecord | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** A transient note worth surfacing outside the drawer (a recovery copy). */
  const [notice, setNotice] = useState<{ text: string; at: number } | null>(null);
  /** Bumped by every op and change event: views re-read what they show. */
  const [version, setVersion] = useState(0);

  const inflight = useRef<Promise<void> | null>(null);
  const queued = useRef(false);
  const live = useRef(true);
  const repoRef = useRef(repo);
  repoRef.current = repo;

  const refresh = useCallback((): Promise<void> => {
    if (inflight.current) {
      queued.current = true;
      return inflight.current;
    }
    const forRepo = repo;
    const run = (async () => {
      try {
        const [nextStatus, nextRefs] = await Promise.all([api.status(), api.refs()]);
        if (!live.current || repoRef.current !== forRepo) return;
        setStatus(nextStatus);
        setRefs(nextRefs);
        setLoadError(null);
      } catch (error) {
        if (live.current && repoRef.current === forRepo) setLoadError(String(error));
      }
    })();
    inflight.current = run.finally(() => {
      inflight.current = null;
      if (queued.current && live.current) {
        queued.current = false;
        void refreshRef.current();
      }
    });
    return inflight.current;
  }, [api, repo]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Repo switch: drop the old repo's state and load the new one.
  useEffect(() => {
    live.current = true;
    setStatus(null);
    setRefs(null);
    setLoadError(null);
    setLastOp(null);
    setNotice(null);
    void refresh();
    return () => {
      live.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    const unlisten = listen<{ repo?: string }>("git-gui-changed", (event) => {
      if (event.payload?.repo && event.payload.repo !== repoRef.current) return;
      void refresh();
      setVersion((v) => v + 1);
    });
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || inflight.current) return;
      void refresh();
    }, POLL_MS);
    return () => {
      void unlisten.then((off) => off()).catch(() => {});
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);

  /** Run one write. Records git's raw output for the drawer (opened on error or
   *  conflicts), then refreshes. Resolves to the result, or null on failure. */
  const run = useCallback(
    async (label: string, action: () => Promise<GitOpResult>): Promise<GitOpResult | null> => {
      setBusy(label);
      try {
        const result = await action();
        const conflicts = result?.conflicts ?? [];
        setLastOp({ label, ok: conflicts.length === 0, output: result?.output ?? "", conflicts, at: Date.now() });
        if (conflicts.length > 0) setDrawerOpen(true);
        const recovery = (result?.output ?? "").split("\n").find((line) => line.startsWith("Recovery copy saved to"));
        if (recovery) setNotice({ text: recovery.trim(), at: Date.now() });
        return result;
      } catch (error) {
        setLastOp({ label, ok: false, output: String(error), conflicts: [], at: Date.now() });
        setDrawerOpen(true);
        return null;
      } finally {
        if (live.current) setBusy(null);
        setVersion((v) => v + 1);
        await refresh();
      }
    },
    [refresh],
  );

  return { api, status, refs, loadError, busy, lastOp, drawerOpen, setDrawerOpen, notice, setNotice, version, refresh, run };
}

export type GitRepository = ReturnType<typeof useGitRepository>;
