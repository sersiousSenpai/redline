// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { documentPlateMode } from "../lib/documentPlate";
import type { MainSurface } from "../lib/mainSurface";
import { HOME_KEY, emptyWorkbench, type PaneInit, type WorkbenchState } from "./model";
import { kindForSurface, legacyView, surfaceOf } from "./legacy";
import { reduce } from "./reducer";

const browser: PaneInit = { kind: "browser", data: { workspace: "regular" } };
const file = (path: string): PaneInit => ({ kind: "file", data: { path } });
const agent: PaneInit = { kind: "chat", data: { source: "agent", terminalId: "t", sessionId: "s1" } };
const room: PaneInit = { kind: "chat", data: { source: "companion", companionId: "c" } };

describe("legacyView", () => {
  it("an empty workbench reads as today's boot: the door, nothing pinned, no session", () => {
    expect(legacyView(emptyWorkbench())).toEqual({ mainSurface: "document", docPinned: false, activeId: null, activeFile: null, focusedKind: null, visibleKinds: [] });
    const home = reduce(emptyWorkbench(), { type: "ensureDefaults", key: HOME_KEY });
    expect(legacyView(home)).toMatchObject({ mainSurface: "document", docPinned: false, activeId: null, focusedKind: "door", visibleKinds: ["door"] });
  });

  it("a plan session alone is the document; with a surface beside it, that surface and docPinned", () => {
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "plan:s1", defaults: { agentTerminalId: "t" } });
    const v = legacyView(s);
    expect(v).toMatchObject({ mainSurface: "document", docPinned: false, activeId: "s1", focusedKind: "plan", visibleKinds: ["plan"] });
    const planId = s.sets["plan:s1"]!.tabs[s.sets["plan:s1"]!.order[0]].focusedPaneId;
    s = reduce(s, { type: "splitPane", paneId: planId, direction: "row", pane: browser, newPaneId: "b" });
    expect(legacyView(s)).toMatchObject({ mainSurface: "browser", docPinned: true, activeId: "s1", focusedKind: "browser", visibleKinds: ["plan", "browser"] });
    // Focus does not move the surface: clicking the plan half keeps the webview.
    s = reduce(s, { type: "focusPane", paneId: planId });
    expect(legacyView(s)).toMatchObject({ mainSurface: "browser", docPinned: true, focusedKind: "plan" });
  });

  it("the agent chat and a terminal wall are not surfaces; a companion room is the chat surface", () => {
    let s = reduce(emptyWorkbench(), { type: "openTab", pane: agent, tabId: "a" });
    expect(legacyView(s)).toMatchObject({ mainSurface: "document", docPinned: false, visibleKinds: ["chat"] });
    s = reduce(s, { type: "revealTerminal", ptyId: "sh" });
    expect(legacyView(s)).toMatchObject({ mainSurface: "document", docPinned: false, visibleKinds: ["terminals"] });
    s = reduce(s, { type: "openTab", pane: room, tabId: "r" });
    expect(legacyView(s)).toMatchObject({ mainSurface: "chat", docPinned: false });
    expect(surfaceOf({ id: "x", kind: "terminals", data: { tiles: [], focus: 0, zoomed: null, pinned: [] } })).toBeNull();
    expect(surfaceOf({ id: "x", kind: "runs", data: {} })).toBe("runs");
  });

  it("the active file is the focused file pane, else the tab's first; a surface tab has none", () => {
    let s = reduce(emptyWorkbench(), { type: "openTab", pane: file("/a"), tabId: "fa", paneId: "pa" });
    s = reduce(s, { type: "splitPane", paneId: "pa", direction: "row", pane: file("/b"), newPaneId: "pb" });
    expect(legacyView(s)).toMatchObject({ activeFile: "/b", focusedKind: "file", mainSurface: "document" });
    s = reduce(s, { type: "focusPane", paneId: "pa" });
    expect(legacyView(s).activeFile).toBe("/a");
    s = reduce(s, { type: "splitPane", paneId: "pa", direction: "column", pane: browser, newPaneId: "br" });
    expect(legacyView(s)).toMatchObject({ activeFile: "/a", mainSurface: "browser", docPinned: true, focusedKind: "browser" });
    s = reduce(s, { type: "openTab", pane: { kind: "memory", data: {} }, tabId: "m" });
    expect(legacyView(s)).toMatchObject({ activeFile: null, mainSurface: "memory", docPinned: false, visibleKinds: ["memory"] });
  });

  it("a launch is not a session: activeId stays null until the plan arrives", () => {
    let s = reduce(emptyWorkbench(), { type: "selectSession", key: "launch:l1", defaults: { agentTerminalId: "t1" } });
    expect(legacyView(s).activeId).toBeNull();
    s = reduce(s, { type: "rekeySession", from: "launch:l1", to: "plan:s9" });
    expect(legacyView(s).activeId).toBe("s9");
  });

  it("agrees with documentPlateMode on which face the plate wears", () => {
    const faces = (s: WorkbenchState) => {
      const v = legacyView(s);
      const sidebar = v.activeFile ? ({ kind: "folder", id: "f" } as const) : ({ kind: "sessions" } as const);
      return [documentPlateMode(sidebar, v.activeId, v.activeFile), v.focusedKind] as const;
    };
    expect(faces(reduce(emptyWorkbench(), { type: "ensureDefaults", key: HOME_KEY }))).toEqual(["door", "door"]);
    expect(faces(reduce(emptyWorkbench(), { type: "selectSession", key: "plan:s" }))).toEqual(["plan", "plan"]);
    expect(faces(reduce(emptyWorkbench(), { type: "openTab", pane: file("/x") }))).toEqual(["file", "file"]);
  });

  it("maps every surface App can select to a pane kind", () => {
    const surfaces: MainSurface[] = ["document", "browser", "drafter", "review", "servers", "memory", "runs", "chat"];
    expect(surfaces.map((s) => kindForSurface(s, "plan:s1"))).toEqual(["plan", "browser", "drafter", "review", "servers", "memory", "runs", "chat"]);
    expect(kindForSurface("document", HOME_KEY)).toBe("door");
    expect(kindForSurface("document", "launch:l")).toBe("door");
  });
});
