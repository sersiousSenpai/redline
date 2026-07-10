// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { useMenuOverlay } from "./menuOverlay";

interface CollaborateMenuProps {
  /** Inviting needs an active plan session to share. */
  canInvite: boolean;
  /** A live room is already active (sharing or joined). */
  collabActive: boolean;
  onInvite: () => void;
  onJoinSession: () => void;
  /** Async snapshot share needs an active plan session too. */
  canShare: boolean;
  onShareSnapshot: () => void;
}

// One "Collaborate" entry point folding the former Invite + Join header
// buttons into a single labelled dropdown — collaboration is one concept, so
// it reads as one control. A small live dot marks an active room.
export function CollaborateMenu({
  canInvite,
  collabActive,
  onInvite,
  onJoinSession,
  canShare,
  onShareSnapshot,
}: CollaborateMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Hide the native browser webview while this menu is up (see useMenuOverlay).
  useMenuOverlay(open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
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

  const inviteDisabled = !canInvite && !collabActive;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Collaborate — invite someone or join a live session"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={collabActive}
        className="flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-sans"
        style={{
          fontSize: "11px",
          lineHeight: 1,
          border: "1px solid var(--color-rule)",
          background: collabActive
            ? "var(--color-anchor-bg)"
            : "var(--color-bg-elevated)",
          color: collabActive ? "var(--color-anchor-text)" : "var(--color-ink)",
          cursor: "pointer",
        }}
      >
        {collabActive && (
          <span
            aria-hidden
            style={{
              width: "7px",
              height: "7px",
              borderRadius: "50%",
              background: "var(--color-success)",
              flexShrink: 0,
            }}
          />
        )}
        <span style={{ fontWeight: 600 }}>Collaborate</span>
        <span style={{ color: "var(--color-ink-muted)", fontSize: "9px" }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Collaborate"
          className="absolute right-0 z-50 rounded-md overflow-hidden"
          style={{
            top: "calc(100% + 6px)",
            width: "220px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
          }}
        >
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
            className="rl-menu-item w-full text-left px-3 py-2 font-sans"
            style={{
              display: "block",
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--color-ink)",
              cursor: inviteDisabled ? "default" : "pointer",
              opacity: inviteDisabled ? 0.45 : 1,
              borderBottom: "1px solid var(--color-rule)",
            }}
          >
            {collabActive ? "Manage live session" : "Invite to a live session"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onJoinSession();
              setOpen(false);
            }}
            title="Join a live session with an invite code"
            className="rl-menu-item w-full text-left px-3 py-2 font-sans"
            style={{
              display: "block",
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--color-ink)",
              cursor: "pointer",
              borderBottom: "1px solid var(--color-rule)",
            }}
          >
            Join a session…
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canShare}
            onClick={() => {
              if (!canShare) return;
              onShareSnapshot();
              setOpen(false);
            }}
            title={
              canShare
                ? "Send an encrypted, zero-install snapshot link — no live session needed"
                : "Open a plan session to share a snapshot"
            }
            className="rl-menu-item w-full text-left px-3 py-2 font-sans"
            style={{
              display: "block",
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--color-ink)",
              cursor: canShare ? "pointer" : "default",
              opacity: canShare ? 1 : 0.45,
            }}
          >
            Share a snapshot…
          </button>
        </div>
      )}
    </div>
  );
}
