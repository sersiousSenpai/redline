// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  CLOSED_CAP,
  HOME_KEY,
  MIN_SPLIT_SHARE,
  clampWeights,
  shownPaneIds,
  MAX_WALL_TILES,
  activeTabOf,
  emptyWorkbench,
  isSessionKey,
  isSplit,
  launchKey,
  normalizeWeights,
  paneIdsOf,
  paneTitle,
  planKey,
  sessionIdOf,
  singletonHolder,
  visiblePaneIds,
  type AnyPane,
  type LayoutNode,
  type PaneInit,
  type SessionKey,
  type WorkbenchState,
} from "./model";
import { DEFAULT_DOOR_DRAFT_KEY, doorDraftKey, geometricNeighbour, neighbourPane, reduce, type PaneRect } from "./reducer";

const door = (n = 1): PaneInit => ({ kind: "door", data: { draftKey: `d${n}` } });
const file = (path: string): PaneInit => ({ kind: "file", data: { path } });
const wall = (tiles: string[]): PaneInit => ({ kind: "terminals", data: { tiles, focus: 0, zoomed: null, pinned: [] } });

/** Home with tabs t1..tn, each a single pane p1..pn. */
function home(...panes: PaneInit[]): WorkbenchState {
  let s = emptyWorkbench();
  panes.forEach((pane, i) => {
    s = reduce(s, { type: "openTab", pane, tabId: `t${i + 1}`, paneId: `p${i + 1}` });
  });
  return s;
}
const set = (s: WorkbenchState, key: SessionKey = s.activeKey) => s.sets[key]!;
const root = (s: WorkbenchState, key?: SessionKey) => activeTabOf(set(s, key))!.root;
const kinds = (s: WorkbenchState, key?: SessionKey) => visiblePaneIds(set(s, key)).map((id) => set(s, key).panes[id].kind);
/** The kind of each tab's first pane, in strip order. */
const tabKinds = (s: WorkbenchState, key?: SessionKey) => {
  const ts = set(s, key);
  return ts.order.map((id) => ts.panes[paneIdsOf(ts.tabs[id].root)[0]].kind);
};

describe("model", () => {
  it("names sessions: home, plan:<id>, launch:<id>", () => {
    expect(planKey("s1")).toBe("plan:s1");
    expect(launchKey("l1")).toBe("launch:l1");
    expect(sessionIdOf("plan:s1")).toBe("s1");
    expect(sessionIdOf("launch:l1")).toBeNull();
    for (const ok of ["home", "plan:s1", "launch:l1"]) expect(isSessionKey(ok)).toBe(true);
    for (const bad of ["plan:", "launch:", "nope", 3, null]) expect(isSessionKey(bad)).toBe(false);
  });

  it("normalizes weights to a positive sum of 1, or an even split when unusable", () => {
    expect(normalizeWeights([1, 3], 2)).toEqual([0.25, 0.75]);
    expect(normalizeWeights([1, -3], 2)).toEqual([0.5, 0.5]);
    expect(normalizeWeights([1], 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(normalizeWeights([], 0)).toEqual([]);
  });

  it("walks a tree in reading order", () => {
    const tree: LayoutNode = {
      split: true,
      direction: "row",
      children: [{ pane: "a" }, { split: true, direction: "column", children: [{ pane: "b" }, { pane: "c" }], weights: [0.5, 0.5] }],
      weights: [0.5, 0.5],
    };
    expect(paneIdsOf(tree)).toEqual(["a", "b", "c"]);
    expect(isSplit(tree)).toBe(true);
  });

  it("gives a singleton to one visible pane: the one asked for, else the focused, else the first", () => {
    const browser: PaneInit = { kind: "browser", data: { workspace: "regular" } };
    let s = home(browser);
    s = reduce(s, { type: "splitPane", paneId: "p1", direction: "row", pane: browser, newPaneId: "b" });
    expect(singletonHolder(s, "browser", null)).toBe("b");
    expect(singletonHolder(s, "browser", "p1")).toBe("p1");
    s = reduce(s, { type: "splitPane", paneId: "b", direction: "row", pane: file("/a"), newPaneId: "f" });
    expect(singletonHolder(s, "browser", null)).toBe("p1");
    expect(singletonHolder(s, "browser", "b")).toBe("b");
    expect(singletonHolder(s, "browser", "gone")).toBe("p1");
    expect(singletonHolder(s, "plan", null)).toBeUndefined();
    s = reduce(s, { type: "openTab", pane: file("/b"), tabId: "t2", paneId: "x" });
    expect(singletonHolder(s, "browser", "b")).toBeUndefined();
  });

  it("titles panes from their data unless overridden", () => {
    const p = (pane: AnyPane) => paneTitle(pane);
    expect(p({ id: "x", kind: "plan", data: { sessionId: "s", version: 3 } })).toBe("Plan v3");
    expect(p({ id: "x", kind: "file", data: { path: "/a/b/c.ts" } })).toBe("c.ts");
    expect(p({ id: "x", kind: "chat", data: { source: "agent", terminalId: "t", sessionId: null } })).toBe("Agent");
    expect(p({ id: "x", kind: "servers", data: {}, titleOverride: "Ports" })).toBe("Ports");
  });
});

describe("defaults", () => {
  it("Home always has a door; the first one shares the Front Door's sentence", () => {
    const s = reduce(emptyWorkbench(), { type: "ensureDefaults", key: HOME_KEY });
    expect(kinds(s)).toEqual(["door"]);
    const pane = set(s).panes[visiblePaneIds(set(s))[0]];
    expect(pane.kind === "door" && pane.data.draftKey).toBe(DEFAULT_DOOR_DRAFT_KEY);
    expect(doorDraftKey("p9")).toBe("redline.workbench.door.p9");
  });

  it("a plan session opens on [Plan] + [Agent] when bound + [Terminals] when it owns shells", () => {
    const bare = reduce(emptyWorkbench(), { type: "selectSession", key: "plan:s1" });
    expect(set(bare).order).toHaveLength(1);
    expect(kinds(bare)).toEqual(["plan"]);

    let s: WorkbenchState = { ...emptyWorkbench(), owners: { sh1: "plan:s2", sh2: "plan:s2", other: "home" } };
    s = reduce(s, { type: "selectSession", key: "plan:s2", defaults: { agentTerminalId: "ag" } });
    expect(tabKinds(s)).toEqual(["plan", "chat", "terminals"]);
    expect(set(s).activeTabId).toBe(set(s).order[0]);
    const wallPane = Object.values(set(s).panes).find((p) => p.kind === "terminals")!;
    expect(wallPane.kind === "terminals" && wallPane.data.tiles).toEqual(["sh1", "sh2"]);
    expect(s.owners.ag).toBe("plan:s2");
    expect(s.activeKey).toBe("plan:s2");
    expect(s.mru[0]).toBe("plan:s2");
  });

  it("a launch opens on [Agent] once its terminal is known, and an agent binding later joins the strip unactivated", () => {
    const empty = reduce(emptyWorkbench(), { type: "selectSession", key: "launch:l1" });
    expect(set(empty).order).toEqual([]);
    const s = reduce(empty, { type: "ensureDefaults", key: "launch:l1", defaults: { agentTerminalId: "t1" } });
    expect(kinds(s, "launch:l1")).toEqual(["chat"]);

    let p = reduce(emptyWorkbench(), { type: "selectSession", key: "plan:s1" });
    p = reduce(p, { type: "openTab", pane: file("/x"), tabId: "f" });
    p = reduce(p, { type: "ensureDefaults", key: "plan:s1", defaults: { agentTerminalId: "t9" } });
    expect(set(p).order).toHaveLength(3);
    expect(set(p).activeTabId).toBe("f");
    // Idempotent: the same terminal never gets a second tab.
    expect(reduce(p, { type: "ensureDefaults", key: "plan:s1", defaults: { agentTerminalId: "t9" } })).toBe(p);
  });
});

describe("defaults are filled once per set", () => {
  const agentTabs = (s: WorkbenchState, key: SessionKey) =>
    Object.values(set(s, key).panes).filter((p) => p.kind === "chat" && p.data.source === "agent");
  const agentTabId = (s: WorkbenchState, key: SessionKey) =>
    set(s, key).order.find((id) => set(s, key).panes[set(s, key).tabs[id].focusedPaneId]?.kind === "chat")!;

  it("an Agent tab the user closed stays closed through every later session switch and terminal-list change", () => {
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "plan:s1", defaults: { agentTerminalId: "t1" } });
    expect(agentTabs(s, "plan:s1")).toHaveLength(1);
    expect(set(s, "plan:s1").agentsFilled).toEqual(["t1"]);
    s = reduce(s, { type: "closeTab", key: "plan:s1", tabId: agentTabId(s, "plan:s1") });
    expect(agentTabs(s, "plan:s1")).toHaveLength(0);
    // App dispatches these on every terminal-list change and session switch.
    const closed = s;
    s = reduce(s, { type: "ensureDefaults", key: "plan:s1", defaults: { agentTerminalId: "t1" } });
    expect(s).toBe(closed);
    s = reduce(s, { type: "selectSession", key: HOME_KEY });
    s = reduce(s, { type: "selectSession", key: "plan:s1", defaults: { agentTerminalId: "t1" } });
    expect(agentTabs(s, "plan:s1")).toHaveLength(0);
  });

  it("reopening it is the user's: openSurface brings the Agent tab back, and it is not filled twice", () => {
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "plan:s1", defaults: { agentTerminalId: "t1" } });
    s = reduce(s, { type: "closeTab", key: "plan:s1", tabId: agentTabId(s, "plan:s1") });
    s = reduce(s, { type: "openSurface", kind: "chat", key: "plan:s1", data: { source: "agent", terminalId: "t1", sessionId: "s1" } });
    expect(agentTabs(s, "plan:s1")).toHaveLength(1);
    s = reduce(s, { type: "ensureDefaults", key: "plan:s1", defaults: { agentTerminalId: "t1" } });
    expect(agentTabs(s, "plan:s1")).toHaveLength(1);
  });

  it("a NEW agent terminal binding for the first time still gets its tab", () => {
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "plan:s1", defaults: { agentTerminalId: "t1" } });
    s = reduce(s, { type: "closeTab", key: "plan:s1", tabId: agentTabId(s, "plan:s1") });
    s = reduce(s, { type: "ensureDefaults", key: "plan:s1", defaults: { agentTerminalId: "t2" } });
    expect(agentTabs(s, "plan:s1").map((p) => p.kind === "chat" && p.data.source === "agent" && p.data.terminalId)).toEqual(["t2"]);
    expect(set(s, "plan:s1").agentsFilled).toEqual(["t1", "t2"]);
  });

  it("a resume into a fresh PTY moves the session's Agent pane onto it: one Agent tab, however many resumes", () => {
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "plan:s1", defaults: { agentTerminalId: "t1" } });
    const tab = agentTabId(s, "plan:s1");
    for (const pty of ["t2", "t3", "t4"]) s = reduce(s, { type: "ensureDefaults", key: "plan:s1", defaults: { agentTerminalId: pty } });
    const agents = agentTabs(s, "plan:s1");
    expect(agents).toHaveLength(1);
    expect(agents[0].kind === "chat" && agents[0].data.source === "agent" && agents[0].data.terminalId).toBe("t4");
    expect(agentTabId(s, "plan:s1")).toBe(tab);
    expect(set(s, "plan:s1").agentsFilled).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("a set that empties refills its Plan without the closed agent; a launch refills with its Agent", () => {
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "plan:s1", defaults: { agentTerminalId: "t1" } });
    s = reduce(s, { type: "closeTab", key: "plan:s1", tabId: agentTabId(s, "plan:s1") });
    s = reduce(s, { type: "closeTab", key: "plan:s1", tabId: set(s, "plan:s1").order[0] });
    s = reduce(s, { type: "ensureDefaults", key: "plan:s1", defaults: { agentTerminalId: "t1" } });
    expect(kinds(s, "plan:s1")).toEqual(["plan"]);
    expect(agentTabs(s, "plan:s1")).toHaveLength(0);

    let l = reduce(emptyWorkbench(), { type: "selectSession", key: "launch:l1", defaults: { agentTerminalId: "t5" } });
    l = reduce(l, { type: "closeTab", key: "launch:l1", tabId: set(l, "launch:l1").order[0] });
    expect(agentTabs(l, "launch:l1")).toHaveLength(1);
  });

  it("the marker survives the launch becoming its plan", () => {
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "launch:l1", defaults: { agentTerminalId: "t5" } });
    s = reduce(s, { type: "selectSession", key: "plan:s1" });
    s = reduce(s, { type: "rekeySession", from: "launch:l1", to: "plan:s1" });
    expect(set(s, "plan:s1").agentsFilled).toContain("t5");
  });
});

