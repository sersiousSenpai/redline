// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// W0 spike 1: `legacyView` against today's App states, as a table.
//
// Today the centre is described by five unrelated values — `mainSurface`
// (one of eight), `docPinnedPref`, `splitVertical`, `activeId` and
// `activeFile` — plus whether a launch is in flight. This file builds every
// reachable combination through the W0 reducer and pins what the adapter
// reads back, so W1 can swap the state under App's read sites and know
// which of them see the same values. Where the reducer cannot express a
// state it is an `it.todo` with the reason; where it can but the adapter
// answers differently from today by design, the case lives under
// "diverges from today" so the difference is pinned, not hidden.

import { describe, expect, it } from "vitest";

import type { MainSurface } from "../lib/mainSurface";
import { kindForSurface, legacyView, type LegacyView } from "./legacy";
import { HOME_KEY, emptyWorkbench, type PaneInit, type PaneKind, type SessionKey, type SplitDirection, type WorkbenchState } from "./model";
import { reduce, type WorkbenchAction } from "./reducer";

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Every value `mainSurface` can hold today except the document itself. */
const SURFACES: readonly Exclude<MainSurface, "document">[] = ["browser", "drafter", "review", "servers", "memory", "chat"];

/** What `selectSurface(s)` will carry once it dispatches `openSurface`: the
 *  kinds with no default data (drafter, review, chat) need it spelled out. */
function surfacePane(s: Exclude<MainSurface, "document">): PaneInit {
  switch (s) {
    case "browser":
      return { kind: "browser", data: { workspace: "regular" } };
    case "drafter":
      return { kind: "drafter", data: { draftId: "d1" } };
    case "review":
      return { kind: "review", data: { repo: "/repo", source: "uncommitted" } };
    case "chat":
      return { kind: "chat", data: { source: "companion", companionId: "c1" } };
    case "servers":
    case "memory":
      return { kind: s, data: {} };
  }
}

const file = (path: string): PaneInit => ({ kind: "file", data: { path } });

function apply(actions: readonly WorkbenchAction[], from: WorkbenchState = emptyWorkbench()): WorkbenchState {
  return actions.reduce(reduce, from);
}

/** The focused pane id of the active tab in `key` (or the active set). */
function focusedId(state: WorkbenchState, key: SessionKey = state.activeKey): string {
  const set = state.sets[key]!;
  return set.tabs[set.activeTabId!].focusedPaneId;
}

/** A session owner, as App reaches it today: Home, a plan with its agent
 *  terminal bound, a launch whose plan has not arrived, or a folder file. */
type Owner = "home" | "plan" | "launch" | "file";

function ownerState(owner: Owner): WorkbenchState {
  switch (owner) {
    case "home":
      return apply([{ type: "ensureDefaults", key: HOME_KEY }]);
    case "plan":
      return apply([{ type: "selectSession", key: "plan:s1", defaults: { agentTerminalId: "t1" } }]);
    case "launch":
      return apply([{ type: "selectSession", key: "launch:l1", defaults: { agentTerminalId: "t1" } }]);
    case "file":
      return apply([{ type: "openTab", pane: file("/src/a.ts"), paneId: "fa" }]);
  }
}

/** The adapter's answer for the owner alone: `mainSurface: "document"`. */
const OWNER_ALONE: Record<Owner, LegacyView> = {
  home: { mainSurface: "document", docPinned: false, activeId: null, activeFile: null, focusedKind: "door", visibleKinds: ["door"] },
  plan: { mainSurface: "document", docPinned: false, activeId: "s1", activeFile: null, focusedKind: "plan", visibleKinds: ["plan"] },
  // Today a launch shows the door's flight pill on the document plate with
  // no session selected. The reducer's launch set holds the agent's chat.
  launch: { mainSurface: "document", docPinned: false, activeId: null, activeFile: null, focusedKind: "chat", visibleKinds: ["chat"] },
  file: { mainSurface: "document", docPinned: false, activeId: null, activeFile: "/src/a.ts", focusedKind: "file", visibleKinds: ["file"] },
};

/** The document face each owner tiles beside a pinned surface. */
const DOC_KIND: Record<Exclude<Owner, "launch">, PaneKind> = { home: "door", plan: "plan", file: "file" };

// ── The table ──────────────────────────────────────────────────────────────

describe("legacyView: the owner alone is the document", () => {
  it.each(Object.keys(OWNER_ALONE) as Owner[])("%s", (owner) => {
    expect(legacyView(ownerState(owner))).toEqual(OWNER_ALONE[owner]);
  });

  it("a bare launch (terminal not yet bound) is an empty set: still the document, no session", () => {
    const s = apply([{ type: "selectSession", key: "launch:l0" }]);
    expect(legacyView(s)).toEqual({ mainSurface: "document", docPinned: false, activeId: null, activeFile: null, focusedKind: null, visibleKinds: [] });
  });
});

