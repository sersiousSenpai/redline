// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";

import type { CollabRole } from "../collab/collabConfig";
import type { CollabProviderHandle } from "../collab/provider";
import { useMenuOverlay } from "./menuOverlay";

/** A room this window is in: who is there comes from the provider's
 *  awareness. */
export interface LivePresence {
  handle: CollabProviderHandle;
  /** This side's role — which ending the menu offers. */
  role: CollabRole;
  /** Owner: stop sharing; collaborator: leave the session. */
  onEnd: () => void;
  /** Owner: revoke a peer's invite — transport-side eviction plus a room key
   *  rotation, so the peer can't rejoin or follow future edits. */
  onRevokePeer?: (inviteHash: string, name: string) => void;
}

export interface LiveSessionMenuProps {
  /** Inviting needs an active plan session to share. */
  canInvite: boolean;
  /** A live room is already active (sharing or joined). */
  collabActive: boolean;
  onInvite: () => void;
  onJoinSession: () => void;
  /** The room on screen, when there is one: its people in the menu. */
  presence?: LivePresence | null;
}

interface PresenceEntry {
  clientId: number;
  name: string;
  color: string;
  role?: CollabRole;
  /** SHA-256 of the peer's invite token — the revocation handle. */
  inviteHash?: string;
}

/** Who is in the room right now, from provider awareness. */
function usePresenceEntries(handle: CollabProviderHandle | null): PresenceEntry[] {
  const [entries, setEntries] = useState<PresenceEntry[]>([]);
  useEffect(() => {
    if (!handle) {
      setEntries([]);
      return;
    }
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
  return entries;
}

/** The trigger's words, in its three states: idle, live (sharing) and
 *  joined. Exported for the tests. */
export function liveLabel(collabActive: boolean, presence: { role: CollabRole } | null | undefined, people: number): string {
  if (presence) return `${presence.role === "owner" ? "Live" : "Joined"} · ${people}`;
  return collabActive ? "Live" : "Live session";
}

// The live session, on the status bar's right where an editor puts presence
// (D26). It folds the old header dropdown (Invite / Join) and the strip that
// sat under the header while a room was up (who is in it, Invite, Stop
// sharing / Leave) into one control: idle it reads "Live session", sharing
// "Live · N", joined "Joined · N", with the live dot. Nothing in it is red.
export function LiveSessionMenu({
  canInvite,
  collabActive,
  onInvite,
  onJoinSession,
  presence = null,
}: LiveSessionMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ bottom: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const entries = usePresenceEntries(presence?.handle ?? null);
  const selfId = presence?.handle.awareness.clientID ?? -1;
  const others = entries.filter((e) => e.clientId !== selfId).length;
  const owner = presence?.role === "owner";

  // Hide the native browser webview while this menu is up (see useMenuOverlay).
  useMenuOverlay(open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect();
    // Fixed: the bar's halves clip, and the bar is the window's bottom row,
    // so the menu rises from the trigger's right edge.
    if (r) setPos({ bottom: window.innerHeight - r.top + 6, right: Math.max(8, window.innerWidth - r.right - 6) });
    setOpen((o) => !o);
  };

  const inviteDisabled = !canInvite && !collabActive;
  const live = collabActive || !!presence;
  const item = (disabled = false): React.CSSProperties => ({
    display: "block",
    fontSize: "12px",
    fontWeight: 600,
    color: "var(--color-ink)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.45 : 1,
  });

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="rl-statusbar-quiet rl-live-chip"
        onClick={toggle}
        title={presence ? `${owner ? "Sharing" : "Joined"} a live session — ${others === 0 ? "waiting for others to join" : `${others} other${others === 1 ? "" : "s"} here`}` : "Live Session — invite someone or join a live session"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={live}
      >
        {live ? <span className="rl-live-dot" aria-hidden style={{ width: 6, height: 6 }} /> : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        )}
        <span>{liveLabel(collabActive, presence, entries.length)}</span>
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Live Session"
          className="rounded-md overflow-hidden font-sans"
          style={{
            position: "fixed",
            bottom: pos.bottom,
            right: pos.right,
            zIndex: 60,
            width: "240px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
          }}
        >
          {presence && (
            <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--color-rule)", fontSize: "12px", color: "var(--color-ink)" }}>
              <div className="flex items-center gap-1.5 font-medium" style={{ marginBottom: 6 }}>
                <span className="rl-live-dot" aria-hidden />
                Live session
              </div>
              <div className="flex flex-col gap-1">
                {entries.map((e) => (
                  <span key={e.clientId} className="flex items-center gap-1.5 min-w-0" title={e.role === "owner" ? `${e.name} — owner` : e.name}>
                    <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: e.color, flex: "none" }} />
                    <span className="truncate">{e.name}</span>
                    {e.clientId === selfId && <span style={{ color: "var(--color-ink-muted)" }}>(you)</span>}
                    {e.role === "owner" && <span style={{ color: "var(--color-ink-muted)" }}>· owner</span>}
                    {owner && presence.onRevokePeer && e.clientId !== selfId && e.inviteHash && (
                      <button
                        type="button"
                        aria-label={`Remove ${e.name} from the session`}
                        title={`Remove ${e.name} — revokes their invite and rotates the room key`}
                        onClick={() => presence.onRevokePeer!(e.inviteHash!, e.name)}
                        className="rounded-full px-1 opacity-60 hover:opacity-100"
                        style={{ marginLeft: "auto", color: "var(--color-ink-muted)", fontSize: "11px", lineHeight: 1, cursor: "pointer" }}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                ))}
                {others === 0 && <span style={{ color: "var(--color-ink-muted)" }}>Waiting for others to join…</span>}
              </div>
            </div>
          )}
          {(!presence || owner) && (
            <button
              type="button"
              role="menuitem"
              disabled={inviteDisabled}
              onClick={() => {
                if (inviteDisabled) return;
                onInvite();
                setOpen(false);
              }}
              title={
                inviteDisabled
                  ? "Open a plan session to invite collaborators"
                  : collabActive
                    ? "Manage the live session"
                    : "Invite someone to review this plan live"
              }
              className="rl-menu-item w-full text-left px-3 py-2"
              style={{ ...item(inviteDisabled), borderBottom: "1px solid var(--color-rule)" }}
            >
              {collabActive ? "Manage live session" : "Invite to a live session"}
            </button>
          )}
          {!presence && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onJoinSession();
                setOpen(false);
              }}
              title="Join a live session with an invite code"
              className="rl-menu-item w-full text-left px-3 py-2"
              style={item()}
            >
              Join a session…
            </button>
          )}
          {presence && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                presence.onEnd();
                setOpen(false);
              }}
              className="rl-menu-item w-full text-left px-3 py-2"
              style={item()}
            >
              {owner ? "Stop sharing" : "Leave"}
            </button>
          )}
        </div>
      )}
    </>
  );
}
