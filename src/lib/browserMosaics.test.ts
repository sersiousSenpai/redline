// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { buildMosaic, deleteMosaic, gridFor, isMosaicWorkspace, listMosaics, mosaicFromWorkspace, mosaicLayout, mosaicPageUrl, mosaicTabs, mosaicWorkspaceId, saveMosaic } from "./browserMosaics";
import { saveBrowserWorkspace } from "./browserWorkspace";

beforeEach(() => invoke.mockReset());
const ids = () => { let n = 0; return () => `new-${++n}`; };

describe("browser mosaics", () => {
  it("namespaces workspace IDs so a mosaic is never mistaken for a mission", () => {
    expect(mosaicWorkspaceId("abc")).toBe("mosaic:abc");
    expect(mosaicWorkspaceId("mosaic:abc")).toBe("mosaic:abc");
    expect(isMosaicWorkspace("mosaic:abc")).toBe(true);
    expect(isMosaicWorkspace("regular")).toBe(false);
    expect(isMosaicWorkspace("mission-mosaic:abc")).toBe(false);
  });

  it("builds a definition from the editor, skipping blanks and assuming https", () => {
    const result = buildMosaic({ id: "one", name: " Stock News ", grid: { rows: 2, cols: 2 }, createId: ids(), entries: [
      { url: "wsj.com", label: " WSJ " }, { url: "", label: "ignored" }, { url: "https://finance.yahoo.com/", label: "" }, { url: "marketwatch.com", label: "" }, { url: "hidden.example", label: "" },
    ] });
    expect(result).toEqual({ mosaic: { id: "mosaic:one", name: "Stock News", grid: { rows: 2, cols: 2 }, cells: [
      { browseId: "new-1", url: "https://wsj.com/", label: "WSJ" },
      { browseId: "new-2", url: "https://finance.yahoo.com/" },
      { browseId: "new-3", url: "https://marketwatch.com/" },
    ] } });
  });

  it("keeps the browse ID of an unchanged page so its conversation survives an edit", () => {
    const previous = { id: "mosaic:one", name: "News", grid: { rows: 1, cols: 2 }, cells: [{ browseId: "wsj", url: "https://wsj.com/" }, { browseId: "ft", url: "https://ft.com/" }] };
    const result = buildMosaic({ id: "mosaic:one", name: "News", grid: { rows: 1, cols: 3 }, previous, createId: ids(), entries: [
      { url: "ft.com", label: "" }, { url: "barrons.com", label: "" }, { url: "wsj.com", label: "" },
    ] });
    expect("mosaic" in result && result.mosaic.cells.map((cell) => cell.browseId)).toEqual(["ft", "new-1", "wsj"]);
  });

  it("explains what is missing instead of saving an unusable mosaic", () => {
    const base = { id: "one", grid: { rows: 1, cols: 2 }, createId: ids() };
    expect(buildMosaic({ ...base, name: "  ", entries: [{ url: "wsj.com", label: "" }] })).toEqual({ error: "Give this mosaic a name." });
    expect(buildMosaic({ ...base, name: "News", entries: [{ url: "", label: "" }] })).toEqual({ error: "Add at least one page." });
    expect(buildMosaic({ ...base, name: "News", entries: [{ url: "wsj.com", label: "" }, { url: "stock news", label: "" }] })).toEqual({ error: "Page 2 needs a web address, like wsj.com.", index: 1 });
    expect(mosaicPageUrl("javascript:alert(1)")).toBeNull();
    expect(mosaicPageUrl("localhost:3000")).toBe("https://localhost:3000/");
  });

  it("opens every cell at its saved address in grid order", () => {
    const mosaic = mosaicFromWorkspace("mosaic:one", { name: "News", grid: { rows: 3, cols: 3 }, tabs: [{ id: "t-a", browseId: "a", url: "https://a.example/where-i-left-off" }],
      cells: [{ browseId: "a", url: "https://a.example/", label: "A" }, { browseId: "a", url: "https://dup.example/" }, { browseId: "b", url: "https://b.example/" }] })!;
    expect(mosaic.cells.map((cell) => cell.browseId)).toEqual(["a", "b"]);
    expect(mosaicTabs(mosaic)).toEqual([{ id: "t-a", browseId: "a", url: "https://a.example/", title: "A" }, { id: "t-b", browseId: "b", url: "https://b.example/", title: "" }]);
    expect(mosaicLayout(mosaic)).toMatchObject({ preset: "grid", grid: { rows: 3, cols: 3 }, tiles: ["a", "b"], maximized: null, focused: "a" });
    expect(mosaicFromWorkspace("regular", { tabs: [], cells: [] })).toBeNull();
    expect(mosaicFromWorkspace("mosaic:two", { tabs: [] })).toBeNull();
  });

  it("chooses a near-square grid for a set of pages", () => {
    expect([1, 2, 3, 4, 5, 9, 10, 16, 40].map((n) => gridFor(n))).toEqual([
      { rows: 1, cols: 1 }, { rows: 1, cols: 2 }, { rows: 2, cols: 2 }, { rows: 2, cols: 2 }, { rows: 2, cols: 3 }, { rows: 3, cols: 3 }, { rows: 3, cols: 4 }, { rows: 4, cols: 4 }, { rows: 4, cols: 4 },
    ]);
  });

  it("lists, saves and deletes through the workspace commands", async () => {
    invoke.mockResolvedValueOnce([{ id: "mosaic:one", name: "News", grid: { rows: 3, cols: 3 }, tabCount: 9, updatedAt: 5 }, { id: "mission-1", name: "stray" }, { id: "mosaic:two", name: "", grid: null }]);
    expect(await listMosaics()).toEqual([
      { id: "mosaic:one", name: "News", grid: { rows: 3, cols: 3 }, tabCount: 9, updatedAt: 5 },
      { id: "mosaic:two", name: "Untitled mosaic", grid: { rows: 1, cols: 1 }, tabCount: 0, updatedAt: 0 },
    ]);
    expect(invoke).toHaveBeenLastCalledWith("browser_workspace_list", { prefix: "mosaic:" });

    const mosaic = { id: "mosaic:three", name: "News", grid: { rows: 1, cols: 1 }, cells: [{ browseId: "a", url: "https://a.example/" }] };
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce({ revision: 1 });
    await saveMosaic(mosaic);
    expect(invoke).toHaveBeenLastCalledWith("browser_workspace_write", { workspaceId: "mosaic:three", expectedRevision: 0, value: expect.objectContaining({ name: "News", cells: mosaic.cells, tabs: [expect.objectContaining({ browseId: "a" })], layout: expect.objectContaining({ grid: { rows: 1, cols: 1 } }) }) });

    // A save queued before the delete must not resurrect the row.
    invoke.mockReset();
    let release!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(null);
    const deleting = deleteMosaic("mosaic:three");
    const stale = saveBrowserWorkspace("mosaic:three", { tabs: [] });
    release(); await deleting;
    await expect(stale).rejects.toThrow("newer state has been preserved");
    expect(invoke.mock.calls.map((call) => call[0])).not.toContain("browser_workspace_write");
  });
});