describe("tabs", () => {
  it("opens, selects, cycles, reorders", () => {
    let s = home(door(1), file("/a"), file("/b"));
    expect(set(s).order).toEqual(["t1", "t2", "t3"]);
    expect(set(s).activeTabId).toBe("t3");
    s = reduce(s, { type: "selectTab", tabId: "t1" });
    expect(set(s).activeTabId).toBe("t1");
    s = reduce(s, { type: "cycleTab", delta: -1 });
    expect(set(s).activeTabId).toBe("t3");
    s = reduce(s, { type: "cycleTab", delta: 1 });
    expect(set(s).activeTabId).toBe("t1");
    s = reduce(s, { type: "selectTabIndex", index: -1 });
    expect(set(s).activeTabId).toBe("t3");
    s = reduce(s, { type: "selectTabIndex", index: 8 });
    expect(set(s).activeTabId).toBe("t3");
    s = reduce(s, { type: "selectTabIndex", index: 1 });
    expect(set(s).activeTabId).toBe("t2");
    s = reduce(s, { type: "reorderTab", tabId: "t3", to: 0 });
    expect(set(s).order).toEqual(["t3", "t1", "t2"]);
    s = reduce(s, { type: "openTab", pane: file("/c"), tabId: "t4", at: 1, activate: false });
    expect(set(s).order).toEqual(["t3", "t4", "t1", "t2"]);
    expect(set(s).activeTabId).toBe("t2");
    // Unknown targets leave the state object alone.
    expect(reduce(s, { type: "selectTab", tabId: "nope" })).toBe(s);
  });

  it("closes to the neighbour, remembers up to ten, and reopens in place", () => {
    let s = home(door(1), file("/a"), file("/b"));
    s = reduce(s, { type: "selectTab", tabId: "t2" });
    s = reduce(s, { type: "closeTab", tabId: "t2" });
    expect(set(s).order).toEqual(["t1", "t3"]);
    expect(set(s).activeTabId).toBe("t3");
    expect(set(s).panes.p2).toBeUndefined();
    expect(set(s).closed).toHaveLength(1);
    s = reduce(s, { type: "reopenClosed" });
    expect(set(s).order).toEqual(["t1", "t2", "t3"]);
    expect(set(s).activeTabId).toBe("t2");
    expect(set(s).panes.p2.kind).toBe("file");
    expect(set(s).closed).toHaveLength(0);
    expect(reduce(s, { type: "reopenClosed" })).toBe(s);

    for (let i = 0; i < CLOSED_CAP + 3; i++) {
      s = reduce(s, { type: "openTab", pane: file(`/n${i}`), tabId: `n${i}` });
      s = reduce(s, { type: "closeTab", tabId: `n${i}` });
    }
    expect(set(s).closed).toHaveLength(CLOSED_CAP);
    expect(set(s).closed[CLOSED_CAP - 1].tab.id).toBe(`n${CLOSED_CAP + 2}`);
  });

  it("closing the last tab on Home grows a door back; on a plan, its Plan; on a launch, its Agent", () => {
    let s = home(file("/a"));
    s = reduce(s, { type: "closeTab", tabId: "t1" });
    expect(kinds(s)).toEqual(["door"]);
    let p = reduce(emptyWorkbench(), { type: "selectSession", key: "plan:s1" });
    p = reduce(p, { type: "closeTab", tabId: set(p).order[0] });
    expect(kinds(p)).toEqual(["plan"]);
    let l = reduce(emptyWorkbench(), { type: "selectSession", key: "launch:l1", defaults: { agentTerminalId: "t1" } });
    l = reduce(l, { type: "closeTab", tabId: set(l).order[0] });
    expect(kinds(l)).toEqual(["chat"]);
    const agent = set(l).panes[activeTabOf(set(l))!.focusedPaneId];
    expect(agent.kind === "chat" && agent.data).toEqual({ source: "agent", terminalId: "t1", sessionId: null });
    expect(set(l).activeTabId).not.toBeNull();
  });
});

