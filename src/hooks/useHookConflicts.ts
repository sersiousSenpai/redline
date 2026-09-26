// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Backend } from "../lib/backendChoice";
import { EMPTY_CONFLICT_SCAN, type HookConflictIdentity, type HookConflictScan, type HookRemovalReport } from "../lib/hookConflicts";

/** Cheap file inspection has its own lifecycle; it never invalidates or probes
 * CLI readiness. App's existing focus listener calls refresh as a fallback. */
export function useHookConflicts(backend: Backend | null, projectPath: string | null, ready: boolean) {
  const [scan, setScan] = useState<HookConflictScan>(EMPTY_CONFLICT_SCAN);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const generation = useRef(0);
  const removing = useRef(false);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    if (!ready || removing.current || !mounted.current) return;
    const request = ++generation.current;
    try {
      const result = await invoke<HookConflictScan>("scan_hook_conflicts", { backend, projectPath });
      if (generation.current === request && mounted.current) { setScan(result); setError(null); setChecked(true); }
    } catch (err) {
      if (generation.current === request && mounted.current) { setError(String(err)); setChecked(true); }
    }
  }, [backend, projectPath, ready]);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    removing.current = false;
    setDialogOpen(false); setChecked(false);
    setScan(EMPTY_CONFLICT_SCAN); setPending(false); setError(null); setRestart(false); setWatchError(null);
    if (!ready) return () => { mounted.current = false; generation.current += 1; };
    let disposed = false;
    let watchId: string | null = null;
    let watchGeneration = 0;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rewatch = async () => {
      const started = ++watchGeneration;
      const old = watchId; watchId = null;
      if (old) await invoke("unwatch_hook_conflicts", { watchId: old }).catch(() => {});
      if (disposed) return;
      try {
        const id = await invoke<string>("watch_hook_conflicts", { backend, projectPath });
        if (disposed || started !== watchGeneration) { await invoke("unwatch_hook_conflicts", { watchId: id }).catch(() => {}); return; }
        watchId = id; setWatchError(null);
      } catch (err) { if (!disposed) setWatchError(String(err)); }
    };
    // Schedule after the first visible shell frame; no file or CLI probe gates it.
    const initial = setTimeout(() => { void refresh(); }, 0);
    void listen<{ watchId: string }>("hook-config-changed", ({ payload }) => {
      if (disposed || payload.watchId !== watchId) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh();
        // A previously missing .claude/.codex directory may just have been
        // created or replaced. Release old watches and attach to its new inode.
        void rewatch();
      }, 80);
    }).then((off) => { if (disposed) off(); else { unlisten = off; void rewatch(); } })
      .catch((err) => { if (!disposed) setWatchError(String(err)); });
    return () => {
      disposed = true; mounted.current = false; generation.current += 1; watchGeneration += 1;
      clearTimeout(initial); clearTimeout(timer); unlisten?.();
      if (watchId) void invoke("unwatch_hook_conflicts", { watchId }).catch(() => {});
    };
  }, [backend, projectPath, ready, refresh]);

  // Findings remain visible in the shell. A scan never opens a modal or takes
  // focus away from an active review, terminal, or integration setup.
  const hasIssue = scan.conflicts.length > 0 || scan.errors.length > 0 || !!error;

  const openDialog = useCallback(() => { setDialogOpen(true); void refresh(); }, [refresh]);
  const closeDialog = useCallback(() => {
    if (removing.current) return;
    setDialogOpen(false);
  }, []);

  const remove = useCallback(async (identities: HookConflictIdentity[]) => {
    if (!ready || removing.current || identities.length === 0) return;
    removing.current = true; setPending(true); setError(null);
    const request = ++generation.current; // Discard every pre-removal scan.
    try {
      const report = await invoke<HookRemovalReport>("remove_hook_conflicts", { backend, projectPath, identities });
      if (request !== generation.current || !mounted.current) return;
      setScan(report.scan);
      const failures = report.results.filter((r) => r.error).map((r) => `${r.sourcePath}: ${r.error}`);
      setError(failures.length ? failures.join("\n") : null);
      if (report.results.some((r) => r.changed)) setRestart(true);
    } catch (err) {
      if (request === generation.current && mounted.current) setError(String(err));
    } finally {
      if (request === generation.current && mounted.current) { removing.current = false; setPending(false); }
    }
  }, [backend, projectPath, ready]);

  return { scan, pending, error, restart, watchError, backend, checked, hasIssue, dialogOpen, openDialog, closeDialog, refresh, remove };
}
export type HookConflictHealth = ReturnType<typeof useHookConflicts>;
