// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { TermState } from "./termState";
import {
  EVICTION_ORDER,
  fitsAnotherTile,
  parkCandidate,
  PARK_SETTLE_MS,
  placeTarget,
  shelfOrder,
  tileAtPoint,
  type ParkInput,
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
    expect(shelfOrder(["q1", "busy", "ask", "q2", "turn", "work"], s, [], null)).toEqual(["ask", "turn", "busy", "work", "q1", "q2"]);
  });

  it("orders each tier most-recently-evicted first, then creation order", () => {
    expect(shelfOrder(["q1", "q2", "busy", "work"], s, ["q2", "work"], null)).toEqual(["work", "busy", "q2", "q1"]);
  });

  it("a just-parked terminal leads, whatever its tier", () => {
    expect(shelfOrder(["ask", "q1", "q2"], s, [], "q2")).toEqual(["q2", "ask", "q1"]);
  });
});

describe("parkCandidate", () => {
  const T0 = 1_000_000;
  const input = (extra: Partial<ParkInput>): ParkInput => ({
    tiles: ["f", "srv", "idle"],
    states: states({ f: "idle", srv: "serving", idle: "idle" }),
    pinned: none,
    focusIdx: 0,
    zoomedId: null,
    since: new Map([["f", T0], ["srv", T0], ["idle", T0]]),
    touched: new Map(),
    now: T0,
    ...extra,
  });

  it("waits out each state's settle window: 15 s for a server, 2 min for an idle shell", () => {
    expect(PARK_SETTLE_MS).toEqual({ serving: 15_000, held: 15_000, exited: 15_000, idle: 120_000 });
    expect(parkCandidate(input({ now: T0 + 14_999 }))).toBeNull();
    expect(parkCandidate(input({ now: T0 + 15_000 }))).toBe(1);
    // Both settled: the quieter state goes first.
    expect(parkCandidate(input({ now: T0 + 120_000 }))).toBe(2);
  });

  it("input restarts the clock", () => {
    expect(parkCandidate(input({ now: T0 + 20_000, touched: new Map([["srv", T0 + 10_000]]) }))).toBeNull();
    expect(parkCandidate(input({ now: T0 + 25_000, touched: new Map([["srv", T0 + 10_000]]) }))).toBe(1);
  });

  it("never parks the focused, the zoomed, a pinned or the last tile, nor a busy or loud one", () => {
    const late = T0 + 600_000;
    const busyFirst = states({ f: "working", srv: "serving", idle: "idle" });
    expect(parkCandidate(input({ now: late, focusIdx: 1, tiles: ["f", "srv"], states: busyFirst }))).toBeNull();
    expect(parkCandidate(input({ now: late, zoomedId: "srv", tiles: ["f", "srv"] }))).toBeNull();
    expect(parkCandidate(input({ now: late, pinned: new Set(["srv", "idle"]) }))).toBeNull();
    expect(parkCandidate(input({ now: late, tiles: ["srv"], focusIdx: 3 }))).toBeNull();
    const loud = states({ f: "idle", srv: "needs-you", idle: "working" });
    expect(parkCandidate(input({ now: late, states: loud }))).toBeNull();
  });

  it("a terminal with no recorded state change is not settled yet", () => {
    expect(parkCandidate(input({ now: T0 + 600_000, since: new Map() }))).toBeNull();
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
