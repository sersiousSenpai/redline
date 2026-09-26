// SPDX-License-Identifier: Apache-2.0
/** Durable assignments use conversation IDs, never a tab's strip position. */
export type BrowserPreset = "browse" | "discuss" | "compare" | "research" | "grid";
/** A mosaic's uniform grid. Each side is 1..MAX_GRID_SIDE. */
export interface BrowserGrid { rows: number; cols: number }
export interface BrowserLayout {
  preset: BrowserPreset;
  /** Present ⇒ uniform tiling in row-major order, with no draggable dividers. */
  grid?: BrowserGrid;
  /** Browse IDs by slot. A grid may leave trailing slots empty. */
  tiles: string[];
  horizontal: number;
  vertical: number;
  maximized: string | null;
  focused: string | null;
}
export const PRESETS: { id: BrowserPreset; label: string; count: number }[] = [
  { id: "browse", label: "Browse", count: 1 },
  { id: "discuss", label: "Discuss", count: 1 },
  { id: "compare", label: "Compare", count: 2 },
  { id: "research", label: "Three pages", count: 3 },
  { id: "grid", label: "Grid", count: 4 },
];
export const MAX_GRID_SIDE = 4;
export const MAX_MOSAIC_TILES = MAX_GRID_SIDE * MAX_GRID_SIDE;
/** Narrower than this per column, a mosaic projects to fewer columns. */
export const MIN_MOSAIC_TILE_W = 320;
/** The freeform arrangements (no grid) hold at most four pages. */
const FREEFORM_TILES = 4;
export const DEFAULT_BROWSER_LAYOUT: BrowserLayout = {
  preset: "browse", tiles: [], horizontal: 0.5, vertical: 0.5, maximized: null, focused: null,
};
export function canonicalTabId(browseId: string): string { return `t-${browseId}`; }
export interface BrowserTabDescriptor { id?: string | null; browseId?: string | null; url: string; title?: string }
export function restoreBrowserTabs(descriptors: BrowserTabDescriptor[], createId: () => string, titleOf: (url: string) => string) {
  const seen = new Set<string>();
  return descriptors.flatMap((descriptor) => {
    if (!descriptor || typeof descriptor.url !== "string" || !descriptor.url.trim()) return [];
    const browseId = typeof descriptor.browseId === "string" && /^[a-zA-Z0-9_-]+$/.test(descriptor.browseId) ? descriptor.browseId : createId();
    if (seen.has(browseId)) return [];
    seen.add(browseId);
    const id = canonicalTabId(browseId);
    return [{ id, label: `browser-${id}`, browseId, url: descriptor.url, title: typeof descriptor.title === "string" && descriptor.title ? descriptor.title : titleOf(descriptor.url) }];
  });
}
export function focusedWorkspaceTab<T extends { browseId: string }>(tabs: T[], layout: BrowserLayout): T | undefined {
  return tabs.find((tab) => tab.browseId === layout.focused) ?? tabs.find((tab) => tab.browseId === layout.maximized) ?? tabs[0];
}
export function clampDivider(value: number): number {
  return Number.isFinite(value) ? Math.min(0.8, Math.max(0.2, value)) : 0.5;
}
export function normalizeGrid(raw: unknown): BrowserGrid | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const side = (value: unknown) => Math.min(MAX_GRID_SIDE, Math.max(1, Math.round(Number(value)) || 1));
  return { rows: side((raw as Partial<BrowserGrid>).rows), cols: side((raw as Partial<BrowserGrid>).cols) };
}
/** How many saved assignments a layout holds: its grid's cells, or the freeform four. */
export function layoutCapacity(layout: Pick<BrowserLayout, "grid">): number {
  return layout.grid ? layout.grid.rows * layout.grid.cols : FREEFORM_TILES;
}
export function normalizeBrowserLayout(raw: Partial<BrowserLayout> | null | undefined): BrowserLayout {
  const preset = PRESETS.find((p) => p.id === raw?.preset)?.id ?? "browse";
  const grid = normalizeGrid(raw?.grid);
  return { preset, ...(grid ? { grid } : {}), tiles: [...new Set((Array.isArray(raw?.tiles) ? raw.tiles : []).filter((id): id is string => typeof id === "string"))].slice(0, layoutCapacity({ grid })),
    horizontal: clampDivider(raw?.horizontal ?? 0.5), vertical: clampDivider(raw?.vertical ?? 0.5),
    maximized: typeof raw?.maximized === "string" ? raw.maximized : null,
    focused: typeof raw?.focused === "string" ? raw.focused : null };
}
export function assignTile(layout: BrowserLayout, index: number, id: string): BrowserLayout {
  const capacity = layoutCapacity(layout);
  if (!Number.isInteger(index) || index < 0 || index >= capacity || !id) return layout;
  const tiles = layout.tiles.slice();
  const old = tiles.indexOf(id);
  if (old >= 0) [tiles[old], tiles[index]] = [tiles[index], tiles[old]];
  else tiles[index] = id;
  return { ...layout, tiles: tiles.filter(Boolean).slice(0, capacity), focused: id, maximized: null };
}
/** A compact or maximized page's visible ordinal is not its saved slot. */
export function assignVisibleTile(layout: BrowserLayout, visible: string[], index: number, id: string): BrowserLayout {
  const savedIndex = layout.tiles.indexOf(visible[index]);
  return assignTile(layout, savedIndex >= 0 ? savedIndex : index, id);
}
export function swapVisibleTiles(layout: BrowserLayout, visible: string[], from: number, to: number): BrowserLayout {
  return visible[from] && visible[to] && from !== to ? assignVisibleTile(layout, visible, to, visible[from]) : layout;
}

