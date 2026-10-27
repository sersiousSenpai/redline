// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { TermState } from "./termState";
import {
  EVICTION_ORDER,
  fitsAnotherTile,
  placeTarget,
  shelfOrder,
  tileAtPoint,
} from "./tilePolicy";

const states = (entries: Record<string, TermState>) => new Map(Object.entries(entries));
const none = new Set<string>();

describe("placeTarget", () => {
  it("adds a tile while one more still fits", () => {
    expect(placeTarget(["a"], states({ a: "idle" }), none, 0, true)).toEqual({ kind: "add" });
  });

  it("otherwise replaces the quietest tile: exited › idle › serving › held › running › working", () => {
    expect(EVICTION_ORDER).toEqual(["exited", "idle", "serving", "held", "running", "working"]);
    const tiles = ["f", "run", "srv", "dead", "idle"];
    const s = states({ f: "idle", run: "running", srv: "serving", dead: "exited", idle: "idle" });
    expect(placeTarget(tiles, s, none, 0, false)).toEqual({ kind: "replace", index: 3 });
    const noDead = states({ f: "idle", run: "running", srv: "serving", dead: "held", idle: "idle" });
    expect(placeTarget(tiles, noDead, none, 0, false)).toEqual({ kind: "replace", index: 4 });
  });

  it("never replaces a pinned, focused or loud tile while anything else may go", () => {
    const tiles = ["f", "pin", "ask", "turn", "busy"];
    const s = states({ f: "exited", pin: "exited", ask: "needs-you", turn: "your-turn", busy: "working" });
    expect(placeTarget(tiles, s, new Set(["pin"]), 0, false)).toEqual({ kind: "replace", index: 4 });
  });

  it("replaces the focused tile only as a last resort", () => {
    const tiles = ["pin", "f", "ask"];
    const s = states({ pin: "idle", f: "working", ask: "needs-you" });
    expect(placeTarget(tiles, s, new Set(["pin"]), 1, false)).toEqual({ kind: "replace", index: 1 });
    expect(placeTarget(["only"], states({ only: "idle" }), none, 0, false)).toEqual({ kind: "replace", index: 0 });
    // A stale focus index is clamped, never handed back out of range.
    expect(placeTarget(["only"], states({ only: "idle" }), none, 4, false)).toEqual({ kind: "replace", index: 0 });
  });

  it("never breaks a pin while the wall can still grow: a pinned focused tile adds one past the fit rule", () => {
    const tiles = ["pin", "f"];
    const s = states({ pin: "idle", f: "idle" });
    const both = new Set(["pin", "f"]);
    expect(placeTarget(tiles, s, both, 1, false, true)).toEqual({ kind: "add" });
    // At the cap something has to give, and it is still the focused tile.
    expect(placeTarget(tiles, s, both, 1, false, false)).toEqual({ kind: "replace", index: 1 });
    // An unpinned focused tile is the plan's last resort, room or not.
    expect(placeTarget(tiles, s, new Set(["pin"]), 1, false, true)).toEqual({ kind: "replace", index: 1 });
  });

  it("breaks a tie toward the later tile", () => {
    const tiles = ["f", "x", "y"];
    expect(placeTarget(tiles, states({ f: "idle", x: "idle", y: "idle" }), none, 0, false)).toEqual({ kind: "replace", index: 2 });
  });
});

describe("fitsAnotherTile", () => {
  const FULL = { width: 1728, height: 970 };
  const SHORT = { width: 1440, height: 270 };

  it("adds while every tile keeps 80×24 — two rows of two on a full window, not five", () => {
    expect(fitsAnotherTile(1, FULL, 14)).toBe(true);
    expect(fitsAnotherTile(3, FULL, 14)).toBe(true);
    expect(fitsAnotherTile(4, FULL, 14)).toBe(false);
  });

  it("a dock too short for 24 rows at any count may still widen, never split", () => {
    // 1440px holds two 80-column tiles side by side; a third would be 60 wide.
    expect(fitsAnotherTile(1, SHORT, 14)).toBe(true);
    expect(fitsAnotherTile(2, SHORT, 14)).toBe(false);
  });

  it("never past the cap, and an unmeasured dock defers to the cap alone", () => {
    expect(fitsAnotherTile(14, FULL, 14)).toBe(false);
    expect(fitsAnotherTile(5, null, 14)).toBe(true);
    expect(fitsAnotherTile(5, { width: 0, height: 0 }, 14)).toBe(true);
    expect(fitsAnotherTile(14, null, 14)).toBe(false);
  });
});

describe("shelfOrder", () => {
  const s = states({ q1: "idle", busy: "running", ask: "needs-you", q2: "serving", turn: "your-turn", work: "working" });

  it("puts loud first, then busy, then quiet", () => {
    expect(shelfOrder(["q1", "busy", "ask", "q2", "turn", "work"], s, [])).toEqual(["ask", "turn", "busy", "work", "q1", "q2"]);
  });

  it("orders each tier most-recently-evicted first, then creation order", () => {
    expect(shelfOrder(["q1", "q2", "busy", "work"], s, ["q2", "work"])).toEqual(["work", "busy", "q2", "q1"]);
  });
});

describe("tileAtPoint", () => {
  const boxes = [
    { index: 0, left: 0, top: 0, right: 100, bottom: 50 },
    { index: 1, left: 100, top: 0, right: 200, bottom: 50 },
    { index: 2, left: 0, top: 0, right: 0, bottom: 0 },
  ];

  it("finds the tile under the pointer, edges belonging to the next tile", () => {
    expect(tileAtPoint(boxes, 10, 10)).toBe(0);
    expect(tileAtPoint(boxes, 100, 10)).toBe(1);
    expect(tileAtPoint(boxes, 199, 49)).toBe(1);
  });

  it("is null off the grid, and a hidden (zero-size) tile never matches", () => {
    expect(tileAtPoint(boxes, 250, 10)).toBeNull();
    expect(tileAtPoint(boxes, 0, 0)).toBe(0);
    expect(tileAtPoint([boxes[2]], 0, 0)).toBeNull();
  });
});
