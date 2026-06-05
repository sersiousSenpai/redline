// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { FolderTab } from "../types";
import { usePersistedState } from "../theme/usePersistedState";

/** The active sidebar tab: the sessions list, or one opened folder by id. */
export type SidebarTab = { kind: "sessions" } | { kind: "folder"; id: string };

const SESSIONS_TAB: SidebarTab = { kind: "sessions" };

/** Basename of an absolute path, for folder-tab labels. Trailing slashes are
 *  trimmed so `/a/b/` and `/a/b` both label as `b`; the filesystem root falls
 *  back to the raw path. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return name || path;
}

/** Owns the file-explorer's cross-cutting state: which project folders are
 *  open (each a sidebar tab), which tab is active, the file shown in the
 *  viewer, and whether terminal focus drives folder focus (linked nav). Folder
 *  paths persist across restarts; a since-deleted folder is dropped on first
 *  use. The terminal→cwd map and auto-open/link wiring live in App. */
export function useFolderWorkspaces() {
  // Persist only the durable identity (paths); rebuild FolderTab ids/names so
  // a hand-edited or stale store can't carry a malformed object forward.
  const [folderPaths, setFolderPaths] = usePersistedState<string[]>(
    "redline.folders.open",
    [],
  );
  const [activePath, setActivePath] = usePersistedState<string | null>(
    "redline.folders.activePath",
    null,
  );
  const [linkNav, setLinkNav] = usePersistedState<boolean>(
    "redline.folders.linkNav",
    true,
  );
  const [activeFile, setActiveFile] = useState<string | null>(null);

  const openFolders: FolderTab[] = useMemo(
    () =>
      folderPaths.map((path) => ({ id: path, path, name: basename(path) })),
    [folderPaths],
  );

  // Identity is the path, so the tab id is just the path — no random ids to
  // reconcile against the persisted list.
  const sidebarTab: SidebarTab = useMemo(() => {
    if (activePath && folderPaths.includes(activePath)) {
      return { kind: "folder", id: activePath };
    }
    return SESSIONS_TAB;
  }, [activePath, folderPaths]);

  const openFolder = useCallback(
    (path: string) => {
      setFolderPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
    },
    [setFolderPaths],
  );

  const closeFolder = useCallback(
    (id: string) => {
      setFolderPaths((prev) => prev.filter((p) => p !== id));
      setActivePath((prev) => (prev === id ? null : prev));
      setActiveFile((f) => (f && f.startsWith(id) ? null : f));
    },
    [setFolderPaths, setActivePath],
  );

  const selectSessions = useCallback(() => setActivePath(null), [setActivePath]);
  const selectFolder = useCallback(
    (id: string) => setActivePath(id),
    [setActivePath],
  );

  const openFile = useCallback((path: string) => setActiveFile(path), []);

  // On mount, drop persisted folders whose path no longer lists — a project
  // moved or deleted since last session shouldn't haunt the tab strip.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const checks = await Promise.all(
        folderPaths.map(async (path) => {
          try {
            await invoke("list_dir", { path });
            return path;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const alive = checks.filter((p): p is string => p !== null);
      if (alive.length !== folderPaths.length) setFolderPaths(alive);
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally mount-only: this is a one-time reconciliation, not a
    // live invariant. Subsequent opens are validated as they happen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    openFolders,
    sidebarTab,
    linkNav,
    activeFile,
    openFolder,
    closeFolder,
    selectSessions,
    selectFolder,
    openFile,
    setActiveFile,
    setLinkNav,
  };
}