describe("splits", () => {
  it("splits beside a pane, grows a same-direction split n-ary, wraps the other way", () => {
    let s = home(door(1));
    s = reduce(s, { type: "splitPane", paneId: "p1", direction: "row", pane: file("/a"), newPaneId: "a" });
    expect(root(s)).toEqual({ split: true, direction: "row", children: [{ pane: "p1" }, { pane: "a" }], weights: [0.5, 0.5] });
    expect(activeTabOf(set(s))!.focusedPaneId).toBe("a");
    s = reduce(s, { type: "splitPane", paneId: "a", direction: "row", pane: file("/b"), newPaneId: "b" });
    const r = root(s);
    expect(isSplit(r) && r.children.length).toBe(3);
    expect(isSplit(r) && r.weights).toEqual([0.5, 0.25, 0.25]);
    s = reduce(s, { type: "splitPane", paneId: "b", direction: "column", pane: file("/c"), newPaneId: "c", before: true });
    expect(paneIdsOf(root(s))).toEqual(["p1", "a", "c", "b"]);
    const r2 = root(s);
    expect(isSplit(r2) && isSplit(r2.children[2]) && r2.children[2].direction).toBe("column");
  });

  it("closing a pane collapses its split; the last pane closes the tab", () => {
    let s = home(door(1));
    s = reduce(s, { type: "splitPane", paneId: "p1", direction: "row", pane: file("/a"), newPaneId: "a" });
    s = reduce(s, { type: "splitPane", paneId: "a", direction: "column", pane: file("/b"), newPaneId: "b" });
    s = reduce(s, { type: "closePane", paneId: "b" });
    expect(root(s)).toEqual({ split: true, direction: "row", children: [{ pane: "p1" }, { pane: "a" }], weights: [0.5, 0.5] });
    expect(activeTabOf(set(s))!.focusedPaneId).toBe("a");
    s = reduce(s, { type: "closePane", paneId: "a" });
    expect(root(s)).toEqual({ pane: "p1" });
    expect(activeTabOf(set(s))!.focusedPaneId).toBe("p1");
    s = reduce(s, { type: "openTab", pane: file("/z"), tabId: "z" });
    s = reduce(s, { type: "closePane", paneId: "p1" });
    expect(set(s).order).toEqual(["z"]);
    expect(set(s).closed).toHaveLength(1);
  });

  it("resizes by path, equalizes everywhere, and focuses the neighbour pane by direction", () => {
    let s = home(door(1));
    s = reduce(s, { type: "splitPane", paneId: "p1", direction: "row", pane: file("/a"), newPaneId: "a" });
    s = reduce(s, { type: "splitPane", paneId: "a", direction: "column", pane: file("/b"), newPaneId: "b" });
    s = reduce(s, { type: "resizeSplit", path: [], weights: [3, 1] });
    expect(isSplit(root(s)) && (root(s) as { weights: number[] }).weights).toEqual([0.75, 0.25]);
    s = reduce(s, { type: "resizeSplit", path: [1], weights: [1, 4] });
    const inner = (root(s) as { children: LayoutNode[] }).children[1] as { weights: number[] };
    expect(inner.weights).toEqual([0.2, 0.8]);
    expect(reduce(s, { type: "resizeSplit", path: [0], weights: [1] })).toBe(s);
    expect(reduce(s, { type: "resizeSplit", path: [], weights: [1, 2, 3] })).toBe(s);
    s = reduce(s, { type: "equalize" });
    expect((root(s) as { weights: number[] }).weights).toEqual([0.5, 0.5]);
    expect(((root(s) as { children: LayoutNode[] }).children[1] as { weights: number[] }).weights).toEqual([0.5, 0.5]);

    const tree = root(s);
    expect(neighbourPane(tree, "p1", "right")).toBe("a");
    expect(neighbourPane(tree, "b", "left")).toBe("p1");
    expect(neighbourPane(tree, "a", "down")).toBe("b");
    expect(neighbourPane(tree, "b", "up")).toBe("a");
    expect(neighbourPane(tree, "p1", "left")).toBeNull();
    expect(neighbourPane(tree, "p1", "down")).toBeNull();
    s = reduce(s, { type: "focusPane", paneId: "p1" });
    s = reduce(s, { type: "focusPane", dir: "right" });
    expect(activeTabOf(set(s))!.focusedPaneId).toBe("a");
    s = reduce(s, { type: "focusPane", dir: "down" });
    expect(activeTabOf(set(s))!.focusedPaneId).toBe("b");
    expect(reduce(s, { type: "focusPane", dir: "right" })).toBe(s);
  });
});

