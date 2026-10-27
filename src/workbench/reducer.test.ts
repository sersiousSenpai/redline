// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  CLOSED_CAP,
  HOME_KEY,
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
  visiblePaneIds,
  type AnyPane,
  type LayoutNode,
  type PaneInit,
  type SessionKey,
  type WorkbenchState,
} from "./model";
import { DEFAULT_DOOR_DRAFT_KEY, doorDraftKey, neighbourPane, reduce } from "./reducer";

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
