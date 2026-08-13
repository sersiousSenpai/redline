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
    const out = reconcileTiles(tiles, 1, "z", 2, ["a", "b", "c"]);
    expect(out.tiles).toBe(tiles);
    expect(out.focus).toBe(1);
  });

  it("refills from the closed tab's LEFT neighbour first, then right", () => {
    // Tabs were [a, b, c]; b (index 1) closes while alone on screen.
    expect(reconcileTiles(["b"], 0, "b", 1, ["a", "c"]).tiles).toEqual(["a"]);
    // Tabs were [b, c]; b (index 0) closes — no left neighbour, right wins.
    expect(reconcileTiles(["b"], 0, "b", 0, ["c"]).tiles).toEqual(["c"]);
  });

  it("skips ids already shown in another tile — two tiles never show one shell", () => {
    // Tabs [a, b, c]; tiles show a and b; closing b must refill with c, not a.
    expect(reconcileTiles(["a", "b"], 0, "b", 1, ["a", "c"]).tiles).toEqual([
      "a",
      "c",
    ]);
  });

  it("drops the tile when every survivor is already tiled, and focus follows its tile", () => {
    // Tabs [a, b]; both tiled; closing b leaves nothing untiled → tile drops.
    const out = reconcileTiles(["a", "b"], 1, "b", 1, ["a"]);
    expect(out.tiles).toEqual(["a"]);
    expect(out.focus).toBe(0);
    // A drop BEFORE the focused tile shifts focus left so it keeps pointing
    // at the same terminal.
    const shifted = reconcileTiles(["x", "a", "y"], 2, "x", 0, ["a", "y"]);
    expect(shifted.tiles).toEqual(["a", "y"]);
    expect(shifted.focus).toBe(1);
  });

  it("resolves by id against the current array, never a captured index", () => {
    // The closed tab's index is stale relative to the tiles — resolution must
    // key on the id. Closing c (which sits in tile 0 despite index 2 in the
    // tab list) must refill tile 0, not tile 2.
    const out = reconcileTiles(["c", "a"], 0, "c", 2, ["a", "b"]);
    expect(out.tiles).toEqual(["b", "a"]);
  });
});
