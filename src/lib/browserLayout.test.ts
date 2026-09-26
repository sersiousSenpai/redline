import { describe, expect, it } from "vitest";
import { assignTile, assignVisibleTile, canonicalTabId, restoreBrowserTabs, focusedWorkspaceTab, DEFAULT_BROWSER_LAYOUT, MAX_MOSAIC_TILES, normalizeBrowserLayout, tileRects, visibleGrid, visibleTileIds, type BrowserLayout } from "./browserLayout";
describe("browser layouts", () => {
  const layout = { ...DEFAULT_BROWSER_LAYOUT, preset: "grid" as const, tiles: ["a", "b", "c", "d"] };
  it("projects compact layouts without destroying the wide arrangement", () => {
    expect(visibleTileIds(layout, layout.tiles, "d", 500)).toEqual(["d"]);
    expect(visibleTileIds(layout, layout.tiles, "d", 1500)).toEqual(layout.tiles);
  });
  it("swaps assignments and keeps the displaced page", () => {
    expect(assignTile(layout, 0, "c").tiles).toEqual(["c", "b", "a", "d"]);
  });
  it("replaces closed sources and respects a temporary maximum", () => {
    expect(visibleTileIds(layout, ["a", "c", "e"], "e", 1500)).toEqual(["a", "c", "e"]);
    expect(visibleTileIds({ ...layout, maximized: "b" }, layout.tiles, "a", 1500)).toEqual(["b"]);
  });
  it("sanitizes persisted input and bounds dividers", () => {
    expect(normalizeBrowserLayout({ horizontal: NaN, vertical: 99, tiles: ["a", "a"] })).toMatchObject({ horizontal: .5, vertical: .8, tiles: ["a"] });
    for (let count = 1; count <= 4; count++) expect(tileRects(count, layout).reduce((sum, r) => sum + r.width * r.height, 0)).toBe(10000);
  });
  it("assigns the saved slot shown by a compact or maximized projection", () => {
    expect(assignVisibleTile(layout, ["d"], 0, "e").tiles).toEqual(["a", "b", "c", "e"]);
    expect(assignVisibleTile({ ...layout, maximized: "b" }, ["b"], 0, "c").tiles).toEqual(["a", "c", "b", "d"]);
    expect(assignTile(layout, -1, "e")).toBe(layout);
  });
  it("migrates numeric tab IDs to stable, collision-free workspace labels", () => {
    const restored = restoreBrowserTabs([
      { id: "t0", browseId: "mission-a", url: "https://a.example" },
      { id: "t0", browseId: "mission-b", url: "https://b.example" },
      { id: "t99", browseId: "mission-a", url: "https://duplicate.example" },
    ], () => "new", (url) => url);
    expect(restored.map((tab) => tab.id)).toEqual([canonicalTabId("mission-a"), canonicalTabId("mission-b")]);
    expect(restored.map((tab) => tab.label)).toEqual(["browser-t-mission-a", "browser-t-mission-b"]);
    expect(restoreBrowserTabs(restored, () => "unused", (url) => url)).toEqual(restored);
  });
  it("uses the freshly loaded workspace focus and falls back to a valid maximized page", () => {
    const tabs = [{ browseId: "a" }, { browseId: "b" }];
    expect(focusedWorkspaceTab(tabs, { ...layout, focused: "b" })).toBe(tabs[1]);
    expect(focusedWorkspaceTab(tabs, { ...layout, focused: "closed", maximized: "b" })).toBe(tabs[1]);
    expect(focusedWorkspaceTab(tabs, { ...layout, focused: "closed" })).toBe(tabs[0]);
    expect(focusedWorkspaceTab([], layout)).toBeUndefined();
  });
});

