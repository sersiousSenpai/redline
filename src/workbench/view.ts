// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// What the active tab shows, read straight off the workbench state: the
// selected session, the focused pane, every kind on screen, and the tab's
// surface in the manifest's vocabulary (`config/workspace.ts`'s `Surface`,
// which the landing, the nudge, the arrival rule and the conversation dock
// speak). Pure selectors, on the boot path beside `store.ts`; each one hands
// back the same value for an unchanged state, so `useWorkbench` re-renders
// nothing on a notification that did not move it.

import type { Surface } from "../config/workspace";
import {
  activeSessionOf,
  activeTabOf,
  isDocumentKind,
  paneIdsOf,
  sessionIdOf,
  type AnyPane,
  type DocumentKind,
  type PaneKind,
  type SessionKey,
  type Tab,
  type TabSet,
  type WorkbenchState,
} from "./model";

export interface StageView {
  /** The selected plan session: the focused pane's (a Plan tab, a session's
   *  Agent tab), else the active set's own; null on Home's door and during a
   *  launch (D29). */
  activeId: string | null;
  /** The focused file pane's path, else the tab's first file, else null. */
  activeFile: string | null;
  /** The focused pane's kind, or null for an empty set. */
  focusedKind: PaneKind | null;
  /** Every kind the active tab shows, in reading order, once each. */
  visibleKinds: readonly PaneKind[];
  /** The tab's surface: its first pane that is not a document face, a
   *  terminal wall or an agent chat, else "document". It does NOT follow
   *  focus: clicking the plan half of a plan + browser tab must not hide
   *  the webview. */
  surface: Surface;
  /** A document face (door, plan, file) is on screen. Beside a surface,
   *  that is the one split the app makes: the tile. */
  hasDocument: boolean;
}

/** The active set's active tab and its panes, in reading order. */
export function activePanes(state: WorkbenchState): { key: SessionKey; set: TabSet | null; tab: Tab | null; panes: AnyPane[] } {
  const set = state.sets[state.activeKey] ?? null;
  const tab = set ? activeTabOf(set) : null;
  const panes = tab && set ? paneIdsOf(tab.root).map((id) => set.panes[id]).filter((p): p is AnyPane => Boolean(p)) : [];
  return { key: state.activeKey, set, tab, panes };
}

/** The active tab's focused pane, or null. */
export function focusedPane(state: WorkbenchState): AnyPane | null {
  const { set, tab } = activePanes(state);
  return tab && set ? (set.panes[tab.focusedPaneId] ?? null) : null;
}

/** The first pane of `kind` in the active set, active tab first, with its
 *  tab. */
export function findPane(state: WorkbenchState, kind: PaneKind): { tabId: string; pane: AnyPane } | null {
  const set = state.sets[state.activeKey];
  if (!set) return null;
  const order = set.activeTabId ? [set.activeTabId, ...set.order.filter((id) => id !== set.activeTabId)] : set.order;
  for (const tabId of order) {
    const tab = set.tabs[tabId];
    if (!tab) continue;
    for (const id of paneIdsOf(tab.root)) {
      const pane = set.panes[id];
      if (pane && pane.kind === kind) return { tabId, pane };
    }
  }
  return null;
}

/** The surface a pane is, or null for the plate's faces, a terminal wall
 *  and a session's own agent chat (none of them a surface the manifest
 *  names). A companion room is the chat surface. */
export function surfaceOfPane(pane: AnyPane): Surface | null {
  if (isDocumentKind(pane.kind) || pane.kind === "terminals") return null;
  if (pane.kind === "chat") return pane.data.source === "companion" ? "chat" : null;
  return pane.kind;
}

/** The pane kind `selectSurface(surface)` means in `key`: "document" is the
 *  session's plan, or the door when there is no session. `session` is the
 *  session on screen (D29: a plan opened as a tab in Home is one), which
 *  defaults to the set's own. */
