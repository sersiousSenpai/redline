// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Pure algebra over the dock's tile slots — the ordered list of terminal ids
// currently shown, one per tile. Handlers call these and commit the result, so
// every side effect stays in the handler and never in a setState updater
// (StrictMode double-invokes updaters; that once desynced the panes and
// spawned two replacement shells).
//
// Two disciplines every function keeps:
//
//  * SAME ARRAY IDENTITY when nothing changes — `tiles` is a dependency of
//    handleActivity, which is a prop of every memoized TerminalView; a fresh
//    identity for an unchanged value re-renders the whole fleet.
//  * Resolution is BY ID against the current array, never a captured index —
//    a shell can exit mid-gesture, and the wrong index is a killed session
//    (the old tab strip's `resolveReorder` discipline, inherited).

/** Append `id` as a new tile. No-op (same identity) when `id` is already
 *  tiled or the grid is at `max`. */
export function addTile(
  tiles: readonly string[],
  id: string,
  max: number,
): readonly string[] {
  if (tiles.length >= max || tiles.includes(id)) return tiles;
  return [...tiles, id];
}

/** Drop the tile at `index`. No-op when out of range — and when it's the last
 *  tile, because the dock always shows at least one terminal. */
export function removeTileAt(
  tiles: readonly string[],
  index: number,
): readonly string[] {
  if (tiles.length <= 1 || index < 0 || index >= tiles.length) return tiles;
  return tiles.filter((_, i) => i !== index);
}

/** Show `id` in tile `index`. When `id` already occupies another tile the two
 *  SWAP — the N-tile generalization of the old split's `selectInto`: the user
 *  opened *this tile's* menu, an explicit statement about this tile, and a
 *  swap is what keeps "put these two side by side" expressible. (App-driven
 *  reveals keep the other rule — focus the tile that already shows it — in
 *  the component's `selectTab`.) */
export function setTile(
  tiles: readonly string[],
  index: number,
  id: string,
): readonly string[] {
  if (index < 0 || index >= tiles.length) return tiles;
  if (tiles[index] === id) return tiles;
  const next = [...tiles];
  const existing = tiles.indexOf(id);
  if (existing !== -1) next[existing] = tiles[index];
  next[index] = id;
  return next;
}

/** Relocate the tile at `from` to slot `to` (splice, not swap — the tiles
 *  between shift by one). No-op on out-of-range or `from === to`. */
export function moveTile(
  tiles: readonly string[],
  from: number,
  to: number,
): readonly string[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= tiles.length ||
    to >= tiles.length
  ) {
    return tiles;
  }
  const next = [...tiles];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** After terminal `closedId` (formerly at `closedIndex` in the tab list)
 *  closes: refill every tile showing it from `remainingIds` (the tab list
 *  with it removed) — preferring its left neighbour, then its right, then any
 *  survivor, skipping ids already tiled — and drop the tile when nothing is
 *  left. `focus` tracks the focused tile across the shuffle: it follows its
 *  tile's new position and clamps when that tile is dropped. Same identities
 *  when the closed id was never tiled. */
export function reconcileTiles(
  tiles: readonly string[],
  focus: number,
  closedId: string,
  closedIndex: number,
  remainingIds: readonly string[],
): { tiles: readonly string[]; focus: number } {
  if (!tiles.includes(closedId)) return { tiles, focus };

  const taken = new Set(tiles.filter((id) => id !== closedId));
  const preferred = [
    remainingIds[closedIndex - 1],
    remainingIds[closedIndex],
    ...remainingIds,
  ].filter((id): id is string => id != null);

  const next: string[] = [];
  let nextFocus = focus;
  for (let i = 0; i < tiles.length; i++) {
    let id: string | null = tiles[i];
    if (id === closedId) {
      id = null;
      for (const candidate of preferred) {
        if (!taken.has(candidate)) {
          id = candidate;
          taken.add(candidate);
          break;
        }
      }
    }
    if (id !== null) {
      next.push(id);
    } else if (i < focus) {
      // A dropped tile before the focused one shifts it left.
      nextFocus--;
    }
  }
  // Never empty (the dock always shows a terminal) and focus always in range.
  const tilesOut = next.length > 0 ? next : remainingIds.slice(0, 1);
  return {
    tiles: tilesOut,
    focus: Math.max(0, Math.min(nextFocus, tilesOut.length - 1)),
  };
}
