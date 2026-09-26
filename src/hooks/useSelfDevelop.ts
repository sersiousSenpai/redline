// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Release } from "../lib/selfDevelop";

/** The releases this machine knows about, kept current by events rather than
 *  by polling: preparing a release takes tens of minutes, and a timer running
 *  the whole time to learn nothing is exactly the kind of background cost the
 *  performance budget exists to refuse. */
export function useReleases(active: boolean): {
  releases: Release[];
  refresh: () => void;
  progress: Record<string, { step: string; index: number; total: number; detail: string }>;
} {
  const [releases, setReleases] = useState<Release[]>([]);
  const [progress, setProgress] = useState<
    Record<string, { step: string; index: number; total: number; detail: string }>
  >({});

  const refresh = useCallback(() => {
    void invoke<Release[]>("self_develop_list")
      .then(setReleases)
      .catch(() => setReleases([]));
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
  }, [active, refresh]);

  useEffect(() => {
    const unlisten = [
      listen("self-develop-changed", () => refresh()),
      listen<{ releaseId: string; progress: { step: string; index: number; total: number; detail: string } }>(
        "self-develop-progress",
        (event) => {
          setProgress((current) => ({
            ...current,
            [event.payload.releaseId]: event.payload.progress,
          }));
        },
      ),
    ];
    return () => {
      for (const p of unlisten) void p.then((off) => off());
    };
  }, [refresh]);

  return { releases, refresh, progress };
}
