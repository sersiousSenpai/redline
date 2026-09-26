// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { invoke } from "@tauri-apps/api/core";
import { canonicalTabId, DEFAULT_BROWSER_LAYOUT, MAX_GRID_SIDE, MAX_MOSAIC_TILES, normalizeBrowserLayout, normalizeGrid, type BrowserGrid, type BrowserLayout } from "./browserLayout";
import { forgetBrowserWorkspace, loadBrowserWorkspace, saveBrowserWorkspace, type SavedBrowserWorkspace } from "./browserWorkspace";

// A mosaic is a saved, named grid of pages: a `browser_workspaces` row whose id
// carries MOSAIC_PREFIX. Its definition (name, grid, cells) is what opening it
// restores — every tile at its saved address. The row's `tabs` and `layout` are
// the live session on top, saved by the pane like any other workspace.

export const MOSAIC_PREFIX = "mosaic:";
/** localStorage key for the mosaic opened when the browser first mounts. */
export const STARTUP_MOSAIC_KEY = "redline.browser.startupMosaic";
export const isMosaicWorkspace = (workspaceId: string) => workspaceId.startsWith(MOSAIC_PREFIX);
export const mosaicWorkspaceId = (id: string) => isMosaicWorkspace(id) ? id : `${MOSAIC_PREFIX}${id}`;

export interface MosaicCell { browseId: string; url: string; label?: string }
export interface Mosaic { id: string; name: string; grid: BrowserGrid; cells: MosaicCell[] }
export interface MosaicSummary { id: string; name: string; grid: BrowserGrid; tabCount: number; updatedAt: number }

const UNTITLED = "Untitled mosaic";
const BROWSE_ID = /^[a-zA-Z0-9_-]+$/;

export async function listMosaics(): Promise<MosaicSummary[]> {
  const rows = await invoke<Partial<MosaicSummary>[]>("browser_workspace_list", { prefix: MOSAIC_PREFIX });
  return rows.flatMap((row) => typeof row.id === "string" && isMosaicWorkspace(row.id) ? [{
    id: row.id,
    name: typeof row.name === "string" && row.name.trim() ? row.name : UNTITLED,
    grid: normalizeGrid(row.grid) ?? { rows: 1, cols: 1 },
    tabCount: Number.isSafeInteger(row.tabCount) ? row.tabCount! : 0,
    updatedAt: Number.isSafeInteger(row.updatedAt) ? row.updatedAt! : 0,
  }] : []);
}

/** The definition held in a workspace row, or null when the row is not a mosaic. */
export function mosaicFromWorkspace(id: string, saved: Partial<SavedBrowserWorkspace> | null | undefined): Mosaic | null {
  if (!saved || !isMosaicWorkspace(id) || !Array.isArray(saved.cells)) return null;
  const seen = new Set<string>();
  const cells = saved.cells.flatMap((cell): MosaicCell[] => {
    if (!cell || typeof cell.url !== "string" || typeof cell.browseId !== "string" || !BROWSE_ID.test(cell.browseId) || seen.has(cell.browseId)) return [];
    seen.add(cell.browseId);
    return [{ browseId: cell.browseId, url: cell.url, ...(typeof cell.label === "string" && cell.label.trim() ? { label: cell.label.trim() } : {}) }];
  }).slice(0, MAX_MOSAIC_TILES);
  const grid = normalizeGrid(saved.grid) ?? gridFor(cells.length);
  return { id, name: typeof saved.name === "string" && saved.name.trim() ? saved.name : UNTITLED, grid, cells: cells.slice(0, grid.rows * grid.cols) };
}

export async function loadMosaic(id: string): Promise<Mosaic | null> {
  return mosaicFromWorkspace(id, await loadBrowserWorkspace(id));
}

/** The tabs a mosaic opens with: every cell at its saved address. */
export function mosaicTabs(mosaic: Mosaic): SavedBrowserWorkspace["tabs"] {
  return mosaic.cells.map((cell) => ({ id: canonicalTabId(cell.browseId), browseId: cell.browseId, url: cell.url, title: cell.label ?? "" }));
}

/** Opening resets the arrangement to the definition: cells in order, nothing maximized. */
export function mosaicLayout(mosaic: Mosaic): BrowserLayout {
  return normalizeBrowserLayout({ ...DEFAULT_BROWSER_LAYOUT, preset: "grid", grid: mosaic.grid, tiles: mosaic.cells.map((cell) => cell.browseId), focused: mosaic.cells[0]?.browseId ?? null });
}

export function saveMosaic(mosaic: Mosaic): Promise<void> {
  return saveBrowserWorkspace(mosaic.id, { name: mosaic.name, grid: mosaic.grid, cells: mosaic.cells, tabs: mosaicTabs(mosaic), layout: mosaicLayout(mosaic) });
}

export async function deleteMosaic(id: string): Promise<void> {
  await invoke("browser_workspace_delete", { workspaceId: id });
  forgetBrowserWorkspace(id);
}

/** The smallest near-square grid that holds `count` pages. */
export function gridFor(count: number): BrowserGrid {
  const pages = Math.min(MAX_MOSAIC_TILES, Math.max(1, Math.floor(count) || 1));
  const cols = Math.min(MAX_GRID_SIDE, Math.ceil(Math.sqrt(pages)));
  return { rows: Math.min(MAX_GRID_SIDE, Math.ceil(pages / cols)), cols };
}

/** A web address typed into the editor, with https:// assumed. Null when it isn't one. */
export function mosaicPageUrl(raw: string): string | null {
  const input = raw.trim();
  if (!input || /\s/.test(input)) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    if ((url.protocol === "https:" || url.protocol === "http:") && (url.hostname.includes(".") || url.hostname === "localhost")) return url.href;
  } catch { /* not an address */ }
  return null;
}

export interface MosaicEntry { url: string; label: string }
export type MosaicDraftResult = { mosaic: Mosaic } | { error: string; index?: number };

/** Turn the editor's fields into a definition. Blank entries are skipped; a
 *  cell whose address is unchanged keeps its browse ID, so its chat survives. */
export function buildMosaic(input: { id: string; name: string; grid: BrowserGrid; entries: MosaicEntry[]; previous?: Mosaic | null; createId: () => string }): MosaicDraftResult {
  const name = input.name.trim();
  if (!name) return { error: "Give this mosaic a name." };
  if (name.length > 200) return { error: "Use a name of 200 characters or fewer." };
  const grid = normalizeGrid(input.grid)!;
  const reusable = new Map((input.previous?.cells ?? []).map((cell) => [cell.url, cell.browseId]));
  const pages: { url: string; label: string }[] = [];
  const entries = input.entries.slice(0, grid.rows * grid.cols);
  for (let index = 0; index < entries.length; index++) {
    if (!entries[index].url.trim()) continue;
    const url = mosaicPageUrl(entries[index].url);
    if (!url) return { error: `Page ${index + 1} needs a web address, like wsj.com.`, index };
    pages.push({ url, label: entries[index].label.trim().slice(0, 80) });
  }
  if (!pages.length) return { error: "Add at least one page." };
  const cells = pages.map(({ url, label }): MosaicCell => {
    const kept = reusable.get(url);
    reusable.delete(url);
    return { browseId: kept ?? input.createId(), url, ...(label ? { label } : {}) };
  });
  return { mosaic: { id: mosaicWorkspaceId(input.id), name, grid, cells } };
}
