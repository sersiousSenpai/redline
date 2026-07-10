// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Companion session management: which Companion is active (persisted so the
// same spanning conversation resumes across app restarts), the list for the
// switcher, and create/delete. The chat/streaming state itself lives in
// CompanionDrawer (it needs the surface-tagged message shape). Mirrors
// useLinked's session-management half.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { Companion } from "../types";
import { usePersistedState } from "../theme/usePersistedState";

export function useCompanion(open: boolean) {
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [activeId, setActiveId] = usePersistedState<string | null>(
    "redline.companion.activeId",
    null,
  );
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<Companion[]>("companion_list");
      setCompanions(list);
      return list;
    } catch {
      return [] as Companion[];
    } finally {
      setLoaded(true);
    }
  }, []);

  // Opening the drawer ensures a Companion exists and the active id is valid —
  // the default experience is ONE ongoing companion, not a picker.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      const list = await refresh();
      if (!alive) return;
      const exists = activeId && list.some((c) => c.companionId === activeId);
      if (exists) return;
      if (list.length > 0) {
        setActiveId(list[0].companionId);
        return;
      }
      try {
        const created = await invoke<Companion>("companion_create", {
          title: null,
        });
        if (!alive) return;
        setCompanions([created]);
        setActiveId(created.companionId);
      } catch {
        /* surfaced on first send */
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = useCallback(
    async (title?: string) => {
      try {
        const created = await invoke<Companion>("companion_create", {
          title: title ?? null,
        });
        setActiveId(created.companionId);
        await refresh();
        return created;
      } catch {
        return null;
      }
    },
    [refresh, setActiveId],
  );

  const remove = useCallback(
    async (companionId: string) => {
      try {
        await invoke("companion_delete", { companionId });
      } catch {
        /* already gone */
      }
      const list = await refresh();
      if (activeId === companionId) {
        setActiveId(list[0]?.companionId ?? null);
      }
    },
    [activeId, refresh, setActiveId],
  );

  const active =
    companions.find((c) => c.companionId === activeId) ?? null;

  return {
    companions,
    active,
    activeId,
    setActiveId,
    loaded,
    refresh,
    create,
    remove,
  };
}
