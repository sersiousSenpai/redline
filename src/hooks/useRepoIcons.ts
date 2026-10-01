// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Repo marks for the terminal tabs, resolved once per directory and then never
// again for the life of the session.
//
// The caching is the whole point. `TerminalTabs` rebuilds its bar entries on
// every render — and the cwd poll ticks every 2.5s — so a naive lookup would be
// an `invoke` per tab per render, for an answer that cannot change: a repo does
// not grow a logo while you're looking at it. The cache lives at module scope
// rather than in the hook so it also survives the component remounting (a dock
// collapse, a fullscreen toggle), and an in-flight set keeps two panes asking
// about the same directory from firing two calls.

import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { RepoIconResult } from "../lib/repoIcon";

let cache = new Map<string, RepoIconResult>();
const inFlight = new Set<string>();
const subscribers = new Set<() => void>();
const subscribe = (notify: () => void) => {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
};
const getSnapshot = () => cache;

/** Resolve each directory's repo mark, keyed by the directory asked about.
 *
 *  Nulls are skipped — a terminal sitting in `$HOME` has no repo, and its tab
 *  falls back to a monogram off its label. Returns a snapshot whose identity
 *  changes only when something new lands, so a caller can put it straight into
 *  a `useMemo` dependency list without re-deriving on every render. */
export function useRepoIcons(
  cwds: readonly (string | null)[],
): Map<string, RepoIconResult> {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  // The effect must key on the set of directories, not the array identity —
  // the caller rebuilds that array every render.
  const key = Array.from(new Set(cwds.filter((c): c is string => !!c)))
    .sort()
    .join("\n");

  useEffect(() => {
    const wanted = key ? key.split("\n") : [];
    for (const cwd of wanted) {
      if (cache.has(cwd) || inFlight.has(cwd)) continue;
      inFlight.add(cwd);
      void invoke<RepoIconResult>("repo_icon", { cwd })
        .then((res) => {
          cache = new Map(cache).set(cwd, res);
        })
        .catch(() => {
          // A failed lookup is not worth retrying every poll — the tab keeps
          // its monogram, which is a perfectly good mark.
          cache = new Map(cache).set(cwd, { root: cwd, name: "", dataUrl: null });
        })
        .finally(() => {
          inFlight.delete(cwd);
          // The terminal and Localhost can request the same repo concurrently.
          // Notify every mounted consumer, including those sharing this flight.
          subscribers.forEach((notify) => notify());
        });
    }
  }, [key]);

  return snapshot;
}
