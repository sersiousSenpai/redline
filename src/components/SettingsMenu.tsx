// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useMenuOverlay } from "./menuOverlay";
import { MenuSurface } from "./ui/MenuSurface";

// One "Settings" entry point that folds the formerly-loose header controls —
// interception mode, theme, font, notifications — into a single dropdown, so
// the header reads as a few clear verbs plus Settings + Options. (The memory
// pill graduated to header chrome when Memory became a main surface.)
// The controls are passed in already-wired (render props) so this component
// owns only layout + open/close; each nested control keeps its own popover.

interface SettingsMenuProps {
  mode: ReactNode;
  theme: ReactNode;
  font: ReactNode;
  lint: ReactNode;
  /** Agent Seats — per-agent model/effort (see AgentSeats.tsx). */
  agents: ReactNode;
  /** Surfaces — the workspace-manifest lens (see SurfacesPanel.tsx). */
  surfaces: ReactNode;
  /** Extensions — the WASM extension host's management view. */
  extensions: ReactNode;
  notifications: ReactNode;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="flex items-center justify-between gap-3 px-3 py-2"
      style={{ borderBottom: "1px solid var(--color-rule)" }}
    >
      <span
        className="font-sans"
        style={{
          fontSize: "var(--rl-text-xs)",
          fontWeight: 600,
          color: "var(--color-ink-muted)",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

export function SettingsMenu({
  mode,
  theme,
  font,
  lint,
  agents,
  surfaces,
  extensions,
  notifications,
}: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Hide the native browser webview while this menu is up (see useMenuOverlay).
  useMenuOverlay(open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // A click inside the panel — including any nested control's own popover,
      // which renders within this subtree — keeps Settings open.
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

  return (
    // The tour anchors here: the theme/mode pickers live inside this popover,
    // which only renders while open, so their own data-tour ids are absent
    // from the DOM whenever the menu is closed.
    <div ref={rootRef} data-tour="settings" className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Settings — mode, theme, font, notifications"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-2 py-1 font-sans"
        style={{
          fontSize: "var(--rl-text-xs)",
          lineHeight: 0,
          borderRadius: "var(--rl-radius-control)",
          border: "1px solid var(--color-rule)",
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink)",
          cursor: "pointer",
        }}
      >
        {/* Gear (inherits currentColor). */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span style={{ fontWeight: 600, fontSize: "var(--rl-text-xs)" }}>
          Settings
        </span>
        <span style={{ color: "var(--color-ink-muted)", fontSize: "9px" }}>
          ▾
        </span>
      </button>

      {open && (
        <MenuSurface
          ariaLabel="Settings"
          className="absolute right-0 z-50"
          style={{
            top: "calc(100% + 6px)",
            width: "260px",
            // Nested control popovers extend past the panel edge.
            overflow: "visible",
          }}
        >
          <Row label="Mode">{mode}</Row>
          <Row label="Theme">{theme}</Row>
          <Row label="Font">{font}</Row>
          <Row label="Linting">{lint}</Row>
          <Row label="Agent Seats">{agents}</Row>
          <Row label="Surfaces">{surfaces}</Row>
          <Row label="Extensions">{extensions}</Row>
          <Row label="Notifications">{notifications}</Row>
        </MenuSurface>
      )}
    </div>
  );
}
