// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A terminal wall's data (`WallData`, a terminals pane's): the pure rules
// the reducer, the one `TerminalTabs` and its layer share. Kept out of
// model.ts, which the boot path reads: only lazy chunks import this.

import { MAX_WALL_TILES, type WallData } from "./model";

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
