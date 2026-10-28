// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The right rail (W4): one column beside the stage whose tabs follow the
// active pane's kind. A plan has its discussion, its conversation, the
// project's files and its changes; a browser has its page conversations
// first; a terminal or a file has the files and changes it is about. The
// first tab of a kind is its default, and the rail remembers the last tab
// the user picked per kind — so walking from a plan to a browser and back
// lands on the tab each was left on.
//
// Pure: the tab table, the remembered-tab rule, the width clamp and the
// parse of what was stored. `RightRail.tsx` draws it; App owns the state.

import { isPaneKind, type PaneKind } from "./model";

export type RailTab = "discussion" | "talk" | "files" | "changes";

export const RAIL_TABS: readonly RailTab[] = ["discussion", "talk", "files", "changes"];

export function isRailTab(value: unknown): value is RailTab {
  return typeof value === "string" && (RAIL_TABS as readonly string[]).includes(value);
}

/** The rail's tabs for the active pane's kind, default first. A kind with no
 *  discussion of its own (a chat, a terminal wall, a file, the door, the
 *  global surfaces) leads with the files it sits among. */
export function railTabsFor(kind: PaneKind | null): readonly RailTab[] {
  switch (kind) {
    case "plan":
      return ["discussion", "talk", "files", "changes"];
    case "drafter":
      return ["discussion", "talk", "files"];
    case "browser":
      return ["talk", "files", "changes"];
    case "review":
      return ["discussion", "changes", "files", "talk"];
    default:
      return ["files", "changes", "talk"];
  }
}

/** The last tab picked per pane kind. */
export type RailMemory = Partial<Record<PaneKind, RailTab>>;

/** The tab the rail shows for `kind`: the one last picked there when the kind
 *  still offers it, else the kind's default. */
export function railTabFor(kind: PaneKind | null, memory: RailMemory): RailTab {
  const tabs = railTabsFor(kind);
  const remembered = kind ? memory[kind] : undefined;
  return remembered && tabs.includes(remembered) ? remembered : tabs[0];
}

/** Remember `tab` for `kind`. Identity when nothing changes, so a re-pick of
 *  the shown tab writes nothing. */
export function rememberRailTab(memory: RailMemory, kind: PaneKind | null, tab: RailTab): RailMemory {
  const key = kind ?? "door";
  if (!railTabsFor(key).includes(tab) || memory[key] === tab) return memory;
  return { ...memory, [key]: tab };
}

/** Stored memory is untrusted: anything that is not a known kind mapped to a
 *  tab that kind offers is dropped. */
export function parseRailMemory(value: unknown): RailMemory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: RailMemory = {};
  for (const [kind, tab] of Object.entries(value as Record<string, unknown>)) {
    if (isPaneKind(kind) && isRailTab(tab) && railTabsFor(kind).includes(tab)) out[kind] = tab;
  }
  return out;
}

export const RAIL_MEMORY_KEY = "redline.rail.tabs";

/** The rail's width bounds (the frame's `railWidth`, 280–600 px). */
export const RAIL_MIN_W = 280;
export const RAIL_MAX_W = 600;
/** The collapsed rail: an edge strip of the tabs' icons, so every tab — the
 *  mic included — stays one click away. */
export const RAIL_EDGE_W = 40;
/** The collapsed sidebar's icon pose: the Places and each session as a
 *  status dot (D18). */
export const SIDEBAR_EDGE_W = 44;

/** A stored or dragged width inside the rail's bounds. Garbage reads as the
 *  floor rather than throwing the layout. */
export function clampRailWidth(width: number): number {
  if (!Number.isFinite(width)) return RAIL_MIN_W;
  return Math.max(RAIL_MIN_W, Math.min(RAIL_MAX_W, Math.round(width)));
}

/** What the tab strip calls each tab. */
export const RAIL_TAB_LABEL: Record<RailTab, string> = {
  discussion: "Discussion",
  talk: "Talk",
  files: "Files",
  changes: "Changes",
};
