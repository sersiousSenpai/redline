// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { HOME_KEY, activeSessionOf, activeTabOf, emptyWorkbench, launchKey, paneIdsOf, planKey, type PaneInit, type SessionKey, type WorkbenchState } from "./model";
import { reduce } from "./reducer";
import { stageView } from "./view";

// D29: a sidebar row (or the palette, an arrival, ⌘⇧J) opens its session as
// a tab in the set on screen — focusing it when it is already there — and
// never switches the strip. The per-session sets stay the model behind the
// strip ("Open as workspace" is the old switch).

const door = (n = 1): PaneInit => ({ kind: "door", data: { draftKey: `d${n}` } });
const plan = (sessionId: string): PaneInit => ({ kind: "plan", data: { sessionId, version: null } });
const agent = (terminalId: string, sessionId: string | null): PaneInit => ({ kind: "chat", data: { source: "agent", terminalId, sessionId } });
const chat = (companionId: string): PaneInit => ({ kind: "chat", data: { source: "companion", companionId } });

function homeWithDoor(): WorkbenchState {
  return reduce(emptyWorkbench(), { type: "openTab", pane: door(), tabId: "door", paneId: "door-p" });
}
const strip = (s: WorkbenchState, key: SessionKey = s.activeKey) => {
  const set = s.sets[key]!;
  return set.order.map((tabId) => {
    const pane = set.panes[paneIdsOf(set.tabs[tabId].root)[0]];
    if (pane.kind === "plan") return `plan:${pane.data.sessionId}`;
    if (pane.kind === "chat") return pane.data.source === "agent" ? `agent:${pane.data.terminalId}${pane.data.sessionId ? `@${pane.data.sessionId}` : ""}` : `chat:${pane.data.companionId}`;
    return pane.kind;
  });
};
const front = (s: WorkbenchState) => {
  const set = s.sets[s.activeKey]!;
  const tab = activeTabOf(set)!;
  return set.panes[tab.focusedPaneId];
};

describe("opening a session's pane in the active set", () => {
  it("a plan row opens a Plan tab after the tab in front, in Home, without switching the strip", () => {
    let s = homeWithDoor();
    s = reduce(s, { type: "openInActive", pane: plan("s1"), tabId: "t-s1" });
    expect(s.activeKey).toBe(HOME_KEY);
    expect(strip(s)).toEqual(["door", "plan:s1"]);
    expect(s.sets[HOME_KEY]!.activeTabId).toBe("t-s1");
    // No set was made for it: the per-session set waits for "Open as workspace".
    expect(s.sets[planKey("s1")]).toBeUndefined();
    // It is the selected session from then on: a fresh Home's door is none,
    // and a set keeps the session it was last about, as a session's own set
    // always did (the door's plate is still the door).
    expect(stageView(emptyWorkbench()).activeId).toBeNull();
    expect(stageView(s).activeId).toBe("s1");
    s = reduce(s, { type: "selectTab", tabId: "door" });
    expect(stageView(s).activeId).toBe("s1");
    expect(stageView(s).focusedKind).toBe("door");
    // Its tab closed, it is none again.
    s = reduce(s, { type: "closeTab", tabId: "t-s1" });
    expect(stageView(s).activeId).toBeNull();
  });

  it("focuses the tab when the set already has it, whatever its version, and changes nothing when it is in front", () => {
    let s = homeWithDoor();
    s = reduce(s, { type: "openTab", pane: { kind: "plan", data: { sessionId: "s1", version: 3 } }, tabId: "old" });
    s = reduce(s, { type: "selectTab", tabId: "door" });
    const before = s.sets[HOME_KEY]!.order.length;
    s = reduce(s, { type: "openInActive", pane: plan("s1") });
    expect(s.sets[HOME_KEY]!.order).toHaveLength(before);
    expect(s.sets[HOME_KEY]!.activeTabId).toBe("old");
    expect(reduce(s, { type: "openInActive", pane: plan("s1") })).toBe(s);
  });

  it("a chat row and a launch row open their own tabs the same way", () => {
    let s = homeWithDoor();
    s = reduce(s, { type: "openInActive", pane: chat("c1") });
    s = reduce(s, { type: "openInActive", pane: agent("pty-l1", null) });
    expect(strip(s)).toEqual(["door", "chat:c1", "agent:pty-l1"]);
    // Again: the open ones come forward.
    s = reduce(s, { type: "openInActive", pane: chat("c1") });
    expect(front(s).kind === "chat" && front(s).data).toEqual({ source: "companion", companionId: "c1" });
    expect(strip(s)).toHaveLength(3);
    // An Agent pane matches by its terminal: the same agent bound since is
    // still the one tab.
    s = reduce(s, { type: "openInActive", pane: agent("pty-l1", "s9") });
    expect(strip(s)).toHaveLength(3);
  });

  it("opens in whichever set is on screen: a session opened as a workspace takes another session's plan as a tab", () => {
    let s = reduce(homeWithDoor(), { type: "selectSession", key: planKey("s1"), defaults: { agentTerminalId: "pty1" } });
    expect(strip(s)).toEqual(["plan:s1", "agent:pty1@s1"]);
    s = reduce(s, { type: "openInActive", pane: plan("s2"), tabId: "t-s2" });
    expect(s.activeKey).toBe(planKey("s1"));
    expect(strip(s)).toEqual(["plan:s1", "plan:s2", "agent:pty1@s1"]);
    expect(stageView(s).activeId).toBe("s2");
    // Its own Agent tab in front: the set's session again.
    s = reduce(s, { type: "selectTabIndex", index: 2 });
    expect(stageView(s).activeId).toBe("s1");
  });

  it("puts a Plan tab just before its own session's Agent tab when the set has one", () => {
    let s = homeWithDoor();
    s = reduce(s, { type: "openInActive", pane: agent("pty1", "s1"), tabId: "a1" });
    s = reduce(s, { type: "openInActive", pane: chat("c1") });
    s = reduce(s, { type: "openInActive", pane: plan("s1") });
    expect(strip(s)).toEqual(["door", "plan:s1", "agent:pty1@s1", "chat:c1"]);
  });

  it("an Agent tab is its session's while it is in front; a launch's is no session's yet", () => {
    let s = homeWithDoor();
    s = reduce(s, { type: "openInActive", pane: agent("pty-l", null) });
    expect(activeSessionOf(s)).toBeNull();
    s = reduce(s, { type: "openInActive", pane: agent("pty1", "s1") });
    expect(activeSessionOf(s)).toBe("s1");
    s = reduce(s, { type: "openInActive", pane: plan("s2") });
    expect(activeSessionOf(s)).toBe("s2");
    // Back on the launch's tab: the set is still about the last session shown.
    s = reduce(s, { type: "openInActive", pane: agent("pty-l", null) });
    expect(activeSessionOf(s)).toBe("s2");
  });
});

