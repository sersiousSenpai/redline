// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { emptyWorkbench, type PaneInit, type WorkbenchState } from "./model";
import { reduce } from "./reducer";
import { primaryWall, selectVisibleWalls, wallFrames } from "./wall";

const wall = (tiles: string[]): PaneInit => ({ kind: "terminals", data: { tiles, focus: 0, zoomed: null, pinned: [] } });

/** Home: wall w1 | plan | wall w2. */
function twoWalls(): WorkbenchState {
  let s = reduce(emptyWorkbench(), { type: "openTab", pane: wall(["a", "b"]), tabId: "t1", paneId: "w1" });
  s = reduce(s, { type: "splitPane", paneId: "w1", direction: "row", pane: { kind: "plan", data: { sessionId: "s1", version: null } }, newPaneId: "p" });
  return reduce(s, { type: "splitPane", paneId: "p", direction: "row", pane: wall(["c"]), newPaneId: "w2" });
}

describe("several walls on screen, one layer (W5, D7)", () => {
  it("lists the shown walls in reading order, the same object back while none moved", () => {
    const s = twoWalls();
    const v = selectVisibleWalls(s);
    expect(v.walls.map((w) => w.id)).toEqual(["w1", "w2"]);
    expect(v.focused).toBe("w2");
    expect(selectVisibleWalls(s)).toBe(v);
    // A change elsewhere (a rename of the plan) hands back the same value.
    expect(selectVisibleWalls(reduce(s, { type: "renamePane", paneId: "p", title: "x" }))).toBe(v);
    // A zoom shows its pane alone.
    expect(selectVisibleWalls(reduce(s, { type: "zoomPane", paneId: "w1" })).walls.map((w) => w.id)).toEqual(["w1"]);
    // Another tab with no wall: none.
    expect(selectVisibleWalls(reduce(s, { type: "openTab", pane: { kind: "memory", data: {} } })).walls).toEqual([]);
  });

  it("the layer works on the focused wall, keeps the last one while focus is in a pane that is no wall, else the first", () => {
    const s = twoWalls();
    expect(primaryWall(selectVisibleWalls(s), null)?.id).toBe("w2");
    const onPlan = selectVisibleWalls(reduce(s, { type: "focusPane", paneId: "p" }));
    expect(primaryWall(onPlan, "w2")?.id).toBe("w2");
    expect(primaryWall(onPlan, null)?.id).toBe("w1");
    expect(primaryWall(onPlan, "gone")?.id).toBe("w1");
  });

  it("frames each wall's box in the union of them all", () => {
    const laid = wallFrames(new Map([
      ["w1", { left: 100, top: 50, width: 400, height: 600 }],
      ["w2", { left: 900, top: 50, width: 300, height: 300 }],
    ]))!;
    expect(laid.union).toEqual({ left: 100, top: 50, right: 1200, bottom: 650 });
    expect(laid.frames.get("w1")).toEqual({ left: 0, top: 0, width: 400 / 1100, height: 1 });
    expect(laid.frames.get("w2")).toEqual({ left: 800 / 1100, top: 0, width: 300 / 1100, height: 0.5 });
    expect(wallFrames(new Map())).toBeNull();
  });
});
