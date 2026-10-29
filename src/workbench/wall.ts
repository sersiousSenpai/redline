// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A terminal wall's data (`WallData`, a terminals pane's): the pure rules
// the reducer, the one `TerminalTabs` and its layer share. Kept out of
// model.ts, which the boot path reads: only lazy chunks import this.

import { MAX_WALL_TILES, activeTabOf, shownPaneIds, type Pane, type WallData, type WorkbenchState } from "./model";

export const EMPTY_WALL: WallData = { tiles: [], focus: 0, zoomed: null, pinned: [] };

/** A wall as the reducer stores it: tiles unique and capped, the focus a
 *  real index, the zoom and the pins naming tiles of this wall. Treats its
 *  input as untrusted (it arrives from the component and from storage). */
export function normalizeWall(data: Partial<WallData> | null | undefined): WallData {
  const raw = Array.isArray(data?.tiles) ? data.tiles : [];
  const tiles: string[] = [];
  for (const id of raw) {
    if (typeof id === "string" && id && !tiles.includes(id)) tiles.push(id);
    if (tiles.length === MAX_WALL_TILES) break;
  }
  const focus = typeof data?.focus === "number" && Number.isInteger(data.focus) ? Math.max(0, Math.min(data.focus, Math.max(0, tiles.length - 1))) : 0;
  const zoomed = typeof data?.zoomed === "string" && tiles.includes(data.zoomed) ? data.zoomed : null;
  const pinned = Array.isArray(data?.pinned) ? tiles.filter((id) => data.pinned!.includes(id)) : [];
  return { tiles, focus, zoomed, pinned };
}

/** Whether two walls show the same thing (pins compared as a set). */
export function sameWall(a: WallData, b: WallData): boolean {
  return (
    a.focus === b.focus &&
    a.zoomed === b.zoomed &&
    a.tiles.length === b.tiles.length &&
    a.tiles.every((id, i) => id === b.tiles[i]) &&
    a.pinned.length === b.pinned.length &&
    a.pinned.every((id) => b.pinned.includes(id))
  );
}

/** A terminal appended to a wall, or brought into focus when it is on it. A
 *  full wall is left as it is (the caller opens a new tab instead). */
export function placeOnWall(wall: WallData, id: string): WallData {
  const at = wall.tiles.indexOf(id);
  if (at !== -1) return { ...wall, focus: at, zoomed: wall.zoomed === id ? id : null };
  if (wall.tiles.length >= MAX_WALL_TILES) return wall;
  return { ...wall, tiles: [...wall.tiles, id], focus: wall.tiles.length, zoomed: null };
}

// ── Several walls on screen (W5, D7: one layer spans them all) ────────────

/** A wall's box in the terminal layer, as fractions of it. */
export interface WallFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The terminals panes on screen: the active tab's shown walls (a zoom
 *  shows its pane alone), in reading order, with the focused pane's id.
 *  The same object back while neither moved, so a reader re-renders only
 *  when a wall on screen did. */
export interface VisibleWalls {
  walls: readonly Pane<"terminals">[];
  focused: string | null;
}
const NO_WALLS: VisibleWalls = { walls: [], focused: null };
let wallsState: WorkbenchState | null = null;
let wallsValue: VisibleWalls = NO_WALLS;
export function selectVisibleWalls(state: WorkbenchState): VisibleWalls {
  if (state === wallsState) return wallsValue;
  wallsState = state;
  const set = state.sets[state.activeKey];
  const tab = set ? activeTabOf(set) : null;
  const walls: Pane<"terminals">[] = [];
  if (set && tab) {
    for (const id of shownPaneIds(tab)) {
      const pane = set.panes[id];
      if (pane?.kind === "terminals") walls.push(pane);
    }
  }
  const focused = tab?.focusedPaneId ?? null;
  const prev = wallsValue;
  const same = prev.focused === focused && prev.walls.length === walls.length && prev.walls.every((w, i) => w === walls[i]);
  if (!same) wallsValue = walls.length ? { walls, focused } : NO_WALLS;
  return wallsValue;
}

/** The terminals pane on screen the one `TerminalTabs` works on: the
 *  focused wall, else the one it worked on last if still shown, else the
 *  first. */
export function primaryWall(visible: VisibleWalls, last: string | null): Pane<"terminals"> | null {
  const { walls, focused } = visible;
  return walls.find((w) => w.id === focused) ?? walls.find((w) => w.id === last) ?? walls[0] ?? null;
}

/** Each wall's box in the union of them all, as fractions of it. */
export function wallFrames(boxes: ReadonlyMap<string, { left: number; top: number; width: number; height: number }>): { union: { left: number; top: number; right: number; bottom: number }; frames: Map<string, WallFrame> } | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const r of boxes.values()) {
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.left + r.width);
    bottom = Math.max(bottom, r.top + r.height);
  }
  const w = right - left;
  const h = bottom - top;
  if (!(w > 0 && h > 0)) return null;
  const frames = new Map<string, WallFrame>();
  for (const [id, r] of boxes) frames.set(id, { left: (r.left - left) / w, top: (r.top - top) / h, width: r.width / w, height: r.height / h });
  return { union: { left, top, right, bottom }, frames };
}