describe("any split tree (W5)", () => {
  /** p1 | (a / b): a row of the door and a column of two files. */
  function three(): WorkbenchState {
    let s = home(door(1));
    s = reduce(s, { type: "splitPane", paneId: "p1", direction: "row", pane: file("/a"), newPaneId: "a" });
    return reduce(s, { type: "splitPane", paneId: "a", direction: "column", pane: file("/b"), newPaneId: "b" });
  }
  const tab = (s: WorkbenchState) => activeTabOf(set(s))!;

  it("keeps every share at 10 % or more, through any resize", () => {
    expect(clampWeights([0.98, 0.01, 0.01]).every((w) => w >= MIN_SPLIT_SHARE - 1e-9)).toBe(true);
    expect(clampWeights([0.98, 0.01, 0.01]).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(clampWeights([0.5, 0.5])).toEqual([0.5, 0.5]);
    let s = three();
    s = reduce(s, { type: "resizeSplit", path: [], weights: [0.99, 0.01] });
    const w = (root(s) as { weights: number[] }).weights;
    expect(w[1]).toBeCloseTo(MIN_SPLIT_SHARE);
    expect(w[0]).toBeCloseTo(1 - MIN_SPLIT_SHARE);
    // The same weights again move nothing.
    expect(reduce(s, { type: "resizeSplit", path: [], weights: w })).toBe(s);
  });

  it("closing any pane collapses a split left with one child, at any depth", () => {
    let s = three();
    s = reduce(s, { type: "closePane", paneId: "a" });
    expect(root(s)).toEqual({ split: true, direction: "row", children: [{ pane: "p1" }, { pane: "b" }], weights: [0.5, 0.5] });
    s = reduce(s, { type: "closePane", paneId: "p1" });
    expect(root(s)).toEqual({ pane: "b" });
  });

  it("equalize evens every split of the tab, nested ones too", () => {
    let s = three();
    s = reduce(s, { type: "resizeSplit", path: [], weights: [0.8, 0.2] });
    s = reduce(s, { type: "resizeSplit", path: [1], weights: [0.3, 0.7] });
    s = reduce(s, { type: "equalize" });
    const r = root(s) as { weights: number[]; children: LayoutNode[] };
    expect(r.weights).toEqual([0.5, 0.5]);
    expect((r.children[1] as { weights: number[] }).weights).toEqual([0.5, 0.5]);
    // A tab of one pane has nothing to even.
    const one = home(door(1));
    expect(reduce(one, { type: "equalize" })).toBe(one);
  });

  it("zooms the focused pane of a split, and puts it back on the second ask", () => {
    let s = three();
    expect(tab(s).focusedPaneId).toBe("b");
    s = reduce(s, { type: "zoomPane" });
    expect(tab(s).zoomed).toBe("b");
    expect(shownPaneIds(tab(s))).toEqual(["b"]);
    expect(kinds(s)).toEqual(["file"]);
    s = reduce(s, { type: "zoomPane" });
    expect(tab(s).zoomed).toBeUndefined();
    expect(shownPaneIds(tab(s))).toEqual(["p1", "a", "b"]);
    // A tab of one pane does not zoom.
    const one = home(door(1));
    expect(reduce(one, { type: "zoomPane" })).toBe(one);
  });

  it("a zoom ends when focus moves, the tab splits, or the zoomed pane closes", () => {
    const zoomed = reduce(three(), { type: "zoomPane", paneId: "a" });
    expect(tab(zoomed).focusedPaneId).toBe("a");
    expect(tab(reduce(zoomed, { type: "focusPane", paneId: "p1" })).zoomed).toBeUndefined();
    expect(tab(reduce(zoomed, { type: "splitPane", paneId: "a", direction: "row", pane: door(2), newPaneId: "d" })).zoomed).toBeUndefined();
    expect(tab(reduce(zoomed, { type: "closePane", paneId: "a" })).zoomed).toBeUndefined();
    // Another tab's changes leave it zoomed.
    const other = reduce(zoomed, { type: "openTab", pane: door(3), tabId: "t9", paneId: "p9", activate: false });
    expect(other.sets.home!.tabs.t1.zoomed).toBe("a");
  });

  it("the singleton holder is the zoomed pane while the tab is zoomed", () => {
    let s = home(door(1));
    s = reduce(s, { type: "splitPane", paneId: "p1", direction: "row", pane: { kind: "browser", data: { workspace: "regular" } }, newPaneId: "b1" });
    s = reduce(s, { type: "splitPane", paneId: "b1", direction: "row", pane: { kind: "browser", data: { workspace: "regular" } }, newPaneId: "b2" });
    // "Bring here" asked for b1; b2 is zoomed: b2 holds, b1 is not on screen.
    s = reduce(s, { type: "zoomPane", paneId: "b2" });
    expect(singletonHolder(s, "browser", "b1")).toBe("b2");
    s = reduce(s, { type: "zoomPane" });
    expect(singletonHolder(s, "browser", "b1")).toBe("b1");
  });

  it("moves a pane out of its split into a tab of its own, just after, in front", () => {
    let s = three();
    s = reduce(s, { type: "openTab", pane: door(5), tabId: "t5", paneId: "p5", activate: false });
    s = reduce(s, { type: "movePaneToTab", paneId: "a", tabId: "m" });
    expect(set(s).order).toEqual(["t1", "m", "t5"]);
    expect(set(s).activeTabId).toBe("m");
    expect(set(s).tabs.m.root).toEqual({ pane: "a" });
    expect(set(s).tabs.t1.root).toEqual({ split: true, direction: "row", children: [{ pane: "p1" }, { pane: "b" }], weights: [0.5, 0.5] });
    expect(set(s).tabs.t1.focusedPaneId).toBe("b");
    expect(set(s).panes.a.kind).toBe("file");
    // A tab of one pane has nothing to move out of.
    expect(reduce(s, { type: "movePaneToTab", paneId: "a" })).toBe(s);
  });

  it("merges a dragged tab onto a pane's edge, its whole layout beside the pane", () => {
    let s = home(door(1), file("/x"));
    s = reduce(s, { type: "selectTab", tabId: "t1" });
    s = reduce(s, { type: "mergeTab", tabId: "t2", paneId: "p1", edge: "right" });
    expect(set(s).order).toEqual(["t1"]);
    expect(set(s).activeTabId).toBe("t1");
    expect(set(s).tabs.t1.root).toEqual({ split: true, direction: "row", children: [{ pane: "p1" }, { pane: "p2" }], weights: [0.5, 0.5] });
    expect(set(s).tabs.t1.focusedPaneId).toBe("p2");
    // Not remembered for ⌘⇧T: the tab is still open, merged.
    expect(set(s).closed).toHaveLength(0);
    // On the top edge of a pane in a row: that pane becomes a column.
    s = reduce(s, { type: "openTab", pane: file("/y"), tabId: "t3", paneId: "p3", activate: false });
    s = reduce(s, { type: "mergeTab", tabId: "t3", paneId: "p2", edge: "top" });
    expect(paneIdsOf(root(s))).toEqual(["p1", "p3", "p2"]);
    const r = root(s) as { children: LayoutNode[] };
    expect(isSplit(r.children[1]) && r.children[1].direction).toBe("column");
  });

  it("a merged row beside a pane of a row joins the row (n-ary), never a row in a row", () => {
    let s = home(door(1), door(2), door(3));
    s = reduce(s, { type: "mergeTab", tabId: "t3", intoTabId: "t2", edge: "right" });
    // t2 is now p2 | p3; merged on the left of t1's p1: one row of three.
    s = reduce(s, { type: "mergeTab", tabId: "t2", paneId: "p1", edge: "left" });
    const r = root(s) as { direction: string; children: LayoutNode[]; weights: number[] };
    expect(r.direction).toBe("row");
    expect(r.children).toEqual([{ pane: "p2" }, { pane: "p3" }, { pane: "p1" }]);
    expect(r.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(r.weights[2]).toBeCloseTo(0.5);
  });

  it("merging a tab into itself, or onto a pane it holds, does nothing", () => {
    const s = home(door(1), door(2));
    expect(reduce(s, { type: "mergeTab", tabId: "t1", paneId: "p1", edge: "left" })).toBe(s);
    expect(reduce(s, { type: "mergeTab", tabId: "t1", intoTabId: "t1", edge: "left" })).toBe(s);
    expect(reduce(s, { type: "mergeTab", tabId: "nope", paneId: "p1", edge: "left" })).toBe(s);
  });

  it("focus by direction follows the rendered boxes when they are given", () => {
    // ┌────┬────┐
    // │ p1 │ a  │
    // │    ├──┬─┤
    // │    │b │c│
    // └────┴──┴─┘
    const rects: Record<string, PaneRect> = {
      p1: { left: 0, top: 0, width: 500, height: 800 },
      a: { left: 506, top: 0, width: 500, height: 400 },
      b: { left: 506, top: 406, width: 300, height: 394 },
      c: { left: 812, top: 406, width: 194, height: 394 },
    };
    expect(geometricNeighbour(rects, "p1", "right")).toBe("a");
    expect(geometricNeighbour(rects, "c", "left")).toBe("b");
    expect(geometricNeighbour(rects, "b", "left")).toBe("p1");
    expect(geometricNeighbour(rects, "c", "up")).toBe("a");
    expect(geometricNeighbour(rects, "a", "down")).toBe("b");
    expect(geometricNeighbour(rects, "a", "up")).toBeNull();
    expect(geometricNeighbour(rects, "p1", "left")).toBeNull();
    expect(geometricNeighbour(rects, "missing", "left")).toBeNull();
    let s = three();
    s = reduce(s, { type: "splitPane", paneId: "b", direction: "row", pane: file("/c"), newPaneId: "c" });
    // From c, the tree says left is b; up, the tree's nearest column is a.
    s = reduce(s, { type: "focusPane", dir: "up", rects });
    expect(tab(s).focusedPaneId).toBe("a");
    s = reduce(s, { type: "focusPane", dir: "left", rects });
    expect(tab(s).focusedPaneId).toBe("p1");
    // Boxes for panes of another tab are ignored.
    expect(reduce(s, { type: "focusPane", dir: "right", rects: { p1: rects.p1, zz: rects.a } })).toBe(s);
  });
});

describe("previews and surfaces", () => {
  it("a preview is replaced in place until pinned; without one, a preview tab opens beside the active tab", () => {
    let s = home(door(1), file("/a"));
    s = reduce(s, { type: "selectTab", tabId: "t1" });
    s = reduce(s, { type: "replacePreview", pane: file("/one"), tabId: "pv", paneId: "pp" });
    expect(set(s).order).toEqual(["t1", "pv", "t2"]);
    expect(set(s).panes.pp.preview).toBe(true);
    s = reduce(s, { type: "replacePreview", pane: file("/two") });
    expect(set(s).order).toEqual(["t1", "pv", "t2"]);
    expect(set(s).panes.pp.data).toEqual({ path: "/two" });
    s = reduce(s, { type: "pinPane", paneId: "pp" });
    expect(set(s).panes.pp.preview).toBeUndefined();
    s = reduce(s, { type: "replacePreview", pane: file("/three"), tabId: "pv2" });
    expect(set(s).order).toEqual(["t1", "pv", "pv2", "t2"]);
  });

  it("openSurface without data never means the session's agent chat; a plan is the set's own session", () => {
    const agent: PaneInit = { kind: "chat", data: { source: "agent", terminalId: "t", sessionId: "s1" } };
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "plan:s1", defaults: { agentTerminalId: "t" } });
    s = reduce(s, { type: "openTab", pane: { kind: "file", data: { path: "/x" } }, tabId: "f" });
    // A chat surface is a companion room: with none open and no room named, nothing happens — the Agent tab is not it.
    expect(reduce(s, { type: "openSurface", kind: "chat" })).toBe(s);
    s = reduce(s, { type: "openTab", pane: { kind: "chat", data: { source: "companion", companionId: "c" } }, tabId: "room", activate: false });
    s = reduce(s, { type: "openSurface", kind: "chat" });
    expect(set(s).activeTabId).toBe("room");
    // "document" on a plan set is its Plan tab…
    s = reduce(s, { type: "openSurface", kind: "plan" });
    expect(set(s).activeTabId).toBe(set(s).order[0]);
    expect(set(s).panes[activeTabOf(set(s))!.focusedPaneId].kind).toBe("plan");
    // …and reopens one when it was closed.
    s = reduce(s, { type: "closeTab", tabId: set(s).order[0] });
    expect(tabKinds(s)).toEqual(["chat", "file", "chat"]);
    s = reduce(s, { type: "openSurface", kind: "plan", tabId: "again" });
    expect(set(s).activeTabId).toBe("again");
    expect(set(s).panes[activeTabOf(set(s))!.focusedPaneId].data).toEqual({ sessionId: "s1", version: null });
    // Home has no session: a plan surface without data is nothing to open.
    const h0 = home(agent);
    expect(reduce(h0, { type: "openSurface", kind: "plan" })).toBe(h0);
    expect(set(reduce(home(door(1)), { type: "openSurface", kind: "plan" })).order).toHaveLength(1);
  });

  it("openSurface brings an open pane forward in the current set, else opens a tab; a door is always new", () => {
    let s = home(door(1), { kind: "memory", data: {} });
    s = reduce(s, { type: "selectTab", tabId: "t1" });
    s = reduce(s, { type: "openSurface", kind: "memory" });
    expect(set(s).activeTabId).toBe("t2");
    expect(set(s).order).toHaveLength(2);
    s = reduce(s, { type: "openSurface", kind: "browser", tabId: "br" });
    expect(set(s).order).toEqual(["t1", "t2", "br"]);
    expect(set(s).panes[(set(s).tabs.br.root as { pane: string }).pane].data).toEqual({ workspace: "regular" });
    s = reduce(s, { type: "openSurface", kind: "file", data: { path: "/a" }, tabId: "fa" });
    s = reduce(s, { type: "openSurface", kind: "file", data: { path: "/b" }, tabId: "fb" });
    s = reduce(s, { type: "openSurface", kind: "file", data: { path: "/a" } });
    expect(set(s).activeTabId).toBe("fa");
    expect(set(s).order).toHaveLength(5);
    // Kinds that need data do nothing without it.
    expect(reduce(s, { type: "openSurface", kind: "drafter" })).toBe(s);
    s = reduce(s, { type: "openSurface", kind: "door", tabId: "d2", paneId: "dp" });
    expect(set(s).order).toHaveLength(6);
    expect(set(s).panes.dp.data).toEqual({ draftKey: doorDraftKey("dp") });
    expect(s.activeKey).toBe(HOME_KEY);
  });
});