describe("mosaic grids", () => {
  const ids = Array.from({ length: 16 }, (_, i) => `p${i}`);
  const mosaic = (rows: number, cols: number, tiles = ids.slice(0, rows * cols)): BrowserLayout => ({ ...DEFAULT_BROWSER_LAYOUT, preset: "grid", grid: { rows, cols }, tiles });
  const overlap = (a: { left: number; top: number; width: number; height: number }, b: typeof a) =>
    Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
  it("tiles every grid from 1×1 to 4×4 without gaps or overlap", () => {
    for (let r = 1; r <= 4; r++) for (let c = 1; c <= 4; c++) {
      const rects = tileRects(1, mosaic(r, c));
      expect(rects).toHaveLength(r * c);
      expect(rects.reduce((sum, rect) => sum + rect.width * rect.height, 0)).toBeCloseTo(10000, 6);
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j])).toBeLessThan(1e-9);
      rects.forEach((rect, i) => {
        const column = rects[i % c], row = rects[Math.floor(i / c) * c];
        expect([rect.left, rect.width]).toEqual([column.left, column.width]);
        expect([rect.top, rect.height]).toEqual([row.top, row.height]);
      });
    }
  });
  it("bounds grids and their assignments at sixteen pages", () => {
    const normalized = normalizeBrowserLayout({ grid: { rows: 9, cols: 0 }, tiles: [...ids, "extra"] });
    expect(normalized.grid).toEqual({ rows: 4, cols: 1 });
    expect(normalized.tiles).toEqual(ids.slice(0, 4));
    expect(normalizeBrowserLayout({ grid: { rows: 4, cols: 4 }, tiles: [...ids, "extra"] }).tiles).toHaveLength(MAX_MOSAIC_TILES);
    expect(normalizeBrowserLayout({ tiles: ids })).not.toHaveProperty("grid");
    expect(assignTile(mosaic(3, 3), 8, "new").tiles[8]).toBe("new");
    expect(assignTile(mosaic(3, 3), 9, "new")).toEqual(mosaic(3, 3));
    expect(assignTile(mosaic(3, 3, ["p0"]), 5, "new").tiles).toEqual(["p0", "new"]);
  });
  it("projects fewer columns when narrow without mutating the saved grid", () => {
    const layout = mosaic(3, 3);
    const saved = JSON.stringify(layout);
    expect(visibleTileIds(layout, ids, "p0", 600)).toEqual(["p0", "p1", "p2"]);
    expect(visibleGrid(layout, ids, 600)).toEqual({ rows: 3, cols: 1 });
    expect(visibleTileIds(layout, ids, "p0", 1400)).toEqual(ids.slice(0, 9));
    expect(JSON.stringify(layout)).toBe(saved);
  });
  it("keeps empty slots empty, lets the focused page borrow one, and maximizes one page", () => {
    const partial = mosaic(2, 2, ["p0", "p1"]);
    expect(visibleTileIds(partial, ids, "p0", 1400)).toEqual(["p0", "p1"]);
    expect(visibleTileIds(partial, ids, "p9", 1400)).toEqual(["p0", "p1", "p9"]);
    expect(visibleTileIds(mosaic(2, 2), ids, "p9", 1400)).toEqual(["p0", "p1", "p2", "p9"]);
    const maximized = { ...mosaic(3, 3), maximized: "p4" };
    expect(visibleTileIds(maximized, ids, "p4", 1400)).toEqual(["p4"]);
    expect(visibleGrid(maximized, ids, 1400)).toBeUndefined();
  });
});

it("swaps visible assignments without changing hidden slots and maps badges", async () => {
  const { swapVisibleTiles, tileBadges, arrangementTiles } = await import("./browserLayout");
  const layout = { ...DEFAULT_BROWSER_LAYOUT, tiles: ["a", "b", "c", "d"] };
  expect(swapVisibleTiles(layout, ["a", "b", "c"], 0, 2).tiles).toEqual(["c", "b", "a", "d"]);
  expect(tileBadges(["a", "c", "d"])).toEqual({ a: 1, c: 2, d: 3 });
  expect(tileBadges(["a"])).toEqual({});
  expect(arrangementTiles(layout, ["a", "b", "c", "d"], "b", 3)).toEqual(["a", "b", "c"]);
});
