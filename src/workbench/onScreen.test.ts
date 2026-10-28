// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { emptyTabSet, emptyWorkbench, type AnyPane, type TabSet, type WorkbenchState } from "./model";
import { visibleTargets, visibleTargetsKey } from "./onScreen";

function setWith(panes: AnyPane[], shown: string[]): TabSet {
  const set = emptyTabSet();
  const root = shown.length === 1 ? { pane: shown[0] } : { split: true as const, direction: "row" as const, children: shown.map((pane) => ({ pane })), weights: shown.map(() => 1 / shown.length) };
  return {
    ...set,
    order: ["tab1", "tab2"],
    activeTabId: "tab1",
    tabs: { tab1: { id: "tab1", root }, tab2: { id: "tab2", root: { pane: panes[panes.length - 1].id } } } as unknown as TabSet["tabs"],
    panes: Object.fromEntries(panes.map((p) => [p.id, p])),
  };
}

describe("visibleTargets", () => {
  it("names the session shown and every pane in its active tab, nothing from another tab", () => {
    const panes: AnyPane[] = [
      { id: "p1", kind: "plan", data: { sessionId: "s1", version: null } },
      { id: "p2", kind: "chat", data: { source: "agent", terminalId: "t1", sessionId: "s1" } },
      { id: "p3", kind: "chat", data: { source: "companion", companionId: "c1" } },
    ] as AnyPane[];
    const state: WorkbenchState = { ...emptyWorkbench(), activeKey: "plan:s1", sets: { home: emptyTabSet(), "plan:s1": setWith(panes, ["p1", "p2"]) } };
    expect(visibleTargets(state).sort()).toEqual(["plan:s1", "term:t1"]);
    expect(visibleTargets(state)).not.toContain("chat:c1");
  });

  it("Home is no session: a terminal on its wall is on screen, the set itself is not", () => {
    const panes = [{ id: "w", kind: "terminals", data: { tiles: ["t1", "t2"], focused: null, zoomed: null } }] as unknown as AnyPane[];
    const state: WorkbenchState = { ...emptyWorkbench(), sets: { home: setWith(panes, ["w"]) } };
    expect(visibleTargets(state)).toEqual(["term:t1", "term:t2"]);
    expect(visibleTargetsKey(state)).toBe("term:t1\nterm:t2");
  });
});