describe("sessions", () => {
  it("rekeys a launch to its plan: the agent binds, the door becomes the Plan tab, owners and mru follow", () => {
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "launch:l1", defaults: { agentTerminalId: "t1" } });
    s = reduce(s, { type: "openTab", key: "launch:l1", pane: door(2), tabId: "dr", paneId: "dp" });
    s = reduce(s, { type: "rekeySession", from: "launch:l1", to: "plan:s9" });
    expect(s.sets["launch:l1"]).toBeUndefined();
    expect(s.activeKey).toBe("plan:s9");
    expect(s.mru).toEqual(["plan:s9", HOME_KEY]);
    expect(s.owners.t1).toBe("plan:s9");
    const ps = set(s, "plan:s9");
    expect(ps.panes.dp).toEqual({ id: "dp", kind: "plan", data: { sessionId: "s9", version: null } });
    const agent = Object.values(ps.panes).find((p) => p.kind === "chat")!;
    expect(agent.kind === "chat" && agent.data).toEqual({ source: "agent", terminalId: "t1", sessionId: "s9" });
    expect(ps.order).toHaveLength(2);
    expect(ps.activeTabId).toBe("dr");
  });

  it("converts exactly one door — the first in the strip — and leaves any other door a door", () => {
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "launch:l1", defaults: { agentTerminalId: "t1" } });
    s = reduce(s, { type: "openTab", pane: door(2), tabId: "d1", paneId: "dp1" });
    s = reduce(s, { type: "openTab", pane: door(3), tabId: "d2", paneId: "dp2" });
    s = reduce(s, { type: "reorderTab", tabId: "d2", to: 0 });
    s = reduce(s, { type: "rekeySession", from: "launch:l1", to: "plan:s1" });
    const ps = set(s, "plan:s1");
    expect(ps.panes.dp2.kind).toBe("plan");
    expect(ps.panes.dp1.kind).toBe("door");
    expect(tabKinds(s, "plan:s1")).toEqual(["plan", "chat", "door"]);
    expect(ps.activeTabId).toBe("d2");
  });

  it("D1: a launch with only an Agent tab gains a Plan tab first — selected when the user is on that set, left alone when they are elsewhere", () => {
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "launch:l1", defaults: { agentTerminalId: "t1" } });
    s = reduce(s, { type: "rekeySession", from: "launch:l1", to: "plan:s1", planTabId: "pt" });
    expect(tabKinds(s, "plan:s1")).toEqual(["plan", "chat"]);
    expect(set(s, "plan:s1").order[0]).toBe("pt");
    expect(set(s, "plan:s1").activeTabId).toBe("pt");

    let away = reduce(emptyWorkbench(), { type: "selectSession", key: "launch:l2", defaults: { agentTerminalId: "t2" } });
    const agentTab = set(away).activeTabId;
    away = reduce(away, { type: "selectSession", key: HOME_KEY });
    away = reduce(away, { type: "rekeySession", from: "launch:l2", to: "plan:s2" });
    expect(away.activeKey).toBe(HOME_KEY);
    expect(tabKinds(away, "plan:s2")).toEqual(["plan", "chat"]);
    expect(set(away, "plan:s2").activeTabId).toBe(agentTab);
  });

  it("selectSession keeps an already-active selection as the same state object", () => {
    const s = reduce(emptyWorkbench(), { type: "selectSession", key: HOME_KEY });
    expect(reduce(s, { type: "selectSession", key: HOME_KEY })).toBe(s);
  });
});

