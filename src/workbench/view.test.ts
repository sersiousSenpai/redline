// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { Surface } from "../config/workspace";
import { HOME_KEY, emptyWorkbench, type PaneInit, type SplitDirection, type WorkbenchState } from "./model";
import { reduce, type WorkbenchAction } from "./reducer";
import { findPane, focusedDoorDraftKey, kindForSurface, plateFace, selectFocusedDoorDestination, selectLayoutKey, selectStageView, selectVisibleCompanion, stageView, surfaceOfPane, tileOf } from "./view";

const browser: PaneInit = { kind: "browser", data: { workspace: "regular" } };
const file = (path: string): PaneInit => ({ kind: "file", data: { path } });
const agent: PaneInit = { kind: "chat", data: { source: "agent", terminalId: "t", sessionId: "s1" } };
const room: PaneInit = { kind: "chat", data: { source: "companion", companionId: "c" } };
const apply = (actions: readonly WorkbenchAction[], from: WorkbenchState = emptyWorkbench()) => actions.reduce(reduce, from);
const focusedId = (s: WorkbenchState) => s.sets[s.activeKey]!.tabs[s.sets[s.activeKey]!.activeTabId!].focusedPaneId;

/** Every surface a manifest can name, with the pane `selectSurface` opens. */
const SURFACE_PANES: ReadonlyArray<readonly [Exclude<Surface, "document">, PaneInit]> = [
  ["browser", browser],
  ["drafter", { kind: "drafter", data: { draftId: "d1" } }],
  ["review", { kind: "review", data: { repo: "/repo", source: "uncommitted" } }],
  ["servers", { kind: "servers", data: {} }],
  ["memory", { kind: "memory", data: {} }],
  ["chat", room],
];

describe("stageView", () => {
  it("an empty workbench is the document with nothing on screen; Home's defaults are its door", () => {
    expect(stageView(emptyWorkbench())).toEqual({ surface: "document", hasDocument: false, activeId: null, activeFile: null, focusedKind: null, visibleKinds: [] });
    const home = apply([{ type: "ensureDefaults", key: HOME_KEY }]);
    expect(stageView(home)).toEqual({ surface: "document", hasDocument: true, activeId: null, activeFile: null, focusedKind: "door", visibleKinds: ["door"] });
  });

  it("a plan session alone is the document; tiled beside a surface, the tab is that surface and still shows the plan", () => {
    let s = apply([{ type: "selectSession", key: "plan:s1", defaults: { agentTerminalId: "t" } }]);
    expect(stageView(s)).toMatchObject({ surface: "document", hasDocument: true, activeId: "s1", focusedKind: "plan", visibleKinds: ["plan"] });
    const planId = focusedId(s);
    s = reduce(s, { type: "splitPane", paneId: planId, direction: "row", pane: browser, newPaneId: "b" });
    expect(stageView(s)).toMatchObject({ surface: "browser", hasDocument: true, activeId: "s1", focusedKind: "browser", visibleKinds: ["plan", "browser"] });
    // Focus does not move the surface: clicking the plan half keeps the webview.
    s = reduce(s, { type: "focusPane", paneId: planId });
    expect(stageView(s)).toMatchObject({ surface: "browser", hasDocument: true, focusedKind: "plan" });
    expect(tileOf(s)).toMatchObject({ doc: { id: planId, kind: "plan" }, other: { id: "b", kind: "browser" } });
  });

  it.each(SURFACE_PANES)("the owner beside %s, in either direction, is a tile of that surface", (surface, pane) => {
    for (const direction of ["row", "column"] as SplitDirection[]) {
      for (const owner of ["home", "plan"] as const) {
        const base = owner === "home" ? apply([{ type: "ensureDefaults", key: HOME_KEY }]) : apply([{ type: "selectSession", key: "plan:s1" }]);
        const s = reduce(base, { type: "splitPane", paneId: focusedId(base), direction, pane, newPaneId: "x" });
        expect(stageView(s), `${owner} ${direction}`).toMatchObject({ surface, hasDocument: true, focusedKind: pane.kind });
        expect(tileOf(s)?.other.id).toBe("x");
      }
    }
  });

  it.each(SURFACE_PANES)("%s opened from Home is that surface alone, with no document beside it", (surface, pane) => {
    const s = reduce(apply([{ type: "ensureDefaults", key: HOME_KEY }]), { type: "openSurface", kind: pane.kind, data: pane.data });
    expect(stageView(s)).toEqual({ surface, hasDocument: false, activeId: null, activeFile: null, focusedKind: pane.kind, visibleKinds: [pane.kind] });
    expect(tileOf(s)).toBeNull();
  });

  it("the agent chat and a terminal wall are not surfaces; a companion room is the chat surface", () => {
    let s = apply([{ type: "openTab", pane: agent, tabId: "a" }]);
    expect(stageView(s)).toMatchObject({ surface: "document", hasDocument: false, visibleKinds: ["chat"] });
    s = reduce(s, { type: "revealTerminal", ptyId: "sh" });
    expect(stageView(s)).toMatchObject({ surface: "document", hasDocument: false, visibleKinds: ["terminals"] });
    s = reduce(s, { type: "openTab", pane: room, tabId: "r" });
    expect(stageView(s)).toMatchObject({ surface: "chat", hasDocument: false });
    expect(selectVisibleCompanion(s)).toBe("c");
    expect(surfaceOfPane({ id: "x", kind: "terminals", data: { tiles: [], focus: 0, zoomed: null, pinned: [] } })).toBeNull();
    expect(surfaceOfPane({ id: "x", kind: "servers", data: {} })).toBe("servers");
  });

  it("the active file is the focused file pane, else the tab's first; a surface tab has none", () => {
    let s = apply([{ type: "openTab", pane: file("/a"), tabId: "fa", paneId: "pa" }]);
    s = reduce(s, { type: "splitPane", paneId: "pa", direction: "row", pane: file("/b"), newPaneId: "pb" });
    expect(stageView(s)).toMatchObject({ activeFile: "/b", focusedKind: "file", surface: "document" });
    s = reduce(s, { type: "focusPane", paneId: "pa" });
    expect(stageView(s).activeFile).toBe("/a");
    s = reduce(s, { type: "openTab", pane: { kind: "memory", data: {} }, tabId: "m" });
    expect(stageView(s)).toMatchObject({ activeFile: null, surface: "memory", hasDocument: false, visibleKinds: ["memory"] });
  });

  it("a launch is not a session: activeId stays null until the plan arrives", () => {
    let s = apply([{ type: "selectSession", key: "launch:l1", defaults: { agentTerminalId: "t1" } }]);
    expect(stageView(s)).toMatchObject({ activeId: null, surface: "document", focusedKind: "chat" });
    s = reduce(s, { type: "rekeySession", from: "launch:l1", to: "plan:s9" });
    expect(stageView(s).activeId).toBe("s9");
  });

  it("hands back the same object for an unchanged state, a new one when it moves", () => {
    const s = apply([{ type: "ensureDefaults", key: HOME_KEY }]);
    expect(selectStageView(s)).toBe(selectStageView(s));
    const t = reduce(s, { type: "openSurface", kind: "servers" });
    expect(selectStageView(t)).not.toBe(selectStageView(s));
    expect(selectStageView(t).surface).toBe("servers");
  });
});