export function tileBadges(visible: string[]): Record<string, number> {
  return visible.length > 1 ? Object.fromEntries(visible.map((id, index) => [id, index + 1])) : {};
}

/** Previews and applying an arrangement share the same assignments. */
export function arrangementTiles(layout: BrowserLayout, ids: string[], focused: string, count: number): string[] {
  return [...new Set([...layout.tiles, focused, ...ids])].filter(id => ids.includes(id)).slice(0, count);
}
/** The grid drawn at this width: fewer columns when narrow, none while a page is maximized. */
export function visibleGrid(layout: BrowserLayout, ids: string[], width: number): BrowserGrid | undefined {
  if (!layout.grid || (layout.maximized && ids.includes(layout.maximized))) return undefined;
  return { rows: layout.grid.rows, cols: Math.max(1, Math.min(layout.grid.cols, Math.floor(width / MIN_MOSAIC_TILE_W))) };
}
/** Narrowing is a projection. Never overwrite the saved multi-page arrangement. */
export function visibleTileIds(layout: BrowserLayout, ids: string[], focused: string, width: number): string[] {
  if (layout.maximized && ids.includes(layout.maximized)) return [layout.maximized];
  const grid = visibleGrid(layout, ids, width);
  if (grid) {
    // A grid clamps instead of collapsing, and never pads its empty slots
    // with unrelated tabs; only the focused page may borrow one.
    const count = grid.rows * grid.cols;
    const selected = layout.tiles.filter((id) => ids.includes(id)).slice(0, count);
    if (ids.includes(focused) && !selected.includes(focused)) selected[Math.min(selected.length, count - 1)] = focused;
    return selected;
  }
  const count = Math.min(PRESETS.find((p) => p.id === layout.preset)?.count ?? 1, width < 680 ? 1 : width < 1000 ? 2 : 4);
  const selected = [...new Set([...layout.tiles, focused, ...ids])].filter((id) => ids.includes(id)).slice(0, count);
  if (ids.includes(focused) && !selected.includes(focused)) selected[Math.max(0, selected.length - 1)] = focused;
  return selected;
}
export interface TileRect { left: number; top: number; width: number; height: number }
/** A grid ignores `count` and returns every cell, row-major. */
export function tileRects(count: number, layout: BrowserLayout): TileRect[] {
  if (layout.grid) {
    const { rows, cols } = layout.grid;
    return Array.from({ length: rows * cols }, (_, i) => ({ left: (i % cols) * 100 / cols, top: Math.floor(i / cols) * 100 / rows, width: 100 / cols, height: 100 / rows }));
  }
  const x = clampDivider(layout.horizontal) * 100, y = clampDivider(layout.vertical) * 100;
  if (count <= 1) return [{ left: 0, top: 0, width: 100, height: 100 }];
  if (count === 2) return [{ left: 0, top: 0, width: x, height: 100 }, { left: x, top: 0, width: 100 - x, height: 100 }];
  if (count === 3) return [{ left: 0, top: 0, width: x, height: 100 }, { left: x, top: 0, width: 100 - x, height: y }, { left: x, top: y, width: 100 - x, height: 100 - y }];
  return [{ left: 0, top: 0, width: x, height: y }, { left: x, top: 0, width: 100 - x, height: y }, { left: 0, top: y, width: x, height: 100 - y }, { left: x, top: y, width: 100 - x, height: 100 - y }];
}
