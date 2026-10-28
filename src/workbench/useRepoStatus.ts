// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The working-tree status the Files and Changes tabs read (W4): one
// `git_gui_status` read, refreshed by git's own moves (the .git watch), a
// window focus, and a 15 s backstop while the window is visible. Only the
// shown rail tab mounts it, so a tab off screen reads nothing.

import { useEffect, useMemo, useState } from "react";

import { gitApi } from "../components/git/api";
import { useGitWatch } from "../hooks/useFsWatch";
import { usePoll } from "../hooks/usePoll";
import type { FileCode, GitWorkingStatus } from "../lib/git/types";

export const REPO_STATUS_POLL_MS = 15_000;

export function useRepoStatus(repo: string | null): { status: GitWorkingStatus | null; error: string | null; refresh: () => void } {
  const api = useMemo(() => (repo ? gitApi(repo) : null), [repo]);
  const [status, setStatus] = useState<GitWorkingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setStatus(null);
    setError(null);
  }, [repo]);
  const refresh = usePoll(
    () =>
      api
        ? api.status().then(
            (s) => {
              setError(null);
              return s;
            },
            (e: unknown) => {
              setError(String(e));
              return null;
            },
          )
        : null,
    api ? REPO_STATUS_POLL_MS : null,
    { pauseWhenHidden: true, skipIfUnchanged: true, onResult: setStatus },
    [api],
  );
  useGitWatch(repo, refresh);
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  return { status, error, refresh };
}

/** The status as the tree draws it: each changed path made absolute under
 *  `root` (git reports them from the repository root, which the rail's root
 *  is), and every folder between a change and the root. */
export function treeGitStatus(root: string, status: GitWorkingStatus | null): { files: Map<string, FileCode>; dirs: Set<string> } {
  const files = new Map<string, FileCode>();
  const dirs = new Set<string>();
  if (!status) return { files, dirs };
  const base = root.replace(/\/+$/, "");
  for (const entry of [...status.staged, ...status.unstaged, ...status.conflicted]) {
    const abs = `${base}/${entry.path.replace(/\/+$/, "")}`;
    // Conflicts outrank, then whichever area named it first.
    if (!files.has(abs) || entry.status === "U") files.set(abs, entry.status);
    let dir = abs.slice(0, abs.lastIndexOf("/"));
    while (dir.length > base.length && !dirs.has(dir)) {
      dirs.add(dir);
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }
  return { files, dirs };
}
