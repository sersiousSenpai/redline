// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Payload of the backend `fs-change` event: a directory whose listing may have
 *  changed (see `src-tauri/src/fswatch.rs`). */
interface FsChange {
  path: string;
}

/** Trim trailing slashes so `/a/b/` and `/a/b` route to the same subscriber —
 *  mirrors the basename trimming in `useFolderWorkspaces`. */
function normalize(path: string): string {
  return path.replace(/\/+$/, "") || path;
}

// A single `listen("fs-change")` shared by every tree node and the file viewer,
// fanned out to per-path subscribers — far cheaper than one Tauri listener per
// mounted directory. The listener is registered lazily on the first subscriber
// and never torn down (one global handler for the app's lifetime).
const subscribers = new Map<string, Set<() => void>>();
let unlisten: UnlistenFn | null = null;
let starting: Promise<void> | null = null;

function ensureListening(): void {
  if (unlisten || starting) return;
  starting = listen<FsChange>("fs-change", (event) => {
    const callbacks = subscribers.get(normalize(event.payload.path));
    if (callbacks) for (const cb of callbacks) cb();
  }).then((fn) => {
    unlisten = fn;
  });
}

/** Call `onChange` whenever the backend reports a change in `path`. Returns an
 *  unsubscribe function; safe to call for the same path from multiple nodes. */
export function subscribeFsChange(path: string, onChange: () => void): () => void {
  ensureListening();
  const key = normalize(path);
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(onChange);
  return () => {
    const current = subscribers.get(key);
    if (!current) return;
    current.delete(onChange);
    if (current.size === 0) subscribers.delete(key);
  };
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "/";
}

/** How long to coalesce a burst of fs-change events before reloading an open
 *  file. A chunked rewrite can fire many events; without this the viewer would
 *  re-read (and re-tokenize) on every one. */
const RELOAD_DEBOUNCE_MS = 150;

/** Watch the directory of `path` for the caller's lifetime and run `reload`
 *  (debounced) whenever `path` changes on disk, so an open file reflects edits
 *  without reopening. The backend refcounts watches, so this is safe even when
 *  the file tree already watches the same directory. */
export function useLiveFile(path: string, reload: () => void): void {
  useEffect(() => {
    const dir = dirname(path);
    void invoke("watch_dir", { path: dir }).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debouncedReload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        reload();
      }, RELOAD_DEBOUNCE_MS);
    };
    const unsubscribe = subscribeFsChange(path, debouncedReload);
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
      void invoke("unwatch_dir", { path: dir }).catch(() => {});
    };
  }, [path, reload]);
}

/** Run `onChange` when git's own state moves under `repo`: a commit, a
 *  checkout, a fetch, a stage. Watches `.git` and `.git/refs/heads`
 *  non-recursively — the index, HEAD, ORIG_HEAD, FETCH_HEAD, packed-refs and
 *  the branch tips all land there, each written by rename, which the watch
 *  reports. Working-tree edits are not git state (the callers re-read on
 *  focus and on a slow backstop), and a worktree's `.git` is a file the watch
 *  can't follow, so neither replaces the backstop. */
export function useGitWatch(repo: string | null, onChange: () => void): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!repo) return;
    const dirs = [`${repo}/.git`, `${repo}/.git/refs/heads`];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChangeRef.current();
      }, RELOAD_DEBOUNCE_MS);
    };
    const unsubscribes = dirs.map((dir) => {
      void invoke("watch_dir", { path: dir }).catch(() => {});
      return subscribeFsChange(dir, fire);
    });
    return () => {
      if (timer) clearTimeout(timer);
      for (const unsubscribe of unsubscribes) unsubscribe();
      for (const dir of dirs) void invoke("unwatch_dir", { path: dir }).catch(() => {});
    };
  }, [repo]);
}