describe("a plan arriving (D1 under D29)", () => {
  /** A launch whose Agent tab was opened in Home from its sidebar row. */
  function launchInHome(lookingAtAgent: boolean): WorkbenchState {
    let s = homeWithDoor();
    s = reduce(s, { type: "ensureDefaults", key: launchKey("l1"), defaults: { agentTerminalId: "pty-l" } });
    s = reduce(s, { type: "openInActive", pane: agent("pty-l", null), tabId: "agent" });
    if (!lookingAtAgent) s = reduce(s, { type: "selectTab", tabId: "door" });
    return reduce(s, { type: "rekeySession", from: launchKey("l1"), to: planKey("s1") });
  }

  it("lands beside the Agent tab in the set on screen, in front when the Agent tab was", () => {
    const s = launchInHome(true);
    expect(s.activeKey).toBe(HOME_KEY);
    expect(strip(s)).toEqual(["door", "plan:s1", "agent:pty-l@s1"]);
    expect(front(s).kind).toBe("plan");
    expect(stageView(s).activeId).toBe("s1");
    // The session's own set exists behind the strip, for "Open as workspace".
    expect(s.sets[planKey("s1")]).toBeDefined();
    expect(s.sets[launchKey("l1")]).toBeUndefined();
  });

  it("lands without moving anything when the user is on another tab", () => {
    const s = launchInHome(false);
    expect(strip(s)).toEqual(["door", "plan:s1", "agent:pty-l@s1"]);
    expect(front(s).kind).toBe("door");
    // And a second open of it (the arrival's own setActiveId) only focuses it.
    const opened = reduce(s, { type: "openInActive", pane: plan("s1") });
    expect(strip(opened)).toEqual(strip(s));
    expect(front(opened).kind).toBe("plan");
  });

  it("the launch's own set still becomes the plan's, as before", () => {
    let s = reduce(homeWithDoor(), { type: "selectSession", key: launchKey("l1"), defaults: { agentTerminalId: "pty-l" } });
    s = reduce(s, { type: "rekeySession", from: launchKey("l1"), to: planKey("s1") });
    expect(s.activeKey).toBe(planKey("s1"));
    expect(strip(s)).toEqual(["plan:s1", "agent:pty-l@s1"]);
  });
});

