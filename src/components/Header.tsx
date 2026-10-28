// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The window's top bar, exactly the design's (RLTopBar): one 38 px row of
// six things and nothing else —
//
//   ◧   Auth plan · redline   [⌕ Search or run a command…  ⌘K]   ● 2 need you   ◨   ⚙
//
// the sidebar's toggle (⌘B), what is open and where it lives, the command
// field (a click is ⌘K: the palette), the sessions waiting on you (a click
// is ⌘⇧J: the next one), the rail's toggle (⌘⌥B) and the gear (Settings).
//
// What the bar used to carry went where it belongs in this frame (D26): the
// Memory pill and the live session are the status bar's (Footer), Home is
// the sidebar's first Place, snap-back is ⌘⇧0 and the palette's, the plan's
// download and version are the Plan pane's own ⋯ and header, and a harness's
// name stands in the project's place, its exit in the palette.
import { PanelLeft, PanelRight, Search, Settings } from "lucide-react";
import { SettingsGear } from "./SettingsGear";
import type { SettingsGearProps } from "./SettingsGear";
import { beginWindowDrag, toggleWindowMaximize } from "../lib/windowDrag";

// Programmatic window-drag (there is no native title bar — see windowDrag.ts):
// the bare bar drags the window and a double-click zooms it; every control
// on it is a button, so a press on one never starts a drag.

export interface HeaderProps extends Omit<SettingsGearProps, "compact" | "triggerClassName" | "icon"> {
  /** What is open: the plan's name, or "Home". */
  title: string;
  /** Where it lives (the project), or null on Home. */
  project: string | null;
  /** Harness mode: the harness's name, worn in the project's place — the one
   *  piece of branding A5 swaps. null = stock Redline. */
  harnessName?: string | null;
  /** ◧ — the sidebar's own toggle (⌘B), read off the same pose state. */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** ◨ — the rail's own toggle (⌘⌥B). */
  railOpen: boolean;
  onToggleRail: () => void;
  /** The command field: the ⌘K palette. Over a focused web page keystrokes
   *  never reach our DOM, so there this field is how ⌘K exists at all. */
  onOpenPalette: () => void;
  /** Sessions waiting on you — the count ⌘⇧J has somewhere to go for. */
  needsYou: number;
  /** ⌘⇧J's route: the next session that needs you, in its tab. */
  onJumpToNeedsYou: () => void;
}

export function Header({
  title,
  project,
  harnessName = null,
  sidebarOpen,
  onToggleSidebar,
  railOpen,
  onToggleRail,
  onOpenPalette,
  needsYou,
  onJumpToNeedsYou,
  ...settings
}: HeaderProps) {
  const where = harnessName ?? project;
  const needs = needsYou > 0;
  return (
    <header
      className="rl-app-header rl-topbar"
      aria-label="Top bar"
      onMouseDown={beginWindowDrag}
      onDoubleClick={toggleWindowMaximize}
    >
      <button
        type="button"
        className="rl-topbar-btn"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        aria-pressed={sidebarOpen}
        title={`${sidebarOpen ? "Hide" : "Show"} sidebar ⌘B`}
      >
        <PanelLeft size={16} strokeWidth={1.75} aria-hidden />
      </button>
      <div className="rl-topbar-title" title={harnessName ? `Inside ${harnessName} — a harness running on Redline${project ? ` · ${project}` : ""}` : undefined}>
        <span className="rl-topbar-name">{title}</span>
        {where && (
          <>
            <span className="rl-topbar-dot" aria-hidden>·</span>
            <span className="rl-topbar-project">{where}</span>
          </>
        )}
      </div>
      <div className="rl-topbar-centre">
        <button
          type="button"
          className="rl-topbar-field"
          data-tour="command"
          onClick={onOpenPalette}
          aria-label="Search or run a command (⌘K)"
          aria-keyshortcuts="Meta+K"
        >
          <Search size={13} strokeWidth={1.75} aria-hidden />
          <span className="rl-topbar-field-text">Search or run a command…</span>
          <kbd className="rl-topbar-kbd">⌘K</kbd>
        </button>
      </div>
      <button
        type="button"
        className="rl-topbar-needs"
        data-needs={needs || undefined}
        onClick={needs ? onJumpToNeedsYou : undefined}
        aria-disabled={!needs}
        aria-keyshortcuts="Meta+Shift+J"
        title={needs ? "Go to the next session that needs you (⌘⇧J)" : "Nothing needs you"}
      >
        <span aria-hidden className={`rl-topbar-needs-dot${needs ? " rl-term-badge rl-term-badge--needs" : ""}`} />
        <span>{needsYou}</span>
        <span>{needsYou === 1 ? "needs" : "need"} you</span>
      </button>
      <button
        type="button"
        className="rl-topbar-btn"
        onClick={onToggleRail}
        aria-label={railOpen ? "Hide rail" : "Show rail"}
        aria-pressed={railOpen}
        title={`${railOpen ? "Hide" : "Show"} rail ⌘⌥B`}
      >
        <PanelRight size={16} strokeWidth={1.75} aria-hidden />
      </button>
      <SettingsGear
        {...settings}
        compact
        triggerClassName="rl-topbar-btn"
        icon={<Settings size={16} strokeWidth={1.75} aria-hidden />}
      />
    </header>
  );
}
