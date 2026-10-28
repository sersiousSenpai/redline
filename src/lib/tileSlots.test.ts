// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { setTile } from "./tileSlots";

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
