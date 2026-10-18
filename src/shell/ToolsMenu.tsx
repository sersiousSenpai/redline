// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Tools ▾ (board 4d): the surfaces that used to be the header's radio group,
//! one menu at the far right — Browser ⌘1, Prompt drafter ⌘2, Code review ⌘3,
//! Localhost ⌘4, Runs with how many are live, then Memory with its status and
//! the multi-tile terminal wall. Which rows exist is the workspace manifest's
//! call (`toolSurfaces`); this only draws them.
//!
//! Below a divider, the shell's own utilities that classic kept in its
//! header (`extras`): the command palette (the one way to ⌘K over a browser
//! page, whose keystrokes never reach the app), joining a live session, the
//! memory inspector, tiling the plan beside a tool, and leaving a harness.
//!
//! Lazy: mounted only while open. It hides the native browser webview while
//! up (useMenuOverlay — the webview paints above all DOM) and steps the stage
//! back to 55% (stageDim). It springs out of its trigger, transform and
//! opacity only, and closes on a press outside, Escape or a pick.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Brain, Columns2, Command, GitPullRequest, Globe, LogOut, Monitor, Play, Rows2, SquareTerminal, Users, Wand } from "lucide-react";
import { useMenuOverlay } from "../components/menuOverlay";
import { relativeTime, type MemoryStatus } from "../components/MemoryStatusPill";
import type { ToolDescriptor, ToolId } from "../config/workspace";
import { useStageDim } from "./stageDim";

const ICONS: Partial<Record<ToolId, typeof Globe>> = {
  browser: Globe,
  drafter: Wand,
  review: GitPullRequest,
  servers: Monitor,
  runs: Play,
  terminals: SquareTerminal,
};

/** The utility rows' icons, here rather than in App so the boot path never
 *  carries them; an id without one keeps the label column with a blank. */
const EXTRA_ICONS: Record<string, typeof Globe> = {
  palette: Command,
  join: Users,
  inspector: Brain,
  tile: Columns2,
  split: Rows2,
  harness: LogOut,
};

/** A utility row under the tools: what classic's header carried. */
export interface ToolExtra {
  id: string;
  label: string;
  /** Its shortcut or state, quiet at the row's end. */
  hint?: string;
  onPick: () => void;
}

export interface ToolsMenuProps {
  /** The Tools button: the menu hangs off its bottom-right corner. */
  anchor: RefObject<HTMLElement | null>;
  tools: readonly ToolDescriptor[];
  /** The Tools surface on screen, marked as where you are. */
  current: ToolId | null;
  liveRuns: number;
  onPick: (id: ToolId) => void;
  extras?: readonly ToolExtra[];
  onClose: () => void;
}

/** Below the trigger by the boards' 7px, its right edge 1px past the
 *  trigger's (board 4d: the open Tools box ends at 1234, the menu at 1235). */
function placeUnder(anchor: HTMLElement | null): { top: number; right: number } {
  const r = anchor?.getBoundingClientRect();
  if (!r) return { top: 44, right: 44 };
  return { top: r.bottom + 7, right: Math.max(8, window.innerWidth - r.right - 1) };
}

export default function ToolsMenu({ anchor, tools, current, liveRuns, onPick, extras = [], onClose }: ToolsMenuProps) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState(() => placeUnder(anchor.current));
  const [memory, setMemory] = useState<MemoryStatus | null>(null);
  useMenuOverlay(true);
  useStageDim(true);

  useLayoutEffect(() => {
    setPlace(placeUnder(anchor.current));
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [anchor]);

  // Memory's one-line status, read as the menu opens: the same chain check
  // and last-organized time the memory pill shows.
  const wantsMemory = tools.some((t) => t.id === "memory");
  useEffect(() => {
    if (!wantsMemory) return;
    let gone = false;
    invoke<MemoryStatus>("memory_status")
      .then((status) => {
        if (!gone) setMemory(status);
      })
      .catch(() => {
        /* Ambient: no status is a quiet row, never an error. */
      });
    return () => {
      gone = true;
    };
  }, [wantsMemory]);

  useEffect(() => {
    const away = (e: Event) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const resize = () => onClose();
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", resize);
    };
  }, [anchor, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      onClose();
      anchor.current?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === "Home" ? 0
          : e.key === "End" ? items.length - 1
            : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  };

  const now = Date.now();
  const row = (tool: ToolDescriptor) => {
    const Icon = ICONS[tool.id];
    const memoryRow = tool.id === "memory";
    return (
      <button
        key={tool.id}
        type="button"
        role="menuitem"
        aria-current={tool.id === current || undefined}
        className={memoryRow ? "rl-tools-menu-muted" : undefined}
        onClick={() => onPick(tool.id)}
      >
        {memoryRow ? (
          <span
            className="rl-tools-menu-dot"
            data-broken={memory && !memory.chainOk ? "" : undefined}
            aria-hidden
          />
        ) : (
          Icon && <Icon size={14} className="rl-tools-menu-icon" aria-hidden />
        )}
        <span>{tool.label}</span>
        <span className="rl-tools-menu-fill" />
        {tool.key && <span className="rl-tools-menu-key">⌘{tool.key}</span>}
        {tool.id === "runs" && liveRuns > 0 && <span className="rl-tools-menu-live">{liveRuns} live</span>}
        {memoryRow && memory && (
          <span className="rl-tools-menu-key">
            {memory.chainOk ? relativeTime(memory.lastOrganizedTs, now) : "chain broken"}
          </span>
        )}
      </button>
    );
  };

  const surfaces = tools.filter((t) => t.section === "surfaces");
  const more = tools.filter((t) => t.section === "more");
  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label="Tools"
      data-flow-tools-menu=""
      className="rl-tools-menu rl-glass rl-glass-menu"
      style={{ top: place.top, right: place.right }}
      onKeyDown={onKeyDown}
    >
      {surfaces.map(row)}
      {surfaces.length > 0 && more.length > 0 && <div className="rl-tools-menu-divider" role="separator" />}
      {more.map(row)}
      {extras.length > 0 && <div className="rl-tools-menu-divider" role="separator" />}
      {extras.map((x) => {
        const Icon = EXTRA_ICONS[x.id];
        return (
          <button
            key={x.id}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              x.onPick();
            }}
          >
            {Icon ? (
              <Icon size={14} className="rl-tools-menu-icon" aria-hidden />
            ) : (
              <span className="rl-tools-menu-icon rl-tools-menu-blank" aria-hidden />
            )}
            <span>{x.label}</span>
            <span className="rl-tools-menu-fill" />
            {x.hint && <span className="rl-tools-menu-key">{x.hint}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
