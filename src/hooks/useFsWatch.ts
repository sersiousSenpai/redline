// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
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