describe("a session that leaves", () => {
  it("takes its Plan and Agent tabs out of every other set, and Home grows its door back", () => {
    let s = emptyWorkbench();
    s = reduce(s, { type: "openInActive", pane: plan("s1") });
    s = reduce(s, { type: "openInActive", pane: agent("pty1", "s1") });
    expect(strip(s)).toEqual(["plan:s1", "agent:pty1@s1"]);
    s = reduce(s, { type: "dropSessionPanes", sessionIds: ["s1"] });
    expect(strip(s)).toEqual(["door"]);
    // ⌘⇧T remembers them like any closed tab.
    expect(s.sets[HOME_KEY]!.closed.length).toBe(2);
  });

  it("prune closes a Plan tab whose session no longer exists, only when told which do", () => {
    let s = homeWithDoor();
    s = reduce(s, { type: "openInActive", pane: plan("gone") });
    s = reduce(s, { type: "openInActive", pane: plan("kept") });
    // The terminals' prune names sets, not sessions: it never touches panes.
    const terminalsOnly = reduce(s, { type: "prune", liveSessions: [], livePtys: [] });
    expect(strip(terminalsOnly)).toEqual(["door", "plan:gone", "plan:kept"]);
    s = reduce(s, { type: "prune", liveSessions: ["kept"], livePtys: [], knownSessions: ["kept"] });
    expect(strip(s)).toEqual(["door", "plan:kept"]);
  });
});

describe("App's routes all open in the set on screen", () => {
  const app = readFileSync("src/App.tsx", "utf8");
  const body = (from: string, to: string) => app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)));

  it("setActiveId opens the session's Plan tab and never selects its set; Home is Home's set", () => {
    const writer = body("const setActiveId = useCallback(", "const openSessionPane = useCallback(");
    expect(writer).toContain('wb.dispatch({ type: "openInActive", pane: { kind: "plan", data: { sessionId: value, version: null } } });');
    expect(writer).toContain('wb.dispatch({ type: "selectSession", key: HOME_KEY });');
    expect(writer).not.toMatch(/selectSession", key: value \? planKey/);
  });

  it("\"Open as workspace\" is the old switch, offered on a plan row's menu", () => {
    expect(body("const openWorkspace = useCallback(", "}, []);")).toContain('wb.dispatch({ type: "selectSession", key: planKey(sessionId)');
    expect(app).toContain("onOpenWorkspace: (sessionId: string) => openWorkspace(sessionId),");
    const menu = readFileSync("src/components/RowMenu.tsx", "utf8");
    expect(menu).toContain('...(act.workspace ? [{ label: "Open as workspace"');
    expect(readFileSync("src/components/SessionSidebar.tsx", "utf8")).toContain("workspace: onOpenWorkspace ? () => onOpenWorkspace(session.sessionId) : undefined,");
  });

  it("a launch row, a terminal row and a launch from a door open their Agent tab here", () => {
    const rows = body("onSelectTerminal: (sessionId: string, terminalId: string) => {", "onOpenWorkspace:");
    expect(rows).toContain('openSessionPane({ kind: "chat", data: { source: "agent", terminalId, sessionId } });');
    expect(rows).toContain('openSessionPane({ kind: "chat", data: { source: "agent", terminalId, sessionId: null } });');
    expect(rows).not.toContain("selectSession");
    const launch = body("// The workbench: the launch is a session from here", "if (run) {");
    expect(launch).toContain('wb.dispatch({ type: "replacePane", paneId: door.id, pane: agent });');
    expect(launch).not.toMatch(/selectSession|moveTab/);
  });

  it("a chat row and an alert open the room as a tab of its own, never in place of the door in front", () => {
    expect(app).toContain("onSelectChat: (id: string) => openChat(id, { inPlace: false }),");
    expect(app).toContain("openChat(target.companionId, { inPlace: false });");
    expect(body("const openChat = (id: string", "// A notification answered")).toContain('if (opts.inPlace === false) wb.dispatch({ type: "openInActive", pane });');
  });

  it("an arrival behind a surface lands its Plan tab without bringing it forward", () => {
    expect(app).toContain('wb.dispatch({ type: "openInActive", pane: { kind: "plan", data: { sessionId: payload.sessionId, version: null } }, activate: false });');
  });
});