describe("terminals", () => {
  it("reveals a terminal on the wall that has it, else one with room, else a new Terminals tab, and navigates to its owner", () => {
    let s = home(door(1), wall(["a", "b"]));
    s = reduce(s, { type: "selectTab", tabId: "t1" });
    s = reduce(s, { type: "revealTerminal", ptyId: "b" });
    expect(set(s).activeTabId).toBe("t2");
    expect(set(s).panes.p2.data).toMatchObject({ focus: 1 });
    s = reduce(s, { type: "revealTerminal", ptyId: "c" });
    expect(set(s).panes.p2.data).toMatchObject({ tiles: ["a", "b", "c"], focus: 2 });
    expect(s.owners.c).toBe(HOME_KEY);

    let full = home(wall(Array.from({ length: MAX_WALL_TILES }, (_, i) => `x${i}`)));
    full = reduce(full, { type: "revealTerminal", ptyId: "y", tabId: "nt", paneId: "np" });
    expect(set(full).order).toEqual(["t1", "nt"]);
    expect(set(full).panes.np.data).toMatchObject({ tiles: ["y"] });

    let away: WorkbenchState = { ...home(door(1)), owners: { z: "plan:s1" }, stowed: ["z"] };
    away = reduce(away, { type: "revealTerminal", ptyId: "z" });
    expect(away.activeKey).toBe("plan:s1");
    expect(away.stowed).toEqual([]);
    expect(kinds(away)).toEqual(["terminals"]);
  });

  it("revealing under another key is an adoption: the tile leaves its old wall, so no PTY is on two walls", () => {
    let s = home(wall(["a", "b"]));
    s = { ...s, owners: { a: HOME_KEY, b: HOME_KEY } };
    s = reduce(s, { type: "revealTerminal", ptyId: "b", key: "plan:s1", tabId: "w", paneId: "wp" });
    expect(s.activeKey).toBe("plan:s1");
    expect(s.owners.b).toBe("plan:s1");
    expect(set(s, HOME_KEY).panes.p1.data).toMatchObject({ tiles: ["a"] });
    expect(set(s, "plan:s1").panes.wp.data).toMatchObject({ tiles: ["b"] });
    const walls = (Object.keys(s.sets) as SessionKey[]).flatMap((k) => Object.values(s.sets[k]!.panes)).filter((p) => p.kind === "terminals" && p.data.tiles.includes("b"));
    expect(walls).toHaveLength(1);
  });

  it("adopting moves ownership and the tile off every other wall", () => {
    let s = home(wall(["a", "b"]));
    s = { ...s, owners: { a: HOME_KEY, b: HOME_KEY } };
    s = reduce(s, { type: "selectSession", key: "plan:s1" });
    s = reduce(s, { type: "adoptTerminal", ptyId: "b", key: "plan:s1", tabId: "w", paneId: "wp" });
    expect(s.owners.b).toBe("plan:s1");
    expect(set(s, HOME_KEY).panes.p1.data).toMatchObject({ tiles: ["a"] });
    expect(set(s, "plan:s1").panes.wp.data).toMatchObject({ tiles: ["b"] });
    // The last tile leaving closes the wall (and its tab), with no closed entry.
    s = reduce(s, { type: "adoptTerminal", ptyId: "a", key: "plan:s1" });
    expect(set(s, HOME_KEY).order).toHaveLength(1);
    expect(kinds(s, HOME_KEY)).toEqual(["door"]);
    expect(set(s, HOME_KEY).closed).toHaveLength(0);
    expect(set(s, "plan:s1").panes.wp.data).toMatchObject({ tiles: ["b", "a"], focus: 1 });
  });

  it("setWall stores the wall the component holds, normalized, and is a no-op for the same wall", () => {
    let s = home(wall(["a", "b"]));
    s = reduce(s, { type: "setWall", paneId: "p1", data: { tiles: ["b", "a", "a"], focus: 9, zoomed: "gone", pinned: ["a", "x"] } });
    expect(set(s).panes.p1.data).toEqual({ tiles: ["b", "a"], focus: 1, zoomed: null, pinned: ["a"] });
    expect(reduce(s, { type: "setWall", paneId: "p1", data: { tiles: ["b", "a"], focus: 1, zoomed: null, pinned: ["a"] } })).toBe(s);
    expect(reduce(s, { type: "setWall", paneId: "nope", data: { tiles: ["z"], focus: 0, zoomed: null, pinned: [] } })).toBe(s);
  });

  it("a tile picked onto a wall leaves every other wall and belongs to this wall's set (one attachment per PTY)", () => {
    let s = home(wall(["a", "b"]));
    s = { ...s, owners: { a: HOME_KEY, b: HOME_KEY } };
    s = reduce(s, { type: "selectSession", key: "plan:s1" });
    s = reduce(s, { type: "openTab", pane: wall(["c"]), tabId: "w", paneId: "wp" });
    s = { ...s, owners: { ...s.owners, c: "plan:s1" }, stowed: ["b"] };
    s = reduce(s, { type: "setWall", paneId: "wp", data: { tiles: ["b", "c"], focus: 0, zoomed: null, pinned: [] } });
    expect(s.owners.b).toBe("plan:s1");
    expect(s.stowed).toEqual([]);
    expect(set(s, HOME_KEY).panes.p1.data).toMatchObject({ tiles: ["a"] });
    expect(set(s, "plan:s1").panes.wp.data).toMatchObject({ tiles: ["b", "c"] });
    // A wall emptied by the move closes; the set refills its default.
    s = reduce(s, { type: "setWall", paneId: "wp", data: { tiles: ["a", "b", "c"], focus: 0, zoomed: null, pinned: [] } });
    expect(kinds(s, HOME_KEY)).toEqual(["door"]);
  });

  it("closing a wall keeps its terminals running (stowed, still owned) or terminates them (owners forget them)", () => {
    let s = home(door(1), wall(["a", "b"]));
    s = { ...s, owners: { a: HOME_KEY, b: HOME_KEY } };
    const kept = reduce(s, { type: "closeWall", paneId: "p2", keep: true });
    expect(tabKinds(kept)).toEqual(["door"]);
    expect(set(kept).closed).toHaveLength(1);
    expect(kept.stowed).toEqual(["a", "b"]);
    expect(kept.owners).toEqual({ a: HOME_KEY, b: HOME_KEY });
    // A kept terminal comes back onto a wall on a click.
    const back = reduce(kept, { type: "revealTerminal", ptyId: "a" });
    expect(back.stowed).toEqual(["b"]);
    expect(kinds(back)).toEqual(["terminals"]);
    const gone = reduce(s, { type: "closeWall", paneId: "p2", keep: false });
    expect(gone.owners).toEqual({});
    expect(gone.stowed).toEqual([]);
    expect(reduce(s, { type: "closeWall", paneId: "p1", keep: true })).toBe(s);
  });

  it("closing the active tab returns to the tab shown before it, not its neighbour (an untouched door's Esc)", () => {
    let s = home(door(1), file("/a.ts"), file("/b.ts"));
    s = reduce(s, { type: "selectTab", tabId: "t1" });
    s = reduce(s, { type: "openTab", pane: door(2), tabId: "t4", paneId: "p4" });
    expect(set(s).activeTabId).toBe("t4");
    s = reduce(s, { type: "closeTab", tabId: "t4" });
    expect(set(s).activeTabId).toBe("t1");
    // The history follows the tabs: a closed one is forgotten, the next back is next.
    s = reduce(s, { type: "selectTab", tabId: "t3" });
    s = reduce(s, { type: "selectTab", tabId: "t2" });
    expect(set(s).recent).toEqual(["t3", "t1"]);
    s = reduce(s, { type: "closeTab", tabId: "t3" });
    s = reduce(s, { type: "closeTab", tabId: "t2" });
    expect(set(s).activeTabId).toBe("t1");
    expect(set(s).recent ?? []).toEqual([]);
  });

  it("⌘⇧T reopens a wall closed with Keep running, with the terminals it kept that still are", () => {
    let s = home(door(1), wall(["a", "b", "c"]));
    s = { ...s, owners: { a: HOME_KEY, b: HOME_KEY, c: HOME_KEY } };
    s = reduce(s, { type: "closeWall", paneId: "p2", keep: true });
    // Since: b went back onto a wall of its own; c exited (prune drops it).
    s = reduce(s, { type: "revealTerminal", ptyId: "b" });
    s = reduce(s, { type: "prune", liveSessions: [], livePtys: ["a", "b"] });
    s = reduce(s, { type: "reopenClosed" });
    const reopened = set(s).panes[set(s).tabs[set(s).activeTabId!].focusedPaneId];
    expect(reopened).toMatchObject({ kind: "terminals", data: { tiles: ["a"] } });
    expect(s.stowed).toEqual([]);
    expect(s.owners.a).toBe(HOME_KEY);
    // b stays where it was put back: one tile per terminal.
    expect(Object.values(set(s).panes).filter((p) => p.kind === "terminals" && p.data.tiles.includes("b"))).toHaveLength(1);
  });

  it("a kept wall whose terminals all went is skipped for the tab closed before it", () => {
    let s = home(door(1), file("/a.ts"), wall(["a"]));
    s = { ...s, owners: { a: HOME_KEY } };
    s = reduce(s, { type: "closeTab", tabId: "t2" });
    s = reduce(s, { type: "closeWall", paneId: "p3", keep: true });
    s = reduce(s, { type: "prune", liveSessions: [], livePtys: [] });
    s = reduce(s, { type: "reopenClosed" });
    expect(kinds(s)).toEqual(["file"]);
    expect(set(s).closed).toHaveLength(0);
  });

  it("a wall terminated is never remembered", () => {
    let s = home(door(1), wall(["a"]));
    s = reduce(s, { type: "closeWall", paneId: "p2", keep: false });
    expect(set(s).closed).toHaveLength(0);
  });

  it("a wall the component empties closes without a closed entry", () => {
    let s = home(door(1), wall(["a"]));
    s = reduce(s, { type: "setWall", paneId: "p2", data: { tiles: [], focus: 0, zoomed: null, pinned: [] } });
    expect(tabKinds(s)).toEqual(["door"]);
    expect(set(s).closed).toHaveLength(0);
  });

  it("prunes dead sessions, stale launches and dead ptys; live orphans go Home; an agent pane survives for the Restore notice", () => {
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "plan:gone", defaults: { agentTerminalId: "ag-gone" } });
    s = reduce(s, { type: "selectSession", key: "plan:kept", defaults: { agentTerminalId: "ag-kept" } });
    s = reduce(s, { type: "revealTerminal", ptyId: "sh-dead", key: "plan:kept" });
    s = reduce(s, { type: "revealTerminal", ptyId: "sh-live", key: "plan:kept" });
    s = reduce(s, { type: "selectSession", key: "launch:stale", defaults: { agentTerminalId: "lt-dead" } });
    s = reduce(s, { type: "selectSession", key: "launch:fresh", defaults: { agentTerminalId: "lt-live" } });
    s = { ...s, owners: { ...s.owners, orphan: "plan:gone" }, stowed: ["sh-stowed-dead"] };
    s = reduce(s, { type: "prune", liveSessions: ["kept"], livePtys: ["sh-live", "orphan", "lt-live"] });
    expect(Object.keys(s.sets).sort()).toEqual(["home", "launch:fresh", "plan:kept"]);
    expect(s.activeKey).toBe("launch:fresh");
    expect(s.mru).toEqual(["launch:fresh", "plan:kept", HOME_KEY]);
    expect(s.owners).toEqual({ "sh-live": "plan:kept", orphan: HOME_KEY, "lt-live": "launch:fresh" });
    expect(s.stowed).toEqual([]);
    const kept = set(s, "plan:kept");
    expect(tabKinds(s, "plan:kept")).toEqual(["plan", "chat", "terminals"]);
    const w = Object.values(kept.panes).find((p) => p.kind === "terminals")!;
    expect(w.kind === "terminals" && w.data.tiles).toEqual(["sh-live"]);
    expect(kinds(s, HOME_KEY)).toEqual(["door"]);
    // Nothing to prune → the same state object.
    const again = reduce(s, { type: "prune", liveSessions: ["kept"], livePtys: ["sh-live", "orphan", "lt-live"] });
    expect(again).toBe(s);
  });

  it("a wall whose every tile died closes, and the active selection falls back Home", () => {
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "plan:p" });
    s = reduce(s, { type: "revealTerminal", ptyId: "d1", key: "plan:p" });
    s = reduce(s, { type: "prune", liveSessions: [], livePtys: [] });
    expect(s.activeKey).toBe(HOME_KEY);
    expect(s.sets["plan:p"]).toBeUndefined();
    let h = home(wall(["d1"]));
    h = reduce(h, { type: "prune", liveSessions: [], livePtys: [] });
    expect(kinds(h)).toEqual(["door"]);
  });
});

