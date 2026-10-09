// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  addTile,
  moveTile,
  reconcileTiles,
  removeTileAt,
  setTile,
} from "./tileSlots";

describe("addTile", () => {
  it("appends a new tile up to max, and no-ops (SAME identity) past it or on a dup", () => {
    const tiles = ["a", "b"];
    expect(addTile(tiles, "c", 7)).toEqual(["a", "b", "c"]);
    expect(addTile(tiles, "b", 7)).toBe(tiles);
    expect(addTile(tiles, "c", 2)).toBe(tiles);
  });
});

describe("removeTileAt", () => {
  it("drops the slot, but never the last tile, and no-ops out of range", () => {
    const tiles = ["a", "b", "c"];
    expect(removeTileAt(tiles, 1)).toEqual(["a", "c"]);
    expect(removeTileAt(tiles, -1)).toBe(tiles);
    expect(removeTileAt(tiles, 3)).toBe(tiles);
    const last = ["a"];
    expect(removeTileAt(last, 0)).toBe(last);
  });
});

describe("setTile", () => {
  it("loads an untiled id into the slot (the evicted occupant just leaves)", () => {
    expect(setTile(["a", "b"], 0, "c")).toEqual(["c", "b"]);
  });

  it("SWAPS when the id already occupies another tile — never duplicates", () => {
    expect(setTile(["a", "b", "c"], 0, "c")).toEqual(["c", "b", "a"]);
    expect(setTile(["a", "b", "c"], 2, "a")).toEqual(["c", "b", "a"]);
  });

  it("no-ops with the same identity on the same id or a bad index", () => {
    const tiles = ["a", "b"];
    expect(setTile(tiles, 1, "b")).toBe(tiles);
    expect(setTile(tiles, 5, "c")).toBe(tiles);
    expect(setTile(tiles, -1, "c")).toBe(tiles);
  });
});

describe("moveTile", () => {
  it("splices the tile to its new slot", () => {
    expect(moveTile(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveTile(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("no-ops with the same identity when nothing moves", () => {
    const tiles = ["a", "b", "c"];
    expect(moveTile(tiles, 1, 1)).toBe(tiles);
    expect(moveTile(tiles, -1, 2)).toBe(tiles);
    expect(moveTile(tiles, 0, 3)).toBe(tiles);
  });
});

describe("reconcileTiles", () => {
  it("no-ops with the SAME identities when the closed id was never tiled", () => {
    const tiles = ["a", "b"];
    const out = reconcileTiles(tiles, 1, "z", ["c"], ["c"]);
    expect(out.tiles).toBe(tiles);
    expect(out.focus).toBe(1);
  });

  it("refills only from the candidates it is handed, in order", () => {
    // The caller passes the untiled terminals that need you, oldest first.
    expect(reconcileTiles(["a", "b"], 0, "b", ["d", "c"], ["c", "d"]).tiles).toEqual(["a", "d"]);
  });

  it("with no candidate the tile COLLAPSES — no arbitrary neighbour is pulled back", () => {
    const out = reconcileTiles(["a", "b", "c"], 2, "b", [], ["x", "y"]);
    expect(out.tiles).toEqual(["a", "c"]);
    // Focus follows its tile across the drop.
    expect(out.focus).toBe(1);
  });

  it("skips candidates already shown in another tile — two tiles never show one shell", () => {
    expect(reconcileTiles(["a", "b"], 0, "b", ["a", "b", "c"], []).tiles).toEqual(["a", "c"]);
  });

  it("takes the fallback only when the grid would otherwise be empty", () => {
    expect(reconcileTiles(["b"], 0, "b", [], ["c", "a"]).tiles).toEqual(["c"]);
    expect(reconcileTiles(["b"], 0, "b", ["a"], ["c"]).tiles).toEqual(["a"]);
    // Never the closed terminal itself, whatever the caller passed.
    expect(reconcileTiles(["b"], 0, "b", ["b"], ["b", "c"]).tiles).toEqual(["c"]);
  });

  it("drops the tile when every candidate is already tiled, and focus follows its tile", () => {
    const out = reconcileTiles(["a", "b"], 1, "b", ["a"], ["a"]);
    expect(out.tiles).toEqual(["a"]);
    expect(out.focus).toBe(0);
    // A drop BEFORE the focused tile shifts focus left so it keeps pointing
    // at the same terminal.
    const shifted = reconcileTiles(["x", "a", "y"], 2, "x", [], []);
    expect(shifted.tiles).toEqual(["a", "y"]);
    expect(shifted.focus).toBe(1);
  });

  it("resolves by id against the current array, never a captured index", () => {
    // Closing c (tile 0) must refill tile 0, not wherever c sat in the tab list.
    const out = reconcileTiles(["c", "a"], 0, "c", ["b"], ["b"]);
    expect(out.tiles).toEqual(["b", "a"]);
  });
});
