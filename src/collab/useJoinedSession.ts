// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * The joined-session shadow (Phase 1c): a collaborator has no backend
 * session — no `get_session`, no hook flow, no SQLite. Everything the
 * sidebar row and the joined document pane know is synthesized from the
 * room's Yjs state: body (the shared fragment, rendered by PlanEditor),
 * comments (the shared map, via the yjs backend), and this hook — the meta
 * map projected into a `ReviewSession`-shaped summary.
 */
import { useEffect, useState } from "react";

import type { CollabConfig } from "./collabConfig";
import type { CollabProviderHandle } from "./provider";
import { readMeta, observeMeta, type CollabMeta } from "./meta";

/** Sidebar/pane facts for a joined room — the "shadow session". */
export interface JoinedSessionInfo {
  /** Stable UI id (`joined:{sessionId}:{threadStart}`) — what `activeId`
   *  holds while the joined room is selected. Never collides with real
   *  session ids (UUIDs). */
  key: string;
  /** Display name: plan title when the owner published one, else project. */
  title: string;
  projectName?: string;
  ownerName?: string;
  /** Owner-published status string ("in_review" | ...), display only. */
  status?: string;
  /** Revision currently displayed (rolls forward with the room). */
  version: number;
}

export function joinedSessionKey(config: CollabConfig): string {
  return `joined:${config.sessionId}:${config.threadStart}`;
}

export function isJoinedSessionId(id: string | null): boolean {
  return !!id && id.startsWith("joined:");
}

export function useJoinedSession(
  joinedRoom: { config: CollabConfig; name: string } | null,
  handle: CollabProviderHandle | null,
): JoinedSessionInfo | null {
  const [meta, setMeta] = useState<CollabMeta>({});

  useEffect(() => {
    if (!joinedRoom || !handle) {
      setMeta({});
      return;
    }
    const ydoc = handle.ydoc;
    const read = () => setMeta(readMeta(ydoc));
    read();
    return observeMeta(ydoc, read);
  }, [joinedRoom, handle]);

  if (!joinedRoom) return null;
  const { config } = joinedRoom;
  return {
    key: joinedSessionKey(config),
    title:
      meta.planTitle ||
      meta.projectName ||
      (meta.ownerName ? `${meta.ownerName}’s plan` : "Live session"),
    ...(meta.projectName ? { projectName: meta.projectName } : {}),
    ...(meta.ownerName ? { ownerName: meta.ownerName } : {}),
    ...(meta.status ? { status: meta.status } : {}),
    version: config.version,
  };
}
