// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePersistedState } from "../theme/usePersistedState";
import type { Mission, MissionFinding, MissionTab } from "../types";

/** Browser-scoped research-mission state: the active mission (one at a time),
 *  the resumable mission list, and the active mission's pins. Owns the
 *  `activeMissionId` (persisted client-side, like `browserOpen`) and keeps the
 *  backend mirror (`mission_set_active`) in sync so the daemon's `/v1/mission/*`
 *  routes can answer the orchestrator agent. Used inside `BrowserPane`. */
export function useMission() {
  const [activeMissionId, setActiveMissionId] = usePersistedState<string | null>(
    "redline.mission.activeId",
    null,
  );
  const [missions, setMissions] = useState<Mission[]>([]);
  const [findings, setFindings] = useState<MissionFinding[]>([]);

  const activeMission =
    missions.find((m) => m.missionId === activeMissionId) ?? null;

  const refreshMissions = useCallback(async () => {
    try {
      setMissions(await invoke<Mission[]>("mission_list"));
    } catch {
      /* ignore — empty list is a fine fallback */
    }
  }, []);

  const refreshFindings = useCallback(async (missionId: string | null) => {
    if (!missionId) {
      setFindings([]);
      return;
    }
    try {
      setFindings(await invoke<MissionFinding[]>("mission_list_findings", { missionId }));
    } catch {
      setFindings([]);
    }
  }, []);

  // Load the mission list once on mount.
  useEffect(() => {
    void refreshMissions();
  }, [refreshMissions]);

  // Mirror the active mission to the backend (for the daemon) and load its pins
  // whenever the active mission (or its goal) changes. `null` clears the mirror.
  useEffect(() => {
    void invoke("mission_set_active", {
      missionId: activeMission?.missionId ?? null,
      title: activeMission?.title ?? null,
      goal: activeMission?.goal ?? null,
      status: activeMission?.status ?? null,
    }).catch(() => {});
    void refreshFindings(activeMission?.missionId ?? null);
  }, [
    activeMission?.missionId,
    activeMission?.goal,
    activeMission?.title,
    activeMission?.status,
    refreshFindings,
  ]);

  const startMission = useCallback(
    async (title: string, goal: string): Promise<Mission | null> => {
      try {
        const m = await invoke<Mission>("mission_create", { title, goal });
        await refreshMissions();
        setActiveMissionId(m.missionId);
        return m;
      } catch {
        return null;
      }
    },
    [refreshMissions, setActiveMissionId],
  );

  const resumeMission = useCallback(
    (missionId: string) => {
      setActiveMissionId(missionId);
    },
    [setActiveMissionId],
  );

  const closeMission = useCallback(() => {
    setActiveMissionId(null);
  }, [setActiveMissionId]);

  const setGoal = useCallback(
    async (missionId: string, title: string, goal: string) => {
      try {
        await invoke("mission_set_goal", { missionId, title, goal });
        await refreshMissions();
      } catch {
        /* ignore */
      }
    },
    [refreshMissions],
  );

  const deleteMission = useCallback(
    async (missionId: string) => {
      try {
        await invoke("mission_delete", { missionId });
      } catch {
        /* ignore */
      }
      if (activeMissionId === missionId) setActiveMissionId(null);
      await refreshMissions();
    },
    [activeMissionId, refreshMissions, setActiveMissionId],
  );

  // Tab-workspace persistence: a mission owns its tab set so re-entering it
  // reopens those tabs with their discussions. The BrowserPane swap engine
  // drives these.
  const getMissionTabs = useCallback(async (missionId: string): Promise<MissionTab[]> => {
    try {
      return await invoke<MissionTab[]>("mission_get_tabs", { missionId });
    } catch {
      return [];
    }
  }, []);

  const setMissionTabs = useCallback(
    async (missionId: string, tabs: MissionTab[]) => {
      try {
        await invoke("mission_set_tabs", { missionId, tabs });
      } catch {
        /* ignore — tabs still work in-memory */
      }
    },
    [],
  );

  const addFinding = useCallback(
    async (args: {
      body: string;
      note?: string | null;
      browseId?: string | null;
      sourceUrl?: string | null;
      sourceTitle?: string | null;
    }): Promise<boolean> => {
      const missionId = activeMission?.missionId;
      if (!missionId) return false;
      try {
        await invoke<MissionFinding>("mission_add_finding", {
          missionId,
          body: args.body,
          note: args.note ?? null,
          browseId: args.browseId ?? null,
          sourceUrl: args.sourceUrl ?? null,
          sourceTitle: args.sourceTitle ?? null,
        });
        await refreshFindings(missionId);
        return true;
      } catch {
        return false;
      }
    },
    [activeMission?.missionId, refreshFindings],
  );

  const removeFinding = useCallback(
    async (findingId: string) => {
      try {
        await invoke("mission_remove_finding", { findingId });
      } catch {
        /* ignore */
      }
      await refreshFindings(activeMission?.missionId ?? null);
    },
    [activeMission?.missionId, refreshFindings],
  );

  return {
    activeMission,
    /** Raw persisted active id — available before the mission list loads, so the
     *  BrowserPane can restore a mission's tabs on mount. */
    activeMissionId,
    missions,
    findings,
    /** browseIds that have contributed at least one pin — drives the stronger
     *  tab aura ("you've already mined this tab"). */
    pinnedBrowseIds: new Set(
      findings.map((f) => f.browseId).filter((b): b is string => !!b),
    ),
    startMission,
    resumeMission,
    closeMission,
    setGoal,
    deleteMission,
    getMissionTabs,
    setMissionTabs,
    addFinding,
    removeFinding,
    refreshMissions,
  };
}

export type UseMission = ReturnType<typeof useMission>;