// ── W1: renamePane and moveTab ──────────────────────────────────────────────

describe("renamePane", () => {
  it("sets a title of the user's own and an empty title clears it", () => {
    let s = reduce(emptyWorkbench(), { type: "openTab", key: "home", pane: { kind: "browser", data: { workspace: "regular" } }, tabId: "t", paneId: "p" });
    s = reduce(s, { type: "renamePane", key: "home", paneId: "p", title: "  Docs  " });
    expect(s.sets.home?.panes.p?.titleOverride).toBe("Docs");
    const same = reduce(s, { type: "renamePane", key: "home", paneId: "p", title: "Docs" });
    expect(same).toBe(s);
    s = reduce(s, { type: "renamePane", key: "home", paneId: "p", title: "" });
    expect(s.sets.home?.panes.p?.titleOverride).toBeUndefined();
  });
  it("is a no-op for an unknown pane", () => {
    const s = emptyWorkbench();
    expect(reduce(s, { type: "renamePane", paneId: "nope", title: "x" })).toBe(s);
  });
});

describe("moveTab", () => {
  it("carries a tab and its panes from one set to another, activating it there, and the empty source refills", () => {
    let s = reduce(emptyWorkbench(), { type: "ensureDefaults", key: "home", tabIds: ["home-door"], paneIds: ["door-1"] });
    s = reduce(s, { type: "moveTab", from: "home", to: "launch:L", tabId: "home-door" });
    expect(s.sets["launch:L"]?.order).toEqual(["home-door"]);
    expect(s.sets["launch:L"]?.activeTabId).toBe("home-door");
    expect(s.sets["launch:L"]?.panes["door-1"]?.kind).toBe("door");
    // Home refilled with a fresh door, and the moved tab is not on its ⌘⇧T stack.
    expect(s.sets.home?.order).toHaveLength(1);
    expect(s.sets.home?.order[0]).not.toBe("home-door");
    expect(s.sets.home?.closed).toHaveLength(0);
    // The moved door is what rekeySession turns into the Plan tab.
    s = reduce(s, { type: "rekeySession", from: "launch:L", to: "plan:S" });
    expect(s.sets["plan:S"]?.panes["door-1"]?.kind).toBe("plan");
  });
  it("is a no-op for a missing tab or the same set", () => {
    const s = reduce(emptyWorkbench(), { type: "ensureDefaults", key: "home", tabIds: ["t"], paneIds: ["p"] });
    expect(reduce(s, { type: "moveTab", from: "home", to: "home", tabId: "t" })).toBe(s);
    expect(reduce(s, { type: "moveTab", from: "home", to: "plan:S", tabId: "nope" })).toBe(s);
  });
});

