// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Repo marks for the terminal tabs, resolved once per directory and remembered
// for the life of the session, within the bound below.
//
// The caching is the whole point. `TerminalTabs` rebuilds its bar entries on
// every render — and the cwd poll ticks every 2.5s — so a naive lookup would be
// an `invoke` per tab per render, for an answer that cannot change: a repo does
// not grow a logo while you're looking at it. The cache lives at module scope
// rather than in the hook so it also survives the component remounting (a dock
// collapse, a fullscreen toggle), and an in-flight set keeps two panes asking
// about the same directory from firing two calls.
//
// It is also bounded (docs/perf-budget.md rule 7). A terminal `cd`s freely, so
// over days of uptime the directories ever asked about have no limit of their
// own, and a repo's logo can be a data URL of hundreds of KB. Every directory
// of one repo therefore shares a single copy of its answer, and past
// `MAX_REPO_DIRS` the earliest-resolved directories are forgotten — never one a
// mounted tab is showing — to be asked again if a tab comes back to them.

import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { RepoIconResult } from "../lib/repoIcon";

/** Directories remembered at once. A screenful of tabs is a few dozen. */
export const MAX_REPO_DIRS = 256;

let cache = new Map<string, RepoIconResult>();
const inFlight = new Set<string>();
/** Directories a mounted consumer is showing, by how many consumers show it. */
const shown = new Map<string, number>();
const subscribers = new Set<() => void>();
const subscribe = (notify: () => void) => {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
};
const getSnapshot = () => cache;

/** Record a directory's answer: the newest entry, sharing an identical answer
 *  already held for another directory of the same repo, evicting the earliest
 *  entries no consumer is showing once past the cap. */
function remember(cwd: string, res: RepoIconResult) {
  for (const known of cache.values()) {
    if (known.root === res.root && known.dataUrl === res.dataUrl) {
      res = known;
      break;
    }
  }
  const next = new Map(cache);
  next.delete(cwd);
  next.set(cwd, res);
  for (const dir of next.keys()) {
    if (next.size <= MAX_REPO_DIRS) break;
    if (!shown.has(dir)) next.delete(dir);
  }
  cache = next;
}

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
    for (const cwd of wanted) shown.set(cwd, (shown.get(cwd) ?? 0) + 1);
    for (const cwd of wanted) {
      if (cache.has(cwd) || inFlight.has(cwd)) continue;
      inFlight.add(cwd);
      void invoke<RepoIconResult>("repo_icon", { cwd })
        .then((res) => remember(cwd, res))
        .catch(() => {
          // A failed lookup is not worth retrying every poll — the tab keeps
          // its monogram, which is a perfectly good mark.
          remember(cwd, { root: cwd, name: "", dataUrl: null });
        })
        .finally(() => {
          inFlight.delete(cwd);
          // The terminal and Localhost can request the same repo concurrently.
          // Notify every mounted consumer, including those sharing this flight.
          subscribers.forEach((notify) => notify());
        });
    }
    return () => {
      for (const cwd of wanted) {
        const n = (shown.get(cwd) ?? 1) - 1;
        if (n > 0) shown.set(cwd, n);
        else shown.delete(cwd);
      }
    };
  }, [key]);

  return snapshot;
}