describe("the plate's face", () => {
  it("follows the focused document kind, else the selected plan, else the door", () => {
    const face = (s: WorkbenchState) => plateFace(stageView(s), stageView(s).activeId);
    expect(face(apply([{ type: "ensureDefaults", key: HOME_KEY }]))).toBe("door");
    expect(face(apply([{ type: "selectSession", key: "plan:s" }]))).toBe("plan");
    expect(face(apply([{ type: "openTab", pane: file("/x") }]))).toBe("file");
    // A plan beside a browser is the plan, whichever half has focus.
    let s = apply([{ type: "selectSession", key: "plan:s" }]);
    s = reduce(s, { type: "splitPane", paneId: focusedId(s), direction: "row", pane: browser, newPaneId: "b" });
    expect(face(s)).toBe("plan");
    // A door tab inside a session is the door.
    s = reduce(s, { type: "openSurface", kind: "door", data: { draftKey: "k", destination: "browser" }, paneId: "d" });
    expect(face(s)).toBe("door");
    expect(focusedDoorDraftKey(s, "fallback")).toBe("k");
    expect(selectFocusedDoorDestination(s)).toBe("browser");
    expect(focusedDoorDraftKey(apply([{ type: "selectSession", key: "plan:s" }]), "fallback")).toBe("fallback");
  });
});

describe("selectors", () => {
  it("maps every surface to a pane kind; the document is the plan, or the door with no session", () => {
    const surfaces: Surface[] = ["document", "browser", "drafter", "review", "servers", "memory", "chat"];
    expect(surfaces.map((s) => kindForSurface(s, "plan:s1"))).toEqual(["plan", "browser", "drafter", "review", "servers", "memory", "chat"]);
    expect(kindForSurface("document", HOME_KEY)).toBe("door");
    expect(kindForSurface("document", "launch:l")).toBe("door");
  });

  it("finds a kind in the active tab first, then the set's other tabs", () => {
    let s = apply([{ type: "ensureDefaults", key: HOME_KEY }]);
    s = reduce(s, { type: "openTab", pane: { kind: "memory", data: {} }, tabId: "m1", paneId: "mem" });
    s = reduce(s, { type: "openTab", pane: browser, tabId: "b1", paneId: "br" });
    expect(findPane(s, "memory")).toEqual({ tabId: "m1", pane: expect.objectContaining({ id: "mem" }) });
    expect(findPane(s, "browser")?.tabId).toBe("b1");
    expect(findPane(s, "review")).toBeNull();
  });

  it("the layout key moves with the set, the tab and the tree, and only then", () => {
    const s = apply([{ type: "selectSession", key: "plan:s1" }]);
    const k = selectLayoutKey(s);
    expect(selectLayoutKey(reduce(s, { type: "renamePane", paneId: focusedId(s), title: "x" }))).toBe(k);
    const split = reduce(s, { type: "splitPane", paneId: focusedId(s), direction: "row", pane: browser, newPaneId: "b" });
    expect(selectLayoutKey(split)).not.toBe(k);
    expect(selectLayoutKey(reduce(split, { type: "resizeSplit", path: [], weights: [0.3, 0.7] }))).not.toBe(selectLayoutKey(split));
  });
});