describe("replacePane", () => {
  it("turns a pane into another kind in place, keeping its id, tab and focus", () => {
    let s = reduce(emptyWorkbench(), { type: "ensureDefaults", key: "home", tabIds: ["t"], paneIds: ["d"] });
    s = reduce(s, { type: "replacePane", key: "home", paneId: "d", pane: { kind: "browser", data: { workspace: "regular" } } });
    expect(s.sets.home?.panes.d).toEqual({ id: "d", kind: "browser", data: { workspace: "regular" } });
    expect(s.sets.home?.tabs.t?.focusedPaneId).toBe("d");
    expect(s.sets.home?.order).toEqual(["t"]);
  });
  it("is a no-op for an unknown pane", () => {
    const s = emptyWorkbench();
    expect(reduce(s, { type: "replacePane", paneId: "nope", pane: { kind: "servers", data: {} } })).toBe(s);
  });
});

describe("openFile (W4: the Files rail, ⌘P, file:line links)", () => {
  const focused = (s: WorkbenchState) => {
    const tab = activeTabOf(set(s))!;
    return set(s).panes[tab.focusedPaneId];
  };
  it("a plain click previews, and the next plain click replaces that preview", () => {
    let s = home(door());
    s = reduce(s, { type: "openFile", path: "/a.ts", mode: "preview" });
    expect(set(s).order.length).toBe(2);
    expect(focused(s)).toMatchObject({ kind: "file", preview: true, data: { path: "/a.ts" } });
    s = reduce(s, { type: "openFile", path: "/b.ts", mode: "preview" });
    expect(set(s).order.length).toBe(2);
    expect(focused(s)).toMatchObject({ kind: "file", preview: true, data: { path: "/b.ts" } });
  });
  it("clicking the shown file again (or a double-click) pins it; the next preview opens beside it", () => {
    let s = home(door());
    s = reduce(s, { type: "openFile", path: "/a.ts", mode: "preview" });
    s = reduce(s, { type: "openFile", path: "/a.ts", mode: "pin" });
    expect(focused(s).preview).toBeUndefined();
    s = reduce(s, { type: "openFile", path: "/b.ts", mode: "preview" });
    expect(set(s).order.length).toBe(3);
    // A pin of a file that is not open opens it pinned.
    s = reduce(s, { type: "openFile", path: "/c.ts", mode: "pin" });
    expect(focused(s)).toMatchObject({ data: { path: "/c.ts" } });
    expect(focused(s).preview).toBeUndefined();
  });
  it("⌘-click opens a pinned tab of its own, next to the current one", () => {
    let s = home(door(), door(2));
    s = reduce(s, { type: "selectTab", tabId: "t1" });
    s = reduce(s, { type: "openFile", path: "/a.ts", mode: "tab" });
    expect(set(s).order.indexOf(set(s).activeTabId!)).toBe(1);
    expect(focused(s).preview).toBeUndefined();
  });
  it("a file already open gets focus instead of a second pane, and a line scrolls it every time", () => {
    let s = home(file("/a.ts"), door());
    s = reduce(s, { type: "selectTab", tabId: "t2" });
    s = reduce(s, { type: "openFile", path: "/a.ts", mode: "preview" });
    expect(set(s).activeTabId).toBe("t1");
    expect(set(s).order.length).toBe(2);
    s = reduce(s, { type: "openFile", path: "/a.ts", mode: "preview", line: 12, at: 1 });
    expect(focused(s).data).toEqual({ path: "/a.ts", line: 12, at: 1 });
    const again = reduce(s, { type: "openFile", path: "/a.ts", mode: "preview", line: 12, at: 2 });
    expect(focused(again).data).toEqual({ path: "/a.ts", line: 12, at: 2 });
    // Nothing to do is identity.
    expect(reduce(s, { type: "openFile", path: "/a.ts", mode: "preview" })).toBe(s);
  });
  it("is pure: the reveal nonce is the caller's, never the clock's", () => {
    const s = reduce(home(door()), { type: "openFile", path: "/a.ts", mode: "preview", line: 3 });
    expect(focused(s).data).toEqual({ path: "/a.ts", line: 3 });
  });
});

describe("followAgent: a restored agent's Agent tabs follow it, in every set (last walk)", () => {
  const agent = (terminalId: string, sessionId: string | null): PaneInit => ({ kind: "chat", data: { source: "agent", terminalId, sessionId } });
  const agentsIn = (s: WorkbenchState, key: SessionKey) =>
    Object.values(s.sets[key]!.panes).flatMap((p) => (p.kind === "chat" && p.data.source === "agent" ? [`${p.data.terminalId}:${p.data.sessionId}`] : []));

  it("retargets the session's Agent pane in a set that is not its own (D29's sidebar tab)", () => {
    const s = home(door(), agent("old", "s1"), agent("other", "s2"));
    const next = reduce(s, { type: "followAgent", sessionId: "s1", terminalId: "new" });
    expect(agentsIn(next, HOME_KEY)).toEqual(["new:s1", "other:s2"]);
    // The same tab, now on the new terminal: nothing moves under the user.
    expect(next.sets[HOME_KEY]!.order).toEqual(s.sets[HOME_KEY]!.order);
    expect(next.sets[HOME_KEY]!.agentsFilled).toContain("new");
    // Already following: no change.
    expect(reduce(next, { type: "followAgent", sessionId: "s1", terminalId: "new" })).toBe(next);
  });

  it("drops a stale pane when its set already shows the new terminal, and leaves other sessions alone", () => {
    const s = home(agent("old", "s1"), agent("new", "s1"));
    const next = reduce(s, { type: "followAgent", sessionId: "s1", terminalId: "new" });
    expect(agentsIn(next, HOME_KEY)).toEqual(["new:s1"]);
    expect(reduce(s, { type: "followAgent", sessionId: "s9", terminalId: "new" })).toBe(s);
  });
});