export function kindForSurface(surface: Surface, key: SessionKey, session: string | null = sessionIdOf(key)): PaneKind {
  if (surface === "document") return session ? "plan" : "door";
  return surface;
}

export function stageView(state: WorkbenchState): StageView {
  const { set, tab, panes } = activePanes(state);
  const focused = tab && set ? (set.panes[tab.focusedPaneId] ?? null) : null;
  let surface: Surface = "document";
  for (const pane of panes) {
    const s = surfaceOfPane(pane);
    if (s) {
      surface = s;
      break;
    }
  }
  const files = panes.filter((p): p is Extract<AnyPane, { kind: "file" }> => p.kind === "file");
  const focusedFile = focused && focused.kind === "file" ? focused : files[0];
  const visibleKinds: PaneKind[] = [];
  for (const p of panes) if (!visibleKinds.includes(p.kind)) visibleKinds.push(p.kind);
  return {
    // Never the collab joined key (`joined:<sid>:<threadStart>`): a joined
    // room has no session key here, and App keeps it beside this.
    // D29: the focused pane's session, so a plan opened as a tab in the
    // current set is the selected session while it is in front.
    activeId: activeSessionOf(state),
    activeFile: focusedFile?.data.path ?? null,
    focusedKind: focused?.kind ?? null,
    visibleKinds,
    surface,
    hasDocument: panes.some((p) => isDocumentKind(p.kind)),
  };
}

let viewState: WorkbenchState | null = null;
let viewValue: StageView | null = null;
/** `stageView`, the same object back for an unchanged state (a fresh one
 *  per notification would re-render every reader). */
export function selectStageView(state: WorkbenchState): StageView {
  if (state !== viewState) {
    viewState = state;
    viewValue = stageView(state);
  }
  return viewValue!;
}

/** Which document face the plate wears: the focused file or door, else the
 *  selected session's plan, else the door. A plan beside a browser is the
 *  plan; a door tab inside a session is the door. */
export function plateFace(view: Pick<StageView, "focusedKind">, activeId: string | null): DocumentKind {
  if (view.focusedKind === "file") return "file";
  if (view.focusedKind === "door") return "door";
  return activeId ? "plan" : "door";
}

/** The geometry the browser's native webview re-reads its rect on: the
 *  set, the tab and its layout tree. */
export function selectLayoutKey(state: WorkbenchState): string {
  const { key, tab } = activePanes(state);
  return tab ? `${key}|${tab.id}|${JSON.stringify(tab.root)}` : key;
}

/** The companion chat the active tab shows, if any: the room is a pane,
 *  and the one ChatRoom body follows it. */
export function selectVisibleCompanion(state: WorkbenchState): string | null {
  for (const pane of activePanes(state).panes) if (pane.kind === "chat" && pane.data.source === "companion") return pane.data.companionId;
  return null;
}

/** The focused door pane's draft key, or `fallback` (the Front Door's
 *  shared sentence) when the focused pane is not a door. */
export function focusedDoorDraftKey(state: WorkbenchState, fallback: string): string {
  const pane = focusedPane(state);
  return pane?.kind === "door" ? pane.data.draftKey : fallback;
}

/** The destination the focused door pane remembers, among the ones its
 *  composer launches into. */
export function selectFocusedDoorDestination(state: WorkbenchState): "plan" | "chat" | "drafter" | "browser" | null {
  const pane = focusedPane(state);
  const d = pane?.kind === "door" ? pane.data.destination : undefined;
  return d === "plan" || d === "chat" || d === "drafter" || d === "browser" ? d : null;
}

/** The active tab is the tile: a document face beside one surface. */
export function tileOf(state: WorkbenchState): { doc: AnyPane; other: AnyPane } | null {
  const { panes } = activePanes(state);
  if (panes.length !== 2) return null;
  const doc = panes.find((p) => isDocumentKind(p.kind));
  const other = panes.find((p) => p !== doc);
  return doc && other ? { doc, other } : null;
}