describe("legacyView: selectSurface(s) with the pin off opens the surface alone", () => {
  // Today: mainSurface = s, docPinned = false, activeId / activeFile untouched
  // by the switch — except activeFile, which today survives in sidebar state
  // and here belongs to the file's own tab (see "diverges from today").
  const owners: Owner[] = ["home", "plan", "launch"];
  const table = owners.flatMap((owner) => SURFACES.map((surface) => [owner, surface] as const));
  it.each(table)("%s → %s", (owner, surface) => {
    const pane = surfacePane(surface);
    const s = reduce(ownerState(owner), { type: "openSurface", kind: pane.kind, data: pane.data });
    expect(legacyView(s)).toEqual({
      mainSurface: surface,
      docPinned: false,
      activeId: OWNER_ALONE[owner].activeId,
      activeFile: null,
      focusedKind: pane.kind,
      visibleKinds: [pane.kind],
    });
  });

  it("the surfaces with default data open from a bare `kind`, the others need their data", () => {
    const home = ownerState("home");
    for (const kind of ["browser", "servers", "memory"] as const) {
      expect(legacyView(reduce(home, { type: "openSurface", kind })).mainSurface).toBe(kind);
    }
    // No default draft, repo or room: the reducer leaves the state alone, so
    // App's `selectSurface("drafter" | "review" | "chat")` must carry data.
    for (const kind of ["drafter", "review", "chat"] as const) {
      expect(reduce(home, { type: "openSurface", kind })).toBe(home);
    }
  });
});

describe("legacyView: selectSurface(s) with the pin on tiles the document beside the surface", () => {
  // Today: `SplitPane first={documentBody} second={surfaceBody}` for every
  // non-document surface, in either orientation (`splitVertical`). The
  // orientation is not an adapter field: both directions must read alike.
  const owners: Exclude<Owner, "launch">[] = ["home", "plan", "file"];
  const directions: SplitDirection[] = ["row", "column"];
  const table = owners.flatMap((owner) => SURFACES.flatMap((surface) => directions.map((dir) => [owner, surface, dir] as const)));
  it.each(table)("%s + %s, split %s", (owner, surface, dir) => {
    const base = ownerState(owner);
    const pane = surfacePane(surface);
    const s = reduce(base, { type: "splitPane", paneId: focusedId(base), direction: dir, pane, newPaneId: "sp" });
    expect(legacyView(s)).toEqual({
      mainSurface: surface,
      docPinned: true,
      activeId: OWNER_ALONE[owner].activeId,
      activeFile: OWNER_ALONE[owner].activeFile,
      focusedKind: pane.kind,
      visibleKinds: [DOC_KIND[owner], pane.kind],
    });
  });
});

describe("legacyView: mainSurface does not follow focus", () => {
  // Clicking the document half of a tile must not hide the surface: today
  // the tile stays (docPinned is a preference, not a focus). The adapter
  // reads the tab's non-document pane whichever half is focused.
  const owners: Exclude<Owner, "launch">[] = ["home", "plan", "file"];
  const table = owners.flatMap((owner) => SURFACES.map((surface) => [owner, surface] as const));
  it.each(table)("%s + %s, focus on the document half", (owner, surface) => {
    const base = ownerState(owner);
    const docId = focusedId(base);
    const pane = surfacePane(surface);
    let s = reduce(base, { type: "splitPane", paneId: docId, direction: "row", pane, newPaneId: "sp" });
    s = reduce(s, { type: "focusPane", paneId: docId });
    expect(legacyView(s)).toEqual({
      mainSurface: surface,
      docPinned: true,
      activeId: OWNER_ALONE[owner].activeId,
      activeFile: OWNER_ALONE[owner].activeFile,
      focusedKind: DOC_KIND[owner],
      visibleKinds: [DOC_KIND[owner], pane.kind],
    });
  });

  it("focus moved by direction, not id, reads the same", () => {
    const base = ownerState("plan");
    const planId = focusedId(base);
    let s = reduce(base, { type: "splitPane", paneId: planId, direction: "row", pane: surfacePane("browser"), newPaneId: "b" });
    s = reduce(s, { type: "focusPane", dir: "left" });
    expect(legacyView(s)).toMatchObject({ mainSurface: "browser", docPinned: true, focusedKind: "plan" });
    s = reduce(s, { type: "focusPane", dir: "right" });
    expect(legacyView(s)).toMatchObject({ mainSurface: "browser", docPinned: true, focusedKind: "browser" });
  });

  it("two surfaces in one tab: the first in reading order is mainSurface, whatever is focused", () => {
    const base = ownerState("plan");
    let s = reduce(base, { type: "splitPane", paneId: focusedId(base), direction: "row", pane: surfacePane("browser"), newPaneId: "b" });
    s = reduce(s, { type: "splitPane", paneId: "b", direction: "column", pane: surfacePane("servers"), newPaneId: "r" });
    expect(legacyView(s)).toMatchObject({ mainSurface: "browser", docPinned: true, focusedKind: "servers", visibleKinds: ["plan", "browser", "servers"] });
    s = reduce(s, { type: "splitPane", paneId: "b", direction: "column", pane: surfacePane("memory"), newPaneId: "m", before: true });
    expect(legacyView(s)).toMatchObject({ mainSurface: "memory", focusedKind: "memory", visibleKinds: ["plan", "memory", "browser", "servers"] });
  });
});

