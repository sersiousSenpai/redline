// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect } from "react";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePersistedState } from "../theme/usePersistedState";
import type { Linked } from "../types";

/** Browser-scoped linked-discussion state: the active linked discussion (one at
 *  a time) and the resumable list. Owns the `activeLinkedId` (persisted
 *  client-side, like `activeMissionId`). Simpler than `useMission` — a linked
 *  discussion has no goal, no pins, and no backend `set_active` mirror (the
 *  consult route is parameterized by tab, not by linked id). Used inside
 *  `BrowserPane`. */
export function useLinked() {
  const [activeLinkedId, setActiveLinkedId] = usePersistedState<string | null>(
    "redline.linked.activeId",
    null,
  );
  const [linkedSessions, setLinkedSessions] = useState<Linked[]>([]);

  const activeLinked =
    linkedSessions.find((l) => l.linkedId === activeLinkedId) ?? null;

  const refreshLinked = useCallback(async () => {
    try {
      setLinkedSessions(await invoke<Linked[]>("linked_list"));
    } catch {
      /* ignore — empty list is a fine fallback */
    }
  }, []);

  // Load the list once on mount.
  useEffect(() => {
    void refreshLinked();
  }, [refreshLinked]);

  /** Create a fresh linked discussion and make it active. No goal to collect —
   *  a linked discussion is just a spanning conversation. */
  const startLinked = useCallback(async (): Promise<Linked | null> => {
    try {
      const l = await invoke<Linked>("linked_create", { title: null });
      await refreshLinked();
      setActiveLinkedId(l.linkedId);
      return l;
    } catch {
      return null;
    }
  }, [refreshLinked, setActiveLinkedId]);

  /** Convert a per-tab chat into a linked discussion — a FORK, not a move:
   *  the tab's own thread and session stay untouched; the linked chat's first
   *  turn resumes the tab session with `--fork-session`, and the visible
   *  history is copied behind a divider. Makes the new discussion active. */
  const convertFromBrowse = useCallback(
    async (args: {
      browseId: string;
      tabN?: number | null;
      tabTitle?: string | null;
      tabUrl?: string | null;
      title?: string | null;
    }): Promise<Linked | null> => {
      try {
        const l = await invoke<Linked>("linked_create_from_browse", {
          browseId: args.browseId,
          tabN: args.tabN ?? null,
          tabTitle: args.tabTitle ?? null,
          tabUrl: args.tabUrl ?? null,
          title: args.title ?? null,
        });
        await refreshLinked();
        setActiveLinkedId(l.linkedId);
        return l;
      } catch {
        return null;
      }
    },
    [refreshLinked, setActiveLinkedId],
  );

  const resumeLinked = useCallback(
    (linkedId: string) => {
      setActiveLinkedId(linkedId);
    },
    [setActiveLinkedId],
  );

  const closeLinked = useCallback(() => {
    setActiveLinkedId(null);
  }, [setActiveLinkedId]);

  const deleteLinked = useCallback(
    async (linkedId: string) => {
      try {
        await invoke("linked_delete", { linkedId });
      } catch {
        /* ignore */
      }
      if (activeLinkedId === linkedId) setActiveLinkedId(null);
      await refreshLinked();
    },
    [activeLinkedId, refreshLinked, setActiveLinkedId],
  );

  return {
    activeLinked,
    /** Raw persisted active id — available before the list loads. */
    activeLinkedId,
    linkedSessions,
    startLinked,
    convertFromBrowse,
    resumeLinked,
    closeLinked,
    deleteLinked,
    refreshLinked,
  };
}

export type UseLinked = ReturnType<typeof useLinked>;
