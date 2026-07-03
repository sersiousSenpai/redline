// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";

import type { CollabRole } from "../collab/collabConfig";
import type { CollabProviderHandle } from "../collab/provider";

interface PresenceEntry {
  clientId: number;
  name: string;
  color: string;
  role?: CollabRole;
  /** SHA-256 of the peer's invite token — the revocation handle. */
  inviteHash?: string;
}

interface PresenceBarProps {
  handle: CollabProviderHandle;
  /** This side's role — drives which action the bar offers. */
  role: CollabRole;
  /** Owner: reopen the invite dialog. */
  onInvite?: () => void;
  /** Owner: stop sharing; collaborator: leave the session. */
  onEnd: () => void;
  /** Owner: revoke the peer's invite — transport-side eviction plus a room
   *  key rotation, so the peer can't rejoin or follow future edits. */
  onRevokePeer?: (inviteHash: string, name: string) => void;
}

/**
 * The live-session strip: who's in the room right now, from provider
 * awareness. Rendered only while a session is being shared/joined, directly
 * under the header so it reads as session chrome, not document content.
 */
export function PresenceBar({
  handle,
  role,
  onInvite,
  onEnd,
  onRevokePeer,
}: PresenceBarProps) {
  const [entries, setEntries] = useState<PresenceEntry[]>([]);

  useEffect(() => {
    const awareness = handle.awareness;
    const read = () => {
      const next: PresenceEntry[] = [];
      for (const [clientId, state] of awareness.getStates()) {
        const user = (state as { user?: PresenceEntry }).user;
        if (!user?.name) continue;
        next.push({
          clientId,
          name: user.name,
          color: user.color ?? "var(--color-ink-muted)",
          role: user.role,
          inviteHash: user.inviteHash,
        });
      }
      next.sort((a, b) => a.clientId - b.clientId);
      setEntries(next);
    };
    read();
    awareness.on("change", read);
    return () => awareness.off("change", read);
  }, [handle]);

  const selfId = handle.awareness.clientID;
  const others = entries.filter((e) => e.clientId !== selfId).length;

  return (
    <div
      className="flex items-center gap-3 px-6 py-1.5"
      style={{
        borderBottom: "1px solid var(--color-rule)",
        background: "var(--color-bg-elevated)",
        fontSize: "12px",
        color: "var(--color-ink)",
      }}
    >
      <span className="flex items-center gap-1.5 font-medium">
        <span className="rl-live-dot" aria-hidden />
        Live session
      </span>
      <span className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
        {entries.map((e) => (
          <span
            key={e.clientId}
            className="flex items-center gap-1 rounded-full px-2 py-0.5"
            style={{
              border: `1px solid ${e.color}`,
              color: "var(--color-ink)",
              whiteSpace: "nowrap",
            }}
            title={e.role === "owner" ? `${e.name} — owner` : e.name}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: e.color,
                display: "inline-block",
              }}
            />
            {e.name}
            {e.clientId === selfId && (
              <span style={{ color: "var(--color-ink-muted)" }}>(you)</span>
            )}
            {e.role === "owner" && (
              <span style={{ color: "var(--color-ink-muted)" }}>· owner</span>
            )}
            {role === "owner" &&
              onRevokePeer &&
              e.clientId !== selfId &&
              e.inviteHash && (
                <button
                  type="button"
                  aria-label={`Remove ${e.name} from the session`}
                  title={`Remove ${e.name} — revokes their invite and rotates the room key`}
                  onClick={() => onRevokePeer(e.inviteHash!, e.name)}
                  className="rounded-full px-1 opacity-60 hover:opacity-100"
                  style={{
                    color: "var(--color-warning)",
                    fontSize: "11px",
                    lineHeight: 1,
                    cursor: "pointer",
                  }}
                >
                  ✕
                </button>
              )}
          </span>
        ))}
        {others === 0 && (
          <span style={{ color: "var(--color-ink-muted)" }}>
            Waiting for others to join…
          </span>
        )}
      </span>
      {role === "owner" && onInvite && (
        <button
          type="button"
          onClick={onInvite}
          className="rounded px-2 py-0.5"
          style={{
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            color: "var(--color-ink)",
            fontSize: "11px",
            cursor: "pointer",
          }}
        >
          Invite
        </button>
      )}
      <button
        type="button"
        onClick={onEnd}
        className="rounded px-2 py-0.5"
        style={{
          border: "1px solid var(--color-rule)",
          background: "var(--color-bg-elevated)",
          color: "var(--color-warning)",
          fontSize: "11px",
          cursor: "pointer",
        }}
      >
        {role === "owner" ? "Stop sharing" : "Leave"}
      </button>
    </div>
  );
}
