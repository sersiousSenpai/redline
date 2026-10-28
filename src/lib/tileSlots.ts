// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Pure algebra over a wall's tile slots — the ordered list of terminal ids
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