describe("legacyView: the way back to the document", () => {
  // Today `selectSurface("document")` from a surface tab lands on the plan /
  // the door. `kindForSurface` names the pane; `openSurface` brings the open
  // one forward.
  it.each(SURFACES)("plan: %s tab → selectSurface(document) brings the Plan tab forward", (surface) => {
    const pane = surfacePane(surface);
    let s = reduce(ownerState("plan"), { type: "openSurface", kind: pane.kind, data: pane.data });
    expect(legacyView(s).mainSurface).toBe(surface);
    s = reduce(s, { type: "openSurface", kind: kindForSurface("document", s.activeKey) });
    expect(legacyView(s)).toEqual(OWNER_ALONE.plan);
  });

  it("home: a browser tab → selectSurface(document) opens a NEW door (⌘T semantics), the old door stays", () => {
    let s = reduce(ownerState("home"), { type: "openSurface", kind: "browser" });
    s = reduce(s, { type: "openSurface", kind: kindForSurface("document", HOME_KEY) });
    expect(legacyView(s)).toMatchObject({ mainSurface: "document", docPinned: false, activeId: null, focusedKind: "door", visibleKinds: ["door"] });
    expect(s.sets.home!.order).toHaveLength(3);
  });

  it("a launch rekeyed to its plan while the user is on it (D1): the Plan tab lands at index 0 and is selected", () => {
    let s = reduce(ownerState("launch"), { type: "openSurface", kind: "browser" });
    expect(legacyView(s)).toMatchObject({ mainSurface: "browser", activeId: null });
    // No door was in the launch set (rekey would have turned it into the
    // plan), so rekey inserts a Plan tab at index 0 — and selects it, since
    // the plan arriving is what the user on this set was waiting for.
    s = reduce(s, { type: "rekeySession", from: "launch:l1", to: "plan:s9" });
    expect(legacyView(s)).toEqual({ ...OWNER_ALONE.plan, activeId: "s9" });
    expect(s.sets["plan:s9"]!.order.indexOf(s.sets["plan:s9"]!.activeTabId!)).toBe(0);
    // The browser tab is still there, at the end of the strip, with its kind.
    s = reduce(s, { type: "selectTabIndex", index: -1 });
    expect(legacyView(s)).toMatchObject({ mainSurface: "browser", activeId: "s9", docPinned: false });
  });

  it("a launch rekeyed while the user is elsewhere (D1): the Plan tab lands at index 0 without being selected", () => {
    let s = reduce(ownerState("launch"), { type: "openSurface", kind: "browser" });
    s = reduce(s, { type: "selectSession", key: HOME_KEY });
    s = reduce(s, { type: "rekeySession", from: "launch:l1", to: "plan:s9" });
    expect(legacyView(s)).toEqual(OWNER_ALONE.home);
    const set = s.sets["plan:s9"]!;
    expect(set.panes[set.tabs[set.order[0]].focusedPaneId].kind).toBe("plan");
    expect(set.order.indexOf(set.activeTabId!)).toBe(2);
    // Coming back finds the browser still showing; the usual way back finds the plan.
    s = reduce(s, { type: "selectSession", key: "plan:s9" });
    expect(legacyView(s)).toMatchObject({ mainSurface: "browser", activeId: "s9", docPinned: false });
    s = reduce(s, { type: "openSurface", kind: "plan" });
    expect(legacyView(s)).toEqual({ ...OWNER_ALONE.plan, activeId: "s9" });
  });
});

describe("legacyView: states App has that the stage does not have today", () => {
  // New states the adapter can be asked about. App must not misread them.
  it("the session's Agent tab active: no surface, no document on screen", () => {
    const s = ownerState("plan");
    const set = s.sets["plan:s1"]!;
    const agentTab = set.order.find((id) => set.panes[set.tabs[id].focusedPaneId].kind === "chat")!;
    const v = legacyView(reduce(s, { type: "selectTab", tabId: agentTab }));
    expect(v).toEqual({ mainSurface: "document", docPinned: false, activeId: "s1", activeFile: null, focusedKind: "chat", visibleKinds: ["chat"] });
  });

  it("a terminal wall tab active: reads as the document with nothing visible but terminals", () => {
    let s = ownerState("plan");
    s = reduce(s, { type: "revealTerminal", ptyId: "sh1", key: "plan:s1" });
    expect(legacyView(s)).toEqual({ mainSurface: "document", docPinned: false, activeId: "s1", activeFile: null, focusedKind: "terminals", visibleKinds: ["terminals"] });
  });

  it("closing the surface half of a tile returns to the document alone, pin off", () => {
    const base = ownerState("plan");
    let s = reduce(base, { type: "splitPane", paneId: focusedId(base), direction: "row", pane: surfacePane("browser"), newPaneId: "b" });
    s = reduce(s, { type: "closePane", paneId: "b" });
    expect(legacyView(s)).toEqual(OWNER_ALONE.plan);
  });
});

describe("legacyView: diverges from today (pinned so W1 sees it)", () => {
  it("selectSurface(document) from a pinned tile only moves focus: the tile stays, the surface stays", () => {
    // Today: setMainSurface("document") closes the tile (docPinnedPref is
    // kept for next time). Here `openSurface(plan)` finds the plan half and
    // focuses it; the adapter, which does not follow focus, still says
    // "browser" + pinned. W1 must close or detach the surface pane instead.
    const base = ownerState("plan");
    let s = reduce(base, { type: "splitPane", paneId: focusedId(base), direction: "row", pane: surfacePane("browser"), newPaneId: "b" });
    s = reduce(s, { type: "openSurface", kind: kindForSurface("document", s.activeKey) });
    expect(legacyView(s)).toMatchObject({ mainSurface: "browser", docPinned: true, focusedKind: "plan" });
  });

  it("activeFile is per tab: a browser tab in front of a file tab reads null, today it keeps the path", () => {
    // Today `activeFile` is folder-sidebar state and survives a surface
    // switch (handleOpenFile at App:3299 relies on it loading hidden behind
    // a surface). Effects keyed on it (App:3613, App:5156) will fire on a
    // tab switch after W1.
    let s = ownerState("file");
    s = reduce(s, { type: "openSurface", kind: "browser" });
    expect(legacyView(s)).toMatchObject({ mainSurface: "browser", activeFile: null, visibleKinds: ["browser"] });
    s = reduce(s, { type: "selectTabIndex", index: 0 });
    expect(legacyView(s)).toMatchObject({ mainSurface: "document", activeFile: "/src/a.ts" });
  });

  it("the companion chat is still a surface here; App:1593 would bounce it to the document", () => {
    // Today nothing selects "chat" and the boot migration rewrites it, so
    // the effect is a belt-and-braces guard. A companion chat PANE reports
    // "chat", which that guard would answer with selectSurface("document")
    // every time the tab is active. Pinned here; the guard goes in W1.
    const s = reduce(ownerState("plan"), { type: "openSurface", kind: "chat", data: { source: "companion", companionId: "c1" } });
    expect(legacyView(s).mainSurface).toBe("chat");
  });

  it.todo("docPinned on the document itself: today `docPinnedPref` can be true while mainSurface is document (the pin outlives the surface and tiles the NEXT surface); the reducer keeps no pin preference, openSurface always opens a tab, and docPinned is derived from the tab's shape");
  it.todo("splitVertical / splitRatio / splitDragging: not LegacyView fields; App:10378-10381 and the browserVisible gate at App:7469 read them directly, and the reducer holds direction + weights per split instead");
  it.todo("the launch's door: today a launch shows the door's flight pill on the plate (mainSurface document, docPinned pref applies); the W0 reducer's launch set holds only the agent chat, and no action moves the home door tab into the launch set (the doorLaunchRef handoff is W1), so launch + pinned surface cannot be built");
  it.todo("the immersive mask: today `docPinned` at the read sites is the MASKED value (maskPanels at App:2718; immersive surfaces hide the tile until the user breaks out); legacyView reports the structural pin, and the mask stays an App-level overlay on top of it");
});
