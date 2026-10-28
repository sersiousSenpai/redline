// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Every way the workbench state moves, as one pure reducer. The store wraps
// it; App (from W1) dispatches through the adapter; nothing here knows about
// React, storage or the DOM, so every rule below is a unit test away.
//
// Conventions:
// - An action's `key` names the tab set; absent, it is the active set.
// - Actions that make a tab or a pane accept the ids to use (tests pass them
//   so the result is deterministic); otherwise `newId` mints one.
// - An action that cannot apply returns the SAME state object, so a store
//   can skip notifying.

import {
  AGENTS_FILLED_CAP,
  CLOSED_CAP,
  DEFAULT_DOOR_DRAFT_KEY,
  HOME_KEY,
  MAX_WALL_TILES,
  activeTabOf,
  doorDraftKey,
  emptyTabSet,
  isSplit,
  launchIdOf,
  normalizeWeights,
  paneIdsOf,
  sessionIdOf,
  type AnyPane,
  type ClosedTab,
  type LayoutNode,
  type PaneDataByKind,
  type PaneInit,
  type PaneKind,
  type SessionKey,
  type SplitDirection,
  type Tab,
  type TabSet,
  type WorkbenchState,
} from "./model";
import { normalizeWall, sameWall } from "./wall";

// The door draft keys live in model.ts (a leaf persist.ts can read without
// this module); re-exported for the callers that learnt them here.
export { DEFAULT_DOOR_DRAFT_KEY, doorDraftKey } from "./model";

/** What the defaults need to know that the state does not hold. */
export interface DefaultsContext {
  /** The terminal the session's CLI runs in, when bound (`useSessionTerminals`). */
  agentTerminalId?: string | null;
  /** Home's door draft key; defaults to the shared Front Door sentence. */
  draftKey?: string;
}

export type FocusDirection = "left" | "right" | "up" | "down";

/** How the Files rail opens a file: a plain click previews, a second click
 *  (or a double-click, or an edit) pins, ⌘-click opens a tab of its own. */
export type OpenFileMode = "preview" | "pin" | "tab";

export type WorkbenchAction =
  | { type: "selectSession"; key: SessionKey; defaults?: DefaultsContext }
  | { type: "rekeySession"; from: SessionKey; to: SessionKey; planTabId?: string }
  | {
      type: "openTab";
      key?: SessionKey;
      pane: PaneInit;
      tabId?: string;
      paneId?: string;
      /** Insert position; absent appends. */
      at?: number;
      /** Default true. */
      activate?: boolean;
    }
  | { type: "closeTab"; key?: SessionKey; tabId: string }
  | { type: "reopenClosed"; key?: SessionKey }
  | { type: "selectTab"; key?: SessionKey; tabId: string }
  /** Tab N (0-based); -1 or past the end selects the last tab (⌘9). */
  | { type: "selectTabIndex"; key?: SessionKey; index: number }
  | { type: "cycleTab"; key?: SessionKey; delta: number }
  | { type: "reorderTab"; key?: SessionKey; tabId: string; to: number }
  | {
      type: "splitPane";
      key?: SessionKey;
      paneId: string;
      direction: SplitDirection;
      pane: PaneInit;
      newPaneId?: string;
      /** Place the new pane before the target instead of after. */
      before?: boolean;
    }
  | { type: "closePane"; key?: SessionKey; paneId: string }
  | { type: "replacePreview"; key?: SessionKey; pane: PaneInit; tabId?: string; paneId?: string }
  | { type: "pinPane"; key?: SessionKey; paneId: string }
  /** The Files rail, ⌘P, a `file:line` link (W4): a file that is open in
   *  the set comes forward (pinned when asked); otherwise "preview" replaces
   *  the preview pane, "pin" opens it pinned in its place, "tab" opens a
   *  new pinned tab. A `line` scrolls there, again on every ask with a new
   *  `at` (the caller's clock: the reducer is pure). */
  | { type: "openFile"; key?: SessionKey; path: string; line?: number; mode: OpenFileMode; at?: number }
  /** A title of the user's own; empty clears it. */
  | { type: "renamePane"; key?: SessionKey; paneId: string; title: string }
  /** The pane becomes something else in place — a door tab converting into
   *  the destination picked in it — keeping its id, its tab and its focus. */
  | { type: "replacePane"; key?: SessionKey; paneId: string; pane: PaneInit }
  /** A tab leaves one set for another, panes and all (the door a launch
   *  came through follows the launch; W5 drags tabs between sessions). */
  | { type: "moveTab"; from: SessionKey; to: SessionKey; tabId: string; at?: number; activate?: boolean }
  | { type: "focusPane"; key?: SessionKey; paneId: string }
  | { type: "focusPane"; key?: SessionKey; dir: FocusDirection }
  | { type: "resizeSplit"; key?: SessionKey; tabId?: string; path: number[]; weights: number[] }
  | { type: "equalize"; key?: SessionKey; tabId?: string }
  | {
      type: "openSurface";
      key?: SessionKey;
      kind: PaneKind;
      data?: PaneDataByKind[PaneKind];
      tabId?: string;
      paneId?: string;
    }
  | { type: "ensureDefaults"; key: SessionKey; defaults?: DefaultsContext; tabIds?: string[]; paneIds?: string[] }
  | { type: "revealTerminal"; ptyId: string; key?: SessionKey; tabId?: string; paneId?: string }
  | { type: "adoptTerminal"; ptyId: string; key: SessionKey; tabId?: string; paneId?: string }
  /** A wall's tiles, focus, zoom and pins, as the one `TerminalTabs` holds
   *  them for the wall on screen (`onWallChange`). A tile new to this wall
   *  moves here: it leaves every other wall and this wall's set owns it. A
   *  wall left with nothing closes. */
  | { type: "setWall"; paneId: string; data: PaneDataByKind["terminals"] }
  /** Close a terminals pane. Its terminals are either kept running
   *  (`keep`: stowed, listed under their session until a click puts them
   *  back on a wall, and the wall remembered for ⌘⇧T, which puts back the
   *  ones still kept) or terminated (the host kills them; they leave
   *  `owners`, and nothing is remembered: a wall is its terminals). */
  | { type: "closeWall"; key?: SessionKey; paneId: string; keep: boolean }
  | { type: "prune"; liveSessions: readonly string[]; livePtys: readonly string[] };

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

// ── Small pure helpers ─────────────────────────────────────────────────────

function keyOf(state: WorkbenchState, key: SessionKey | undefined): SessionKey {
  return key ?? state.activeKey;
}

function setOf(state: WorkbenchState, key: SessionKey): TabSet | null {
  return state.sets[key] ?? null;
}

function putSet(state: WorkbenchState, key: SessionKey, set: TabSet): WorkbenchState {
  return { ...state, sets: { ...state.sets, [key]: set } };
}

function mruFront(mru: readonly SessionKey[], key: SessionKey): SessionKey[] {
  return [key, ...mru.filter((k) => k !== key)];
}

function makePane(init: PaneInit, id: string): AnyPane {
  const pane = { id, kind: init.kind, data: init.data } as AnyPane;
  if (init.preview) pane.preview = true;
  if (init.titleOverride) pane.titleOverride = init.titleOverride;
  return pane;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Shallow-equal pane data, enough to say "that pane is already open". */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

/** Replace the node at `path` (child indices from the root). */
function replaceAt(node: LayoutNode, path: readonly number[], next: LayoutNode): LayoutNode {
  if (path.length === 0) return next;
  if (!isSplit(node)) return node;
  const [i, ...rest] = path;
  const child = node.children[i];
  if (!child) return node;
  const children = node.children.slice();
  children[i] = replaceAt(child, rest, next);
  return { ...node, children };
}

function nodeAt(node: LayoutNode, path: readonly number[]): LayoutNode | null {
  let cur: LayoutNode | null = node;
  for (const i of path) {
    if (!cur || !isSplit(cur)) return null;
    cur = cur.children[i] ?? null;
  }
  return cur;
}

/** The path to the pane's leaf, or null. */
function pathTo(node: LayoutNode, paneId: string, prefix: number[] = []): number[] | null {
  if (!isSplit(node)) return node.pane === paneId ? prefix : null;
  for (let i = 0; i < node.children.length; i++) {
    const found = pathTo(node.children[i], paneId, [...prefix, i]);
    if (found) return found;
  }
  return null;
}

/** Remove the leaf for `paneId`; collapse one-child splits. Null when the
 *  tree would be empty. */
function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (!isSplit(node)) return node.pane === paneId ? null : node;
  const children: LayoutNode[] = [];
  const weights: number[] = [];
  node.children.forEach((child, i) => {
    const kept = removePane(child, paneId);
    if (kept) {
      children.push(kept);
      weights.push(node.weights[i] ?? 1);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children, weights: normalizeWeights(weights, children.length) };
}

function equalizeNode(node: LayoutNode): LayoutNode {
  if (!isSplit(node)) return node;
  const children = node.children.map(equalizeNode);
  return { ...node, children, weights: normalizeWeights([], children.length) };
}

/** Insert `leaf` beside the pane at `path`, in `direction`. A parent split
 *  of the same direction grows by one child (n-ary); otherwise the target
 *  is wrapped in a new two-way split. */
function insertBeside(
  root: LayoutNode,
  path: readonly number[],
  direction: SplitDirection,
  leaf: LayoutNode,
  before: boolean,
): LayoutNode {
  const parentPath = path.slice(0, -1);
  const parent = path.length ? nodeAt(root, parentPath) : null;
  const index = path[path.length - 1];
  if (parent && isSplit(parent) && parent.direction === direction && index !== undefined) {
    const children = parent.children.slice();
    const weights = parent.weights.slice();
    const share = (weights[index] ?? 1 / children.length) / 2;
    weights[index] = share;
    const at = before ? index : index + 1;
    children.splice(at, 0, leaf);
    weights.splice(at, 0, share);
    return replaceAt(root, parentPath, {
      ...parent,
      children,
      weights: normalizeWeights(weights, children.length),
    });
  }
  const target = nodeAt(root, path);
  if (!target) return root;
  const wrapped: LayoutNode = {
    split: true,
    direction,
    children: before ? [leaf, target] : [target, leaf],
    weights: [0.5, 0.5],
  };
  return replaceAt(root, path, wrapped);
}

/** The pane you reach by moving `dir` from `paneId`, or null at an edge.
 *  Walks up to the nearest split on that axis with a sibling that way,
 *  then takes that sibling's nearest pane in reading order. */
export function neighbourPane(root: LayoutNode, paneId: string, dir: FocusDirection): string | null {
  const path = pathTo(root, paneId);
  if (!path) return null;
  const axis: SplitDirection = dir === "left" || dir === "right" ? "row" : "column";
  const step = dir === "left" || dir === "up" ? -1 : 1;
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const parent = nodeAt(root, path.slice(0, depth));
    if (!parent || !isSplit(parent) || parent.direction !== axis) continue;
    const sibling = parent.children[path[depth] + step];
    if (!sibling) continue;
    const ids = paneIdsOf(sibling);
    return step < 0 ? ids[ids.length - 1] : ids[0];
  }
  return null;
}

/** Which tab (if any) in `set` holds `paneId`. */
function tabHolding(set: TabSet, paneId: string): Tab | null {
  for (const id of set.order) {
    const tab = set.tabs[id];
    if (tab && paneIdsOf(tab.root).includes(paneId)) return tab;
  }
  return null;
}

/** Panes of `kind` in the set, active tab's first, then strip order. */
function panesOfKind<K extends PaneKind>(set: TabSet, kind: K): { tab: Tab; pane: Extract<AnyPane, { kind: K }> }[] {
  const out: { tab: Tab; pane: Extract<AnyPane, { kind: K }> }[] = [];
  const order = set.activeTabId
    ? [set.activeTabId, ...set.order.filter((id) => id !== set.activeTabId)]
    : set.order;
  for (const tabId of order) {
    const tab = set.tabs[tabId];
    if (!tab) continue;
    for (const paneId of paneIdsOf(tab.root)) {
      const pane = set.panes[paneId];
      if (pane && pane.kind === kind) out.push({ tab, pane: pane as Extract<AnyPane, { kind: K }> });
    }
  }
  return out;
}

function closedPush(closed: readonly ClosedEntry[], entry: ClosedEntry): ClosedEntry[] {
  const next = [...closed, entry];
  return next.length > CLOSED_CAP ? next.slice(next.length - CLOSED_CAP) : next;
}
type ClosedEntry = TabSet["closed"][number];

// ── Set-level operations (each returns a new TabSet or the same one) ───────

function addTab(set: TabSet, init: PaneInit, ids: { tabId?: string; paneId?: string }, at?: number, activate = true): { set: TabSet; tabId: string; paneId: string } {
  const paneId = ids.paneId ?? newId("pane");
  const tabId = ids.tabId ?? newId("tab");
  const pane = makePane(init, paneId);
  const tab: Tab = { id: tabId, root: { pane: paneId }, focusedPaneId: paneId };
  const order = set.order.slice();
  order.splice(at === undefined ? order.length : clamp(at, 0, order.length), 0, tabId);
  return {
    set: {
      ...set,
      order,
      activeTabId: activate || !set.activeTabId ? tabId : set.activeTabId,
      tabs: { ...set.tabs, [tabId]: tab },
      panes: { ...set.panes, [paneId]: pane },
    },
    tabId,
    paneId,
  };
}

function removeTab(set: TabSet, tabId: string, remember: boolean): TabSet {
  const tab = set.tabs[tabId];
  if (!tab) return set;
  const index = set.order.indexOf(tabId);
  const order = set.order.filter((id) => id !== tabId);
  const paneIds = paneIdsOf(tab.root);
  const tabs = { ...set.tabs };
  delete tabs[tabId];
  const panes = { ...set.panes };
  const removed: AnyPane[] = [];
  for (const id of paneIds) {
    const pane = panes[id];
    if (pane) removed.push(pane);
    delete panes[id];
  }
  let activeTabId = set.activeTabId;
  if (activeTabId === tabId) {
    activeTabId = order[Math.min(index, order.length - 1)] ?? null;
  }
  return {
    ...set,
    order,
    activeTabId,
    tabs,
    panes,
    closed: remember ? closedPush(set.closed, { tab, panes: removed, index }) : set.closed,
  };
}

function withTab(set: TabSet, tabId: string, fn: (tab: Tab) => Tab): TabSet {
  const tab = set.tabs[tabId];
  if (!tab) return set;
  const next = fn(tab);
  return next === tab ? set : { ...set, tabs: { ...set.tabs, [tabId]: next } };
}

function dropPane(set: TabSet, paneId: string, remember = true): TabSet {
  const tab = tabHolding(set, paneId);
  if (!tab) return set;
  const root = removePane(tab.root, paneId);
  if (!root) return removeTab(set, tab.id, remember);
  const panes = { ...set.panes };
  delete panes[paneId];
  let focusedPaneId = tab.focusedPaneId;
  if (focusedPaneId === paneId) {
    const before = paneIdsOf(tab.root);
    const i = before.indexOf(paneId);
    const after = paneIdsOf(root);
    focusedPaneId = after[clamp(i - 1, 0, after.length - 1)] ?? after[0];
  }
  return { ...set, panes, tabs: { ...set.tabs, [tab.id]: { ...tab, root, focusedPaneId } } };
}

/** The wall data with dead or moved tiles stripped; null when nothing changed. */
function stripTiles(data: PaneDataByKind["terminals"], gone: (id: string) => boolean): PaneDataByKind["terminals"] | null {
  if (!data.tiles.some(gone) && !data.pinned.some(gone) && !(data.zoomed && gone(data.zoomed))) return null;
  const tiles = data.tiles.filter((t) => !gone(t));
  return {
    tiles,
    focus: clamp(data.focus, 0, Math.max(0, tiles.length - 1)),
    zoomed: data.zoomed && !gone(data.zoomed) ? data.zoomed : null,
    pinned: data.pinned.filter((t) => !gone(t)),
  };
}

/** Strip tiles across every wall of the set (tabs and closed stack); walls
 *  left empty close, collapsing their splits. */
function stripSetTiles(set: TabSet, gone: (id: string) => boolean): TabSet {
  let next = set;
  for (const { pane } of panesOfKind(set, "terminals")) {
    const data = stripTiles(pane.data, gone);
    if (!data) continue;
    if (data.tiles.length === 0) {
      // A wall with nothing left is not worth a ⌘⇧T.
      next = dropPane(next, pane.id, false);
    } else {
      next = { ...next, panes: { ...next.panes, [pane.id]: { ...pane, data } } };
    }
  }
  const closed = next.closed.map((entry) => {
    let changed = false;
    const panes = entry.panes.map((p) => {
      if (p.kind !== "terminals") return p;
      const data = stripTiles(p.data, gone);
      if (!data) return p;
      changed = true;
      return { ...p, data };
    });
    return changed ? { ...entry, panes } : entry;
  });
  return closed.some((e, i) => e !== next.closed[i]) ? { ...next, closed } : next;
}

/** Put `ptyId` on a wall in `set`: the wall that has it, else one with room
 *  (the active tab's first), else a new Terminals tab. Focuses the tile. */
function showOnWall(set: TabSet, ptyId: string, ids: { tabId?: string; paneId?: string }): TabSet {
  const walls = panesOfKind(set, "terminals");
  const holder = walls.find(({ pane }) => pane.data.tiles.includes(ptyId));
  if (holder) {
    const { tab, pane } = holder;
    const data = {
      ...pane.data,
      focus: pane.data.tiles.indexOf(ptyId),
      zoomed: pane.data.zoomed === ptyId ? ptyId : null,
    };
    return {
      ...set,
      activeTabId: tab.id,
      tabs: { ...set.tabs, [tab.id]: { ...tab, focusedPaneId: pane.id } },
      panes: { ...set.panes, [pane.id]: { ...pane, data } },
    };
  }
  const room = walls.find(({ pane }) => pane.data.tiles.length < MAX_WALL_TILES);
  if (room) {
    const { tab, pane } = room;
    const tiles = [...pane.data.tiles, ptyId];
    const data = { ...pane.data, tiles, focus: tiles.length - 1, zoomed: null };
    return {
      ...set,
      activeTabId: tab.id,
      tabs: { ...set.tabs, [tab.id]: { ...tab, focusedPaneId: pane.id } },
      panes: { ...set.panes, [pane.id]: { ...pane, data } },
    };
  }
  return addTab(set, { kind: "terminals", data: { tiles: [ptyId], focus: 0, zoomed: null, pinned: [] } }, ids).set;
}

/** The ptys `key` owns that are not stowed. */
function ownedPtys(state: WorkbenchState, key: SessionKey): string[] {
  return Object.keys(state.owners).filter((pty) => state.owners[pty] === key && !state.stowed.includes(pty));
}

/** `set`, remembering that `agent` has had its default Agent tab. */
function markAgentFilled(set: TabSet, agent: string): TabSet {
  const filled = set.agentsFilled ?? [];
  if (filled.includes(agent)) return set;
  return { ...set, agentsFilled: [...filled, agent].slice(-AGENTS_FILLED_CAP) };
}

/** A set's default tabs, filled ONCE: when the set is created, and when a
 *  new agent terminal binds to it for the first time. Called on every
 *  session switch and every terminal-list change, so it must not undo the
 *  user: an agent the set has already given a tab (`agentsFilled`) gets no
 *  second one after they close it with ⌘W. A set that empties still refills
 *  (a set never shows nothing), and a launch, which IS its agent, refills
 *  with its Agent tab. */
function fillDefaults(
  state: WorkbenchState,
  key: SessionKey,
  defaults: DefaultsContext | undefined,
  tabIds: readonly string[] | undefined,
  paneIds: readonly string[] | undefined,
): WorkbenchState {
  let set = setOf(state, key) ?? emptyTabSet();
  let n = 0;
  const ids = () => {
    const i = n++;
    return { tabId: tabIds?.[i], paneId: paneIds?.[i] };
  };
  // A launch IS its agent terminal; when nothing says which, the one the
  // set owns is it (a refill after its last tab closed).
  const agent = defaults?.agentTerminalId ?? (launchIdOf(key) ? (ownedPtys(state, key)[0] ?? null) : null);
  const sessionId = sessionIdOf(key);
  const filledBefore = agent !== null && (set.agentsFilled ?? []).includes(agent);
  if (set.order.length === 0) {
    if (key === HOME_KEY) {
      set = addTab(set, { kind: "door", data: { draftKey: defaults?.draftKey ?? DEFAULT_DOOR_DRAFT_KEY } }, ids()).set;
    } else if (sessionId) {
      set = addTab(set, { kind: "plan", data: { sessionId, version: null } }, ids()).set;
      if (agent && !filledBefore) set = addTab(set, { kind: "chat", data: { source: "agent", terminalId: agent, sessionId } }, ids(), undefined, false).set;
      const tiles = ownedPtys(state, key).filter((p) => p !== agent).slice(0, MAX_WALL_TILES);
      if (tiles.length) set = addTab(set, { kind: "terminals", data: { tiles, focus: 0, zoomed: null, pinned: [] } }, ids(), undefined, false).set;
    } else if (launchIdOf(key) && agent) {
      set = addTab(set, { kind: "chat", data: { source: "agent", terminalId: agent, sessionId: null } }, ids()).set;
    }
    if (agent && (sessionId || launchIdOf(key))) set = markAgentFilled(set, agent);
  } else if (agent && (sessionId || launchIdOf(key)) && !filledBefore) {
    // A terminal binding to the set for the first time: an Agent tab joins
    // the strip (not activated: nothing moves under the user). Once.
    const has = panesOfKind(set, "chat").some(({ pane }) => pane.data.source === "agent" && pane.data.terminalId === agent);
    if (!has) set = addTab(set, { kind: "chat", data: { source: "agent", terminalId: agent, sessionId } }, ids(), undefined, false).set;
    set = markAgentFilled(set, agent);
  }
  if (!set.activeTabId && set.order.length) set = { ...set, activeTabId: set.order[0] };
  let next = state;
  if (agent && state.owners[agent] !== key) next = { ...next, owners: { ...next.owners, [agent]: key } };
  return set === state.sets[key] ? next : putSet(next, key, set);
}

/** A set never shows nothing: Home grows a door back, a plan its Plan, a
 *  launch its Agent. */
function refillEmpty(state: WorkbenchState): WorkbenchState {
  let next = state;
  for (const k of Object.keys(state.sets) as SessionKey[]) {
    if (state.sets[k]?.order.length === 0) next = fillDefaults(next, k, undefined, undefined, undefined);
  }
  return next;
}

/** Make `key` the owner of `ptyId` and show it there. One attachment per
 *  PTY holds: the tile leaves every other set's wall first. */
function takeTerminal(state: WorkbenchState, key: SessionKey, ptyId: string, ids: { tabId?: string; paneId?: string }): WorkbenchState {
  const gone = (id: string) => id === ptyId;
  let sets = state.sets;
  for (const k of Object.keys(state.sets) as SessionKey[]) {
    if (k === key) continue;
    const set = state.sets[k];
    if (!set) continue;
    const stripped = stripSetTiles(set, gone);
    if (stripped !== set) sets = { ...sets, [k]: stripped };
  }
  const next: WorkbenchState = {
    ...state,
    sets,
    owners: { ...state.owners, [ptyId]: key },
    stowed: state.stowed.filter((p) => p !== ptyId),
  };
  const set = setOf(next, key) ?? emptyTabSet();
  return refillEmpty(putSet(next, key, showOnWall(set, ptyId, ids)));
}

/** Data a kind can open with when none is given; undefined means the kind
 *  needs explicit data (a file, a chat room, a draft, a review). A plan is
 *  the set's own session, so a plan set has one and Home has none. */
function defaultData(kind: PaneKind, paneId: string, key: SessionKey): PaneDataByKind[PaneKind] | undefined {
  switch (kind) {
    case "door":
      return { draftKey: doorDraftKey(paneId) };
    case "plan": {
      const sessionId = sessionIdOf(key);
      return sessionId ? { sessionId, version: null } : undefined;
    }
    case "browser":
      return { workspace: "regular" };
    case "terminals":
      return { tiles: [], focus: 0, zoomed: null, pinned: [] };
    case "servers":
    case "memory":
      return {};
    default:
      return undefined;
  }
}

/** Whether `openSurface(kind)` with no data means this pane: a chat surface
 *  is a companion room (never the session's own agent chat, which is the
 *  dock's), a plan surface is the set's own session; other kinds are one of
 *  a kind. */
function isSurfacePane(pane: AnyPane, key: SessionKey): boolean {
  if (pane.kind === "chat") return pane.data.source === "companion";
  if (pane.kind === "plan") return pane.data.sessionId === sessionIdOf(key);
  return true;
}

// ── The reducer ────────────────────────────────────────────────────────────

export function reduce(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case "selectSession": {
      const next = fillDefaults(state, action.key, action.defaults, undefined, undefined);
      if (next.activeKey === action.key && next.mru[0] === action.key) return next;
      return { ...next, activeKey: action.key, mru: mruFront(next.mru, action.key) };
    }

    case "ensureDefaults":
      return fillDefaults(state, action.key, action.defaults, action.tabIds, action.paneIds);

    case "rekeySession": {
      const { from, to } = action;
      const moving = setOf(state, from);
      if (!moving || from === to) return state;
      const sessionId = sessionIdOf(to);
      // The launch's panes learn their session: the agent's chat binds, and
      // the door that launched it — the first door in the strip, exactly
      // one — becomes the Plan tab in place. Any other door stays a door.
      const firstDoor = moving.order.flatMap((tabId) => paneIdsOf(moving.tabs[tabId]?.root ?? { pane: "" })).find((id) => moving.panes[id]?.kind === "door");
      const panes: Record<string, AnyPane> = {};
      let hasPlan = false;
      let planTabId: string | null = null;
      for (const [id, pane] of Object.entries(moving.panes)) {
        if (pane.kind === "chat" && pane.data.source === "agent" && pane.data.sessionId === null && sessionId) {
          panes[id] = { ...pane, data: { ...pane.data, sessionId } };
        } else if (pane.kind === "door" && id === firstDoor && sessionId) {
          panes[id] = { id, kind: "plan", data: { sessionId, version: null } };
          hasPlan = true;
          planTabId = tabHolding(moving, id)?.id ?? null;
        } else {
          if (pane.kind === "plan") hasPlan = true;
          panes[id] = pane;
        }
      }
      let merged: TabSet = { ...moving, panes };
      const existing = setOf(state, to);
      if (existing) {
        // A set already waits under the new key: the launch's tabs follow it.
        merged = {
          ...existing,
          order: [...existing.order, ...merged.order.filter((id) => !existing.tabs[id])],
          tabs: { ...existing.tabs, ...merged.tabs },
          panes: { ...existing.panes, ...merged.panes },
          closed: [...existing.closed, ...merged.closed].slice(-CLOSED_CAP),
          activeTabId: existing.activeTabId ?? merged.activeTabId,
        };
        // Both halves' filled agents: the launch's own agent is the plan's.
        for (const agent of moving.agentsFilled ?? []) merged = markAgentFilled(merged, agent);
        hasPlan = hasPlan || panesOfKind(existing, "plan").length > 0;
      }
      if (!hasPlan && sessionId) {
        const added = addTab(merged, { kind: "plan", data: { sessionId, version: null } }, { tabId: action.planTabId }, 0, false);
        merged = added.set;
        planTabId = added.tabId;
      }
      // D1: the plan arriving is what the user was waiting for, so when they
      // are looking at this set the Plan tab is selected; on another set it
      // lands without moving anything under them.
      if (planTabId && state.activeKey === from) merged = { ...merged, activeTabId: planTabId };
      const sets: WorkbenchState["sets"] = { ...state.sets, [to]: merged };
      delete sets[from];
      const owners: Record<string, SessionKey> = {};
      for (const [pty, owner] of Object.entries(state.owners)) owners[pty] = owner === from ? to : owner;
      const mru = state.mru.map((k) => (k === from ? to : k)).filter((k, i, all) => all.indexOf(k) === i);
      return {
        ...state,
        sets,
        owners,
        mru,
        activeKey: state.activeKey === from ? to : state.activeKey,
      };
    }

    case "openTab": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key) ?? emptyTabSet();
      const { set: next } = addTab(set, action.pane, { tabId: action.tabId, paneId: action.paneId }, action.at, action.activate ?? true);
      return putSet(state, key, next);
    }

    case "closeTab": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      if (!set || !set.tabs[action.tabId]) return state;
      return refillEmpty(putSet(state, key, removeTab(set, action.tabId, true)));
    }

    case "reopenClosed": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      if (!set || set.closed.length === 0) return state;
      const raw = set.closed[set.closed.length - 1];
      // A wall closed with "Keep running" comes back with the terminals it
      // kept that still are: alive and on no other wall since (`stowed`).
      // One that was put back elsewhere stays there (one tile per PTY); a
      // wall left with none closes again, and a tab left with nothing is
      // skipped for the one before it.
      const back = new Set<string>();
      const entryPanes: AnyPane[] = [];
      let root: LayoutNode | null = raw.tab.root;
      for (const pane of raw.panes) {
        if (pane.kind !== "terminals") {
          entryPanes.push(pane);
          continue;
        }
        const data = stripTiles(pane.data, (id) => !state.stowed.includes(id)) ?? pane.data;
        if (data.tiles.length === 0) {
          root = root && removePane(root, pane.id);
          continue;
        }
        data.tiles.forEach((id) => back.add(id));
        entryPanes.push({ ...pane, data });
      }
      if (!root) return reduce(putSet(state, key, { ...set, closed: set.closed.slice(0, -1) }), action);
      const kept = paneIdsOf(root);
      const entry: ClosedTab = {
        ...raw,
        panes: entryPanes,
        tab: { ...raw.tab, root, focusedPaneId: kept.includes(raw.tab.focusedPaneId) ? raw.tab.focusedPaneId : kept[0] },
      };
      // The ids may be live again (a tab reopened twice): mint fresh ones then.
      const taken = (id: string) => Boolean(set.tabs[id] || set.panes[id]);
      const paneMap = new Map<string, string>();
      const panes = { ...set.panes };
      for (const pane of entry.panes) {
        const id = taken(pane.id) ? newId("pane") : pane.id;
        paneMap.set(pane.id, id);
        panes[id] = { ...pane, id } as AnyPane;
      }
      const remap = (node: LayoutNode): LayoutNode =>
        isSplit(node) ? { ...node, children: node.children.map(remap) } : { pane: paneMap.get(node.pane) ?? node.pane };
      const tabId = taken(entry.tab.id) ? newId("tab") : entry.tab.id;
      const tab: Tab = {
        id: tabId,
        root: remap(entry.tab.root),
        focusedPaneId: paneMap.get(entry.tab.focusedPaneId) ?? entry.tab.focusedPaneId,
      };
      const order = set.order.slice();
      order.splice(clamp(entry.index, 0, order.length), 0, tabId);
      const reopened = putSet(state, key, {
        ...set,
        order,
        activeTabId: tabId,
        tabs: { ...set.tabs, [tabId]: tab },
        panes,
        closed: set.closed.slice(0, -1),
      });
      if (back.size === 0) return reopened;
      const owners = { ...reopened.owners };
      back.forEach((id) => (owners[id] = key));
      return { ...reopened, owners, stowed: reopened.stowed.filter((id) => !back.has(id)) };
    }

    case "selectTab": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      if (!set || !set.tabs[action.tabId] || set.activeTabId === action.tabId) return state;
      return putSet(state, key, { ...set, activeTabId: action.tabId });
    }

    case "selectTabIndex": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      if (!set || set.order.length === 0) return state;
      const index = action.index < 0 || action.index >= set.order.length ? set.order.length - 1 : action.index;
      const tabId = set.order[index];
      return set.activeTabId === tabId ? state : putSet(state, key, { ...set, activeTabId: tabId });
    }

    case "cycleTab": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      if (!set || set.order.length < 2) return state;
      const i = Math.max(0, set.order.indexOf(set.activeTabId ?? ""));
      const n = set.order.length;
      const tabId = set.order[(((i + action.delta) % n) + n) % n];
      return putSet(state, key, { ...set, activeTabId: tabId });
    }

    case "reorderTab": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      if (!set || !set.tabs[action.tabId]) return state;
      const order = set.order.filter((id) => id !== action.tabId);
      order.splice(clamp(action.to, 0, order.length), 0, action.tabId);
      if (order.every((id, i) => id === set.order[i])) return state;
      return putSet(state, key, { ...set, order });
    }

    case "splitPane": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      const tab = set && tabHolding(set, action.paneId);
      if (!set || !tab) return state;
      const path = pathTo(tab.root, action.paneId);
      if (!path) return state;
      const paneId = action.newPaneId ?? newId("pane");
      const pane = makePane(action.pane, paneId);
      const root = insertBeside(tab.root, path, action.direction, { pane: paneId }, action.before ?? false);
      return putSet(state, key, {
        ...set,
        activeTabId: tab.id,
        panes: { ...set.panes, [paneId]: pane },
        tabs: { ...set.tabs, [tab.id]: { ...tab, root, focusedPaneId: paneId } },
      });
    }

    case "closePane": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      if (!set || !set.panes[action.paneId]) return state;
      return refillEmpty(putSet(state, key, dropPane(set, action.paneId)));
    }

    case "replacePreview": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key) ?? emptyTabSet();
      const tab = (action.tabId && set.tabs[action.tabId]) || activeTabOf(set);
      const previewId = tab ? paneIdsOf(tab.root).find((id) => set.panes[id]?.preview) : undefined;
      if (tab && previewId) {
        const pane = makePane({ ...action.pane, preview: true } as PaneInit, previewId);
        return putSet(state, key, {
          ...set,
          activeTabId: tab.id,
          panes: { ...set.panes, [previewId]: pane },
          tabs: { ...set.tabs, [tab.id]: { ...tab, focusedPaneId: previewId } },
        });
      }
      const at = tab ? set.order.indexOf(tab.id) + 1 : undefined;
      const { set: next } = addTab(set, { ...action.pane, preview: true } as PaneInit, { tabId: action.tabId && !set.tabs[action.tabId] ? action.tabId : undefined, paneId: action.paneId }, at);
      return putSet(state, key, next);
    }

    case "pinPane": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      const pane = set?.panes[action.paneId];
      if (!set || !pane || !pane.preview) return state;
      const pinned = { ...pane } as AnyPane;
      delete pinned.preview;
      return putSet(state, key, { ...set, panes: { ...set.panes, [action.paneId]: pinned } });
    }

    case "openFile": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key) ?? emptyTabSet();
      // The reveal nonce comes with the action: the reducer stays pure.
      const data: PaneDataByKind["file"] =
        action.line && action.line > 0
          ? { path: action.path, line: action.line, ...(action.at !== undefined ? { at: action.at } : {}) }
          : { path: action.path };
      const open = panesOfKind(set, "file").find(({ pane }) => pane.data.path === action.path);
      if (open) {
        const { tab, pane } = open;
        const next = { ...pane, data: action.line && action.line > 0 ? data : pane.data } as AnyPane;
        if (action.mode !== "preview") delete next.preview;
        const same = set.activeTabId === tab.id && tab.focusedPaneId === pane.id && next.data === pane.data && !!next.preview === !!pane.preview;
        if (same) return state;
        return putSet(state, key, {
          ...set,
          activeTabId: tab.id,
          panes: { ...set.panes, [pane.id]: next },
          tabs: { ...set.tabs, [tab.id]: { ...tab, focusedPaneId: pane.id } },
        });
      }
      if (action.mode === "tab") {
        const tab = activeTabOf(set);
        const { set: next } = addTab(set, { kind: "file", data }, {}, tab ? set.order.indexOf(tab.id) + 1 : undefined);
        return putSet(state, key, next);
      }
      const previewed = reduce(state, { type: "replacePreview", key, pane: { kind: "file", data } });
      if (action.mode === "preview") return previewed;
      const pset = setOf(previewed, key);
      const ptab = pset && activeTabOf(pset);
      return ptab ? reduce(previewed, { type: "pinPane", key, paneId: ptab.focusedPaneId }) : previewed;
    }

    case "renamePane": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      const pane = set?.panes[action.paneId];
      if (!set || !pane) return state;
      const title = action.title.trim();
      if ((pane.titleOverride ?? "") === title) return state;
      const next = { ...pane } as AnyPane;
      if (title) next.titleOverride = title;
      else delete next.titleOverride;
      return putSet(state, key, { ...set, panes: { ...set.panes, [action.paneId]: next } });
    }

    case "replacePane": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      if (!set || !set.panes[action.paneId]) return state;
      return putSet(state, key, { ...set, panes: { ...set.panes, [action.paneId]: makePane(action.pane, action.paneId) } });
    }

    case "moveTab": {
      const { from, to, tabId } = action;
      const source = setOf(state, from);
      const tab = source?.tabs[tabId];
      if (!source || !tab || from === to) return state;
      const target = setOf(state, to) ?? emptyTabSet();
      const ids = paneIdsOf(tab.root);
      const panes = { ...target.panes };
      for (const id of ids) {
        const pane = source.panes[id];
        if (pane) panes[id] = pane;
      }
      const order = target.order.filter((id) => id !== tabId);
      order.splice(action.at === undefined ? order.length : clamp(action.at, 0, order.length), 0, tabId);
      const moved: TabSet = {
        ...target,
        order,
        activeTabId: action.activate ?? true ? tabId : (target.activeTabId ?? tabId),
        tabs: { ...target.tabs, [tabId]: tab },
        panes,
      };
      // Gone from its old set without a ⌘⇧T entry: it is still open.
      const left = removeTab(source, tabId, false);
      return refillEmpty({ ...state, sets: { ...state.sets, [from]: left, [to]: moved } });
    }

    case "focusPane": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      if (!set) return state;
      if ("paneId" in action) {
        const tab = tabHolding(set, action.paneId);
        if (!tab) return state;
        if (tab.id === set.activeTabId && tab.focusedPaneId === action.paneId) return state;
        return putSet(state, key, {
          ...set,
          activeTabId: tab.id,
          tabs: { ...set.tabs, [tab.id]: { ...tab, focusedPaneId: action.paneId } },
        });
      }
      const tab = activeTabOf(set);
      if (!tab) return state;
      const target = neighbourPane(tab.root, tab.focusedPaneId, action.dir);
      if (!target) return state;
      return putSet(state, key, withTab(set, tab.id, (t) => ({ ...t, focusedPaneId: target })));
    }

    case "resizeSplit": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      const tab = set && (action.tabId ? set.tabs[action.tabId] : activeTabOf(set));
      if (!set || !tab) return state;
      const node = nodeAt(tab.root, action.path);
      if (!node || !isSplit(node) || action.weights.length !== node.children.length) return state;
      const weights = normalizeWeights(action.weights, node.children.length);
      return putSet(state, key, withTab(set, tab.id, (t) => ({ ...t, root: replaceAt(t.root, action.path, { ...node, weights }) })));
    }

    case "equalize": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      const tab = set && (action.tabId ? set.tabs[action.tabId] : activeTabOf(set));
      if (!set || !tab || !isSplit(tab.root)) return state;
      return putSet(state, key, withTab(set, tab.id, (t) => ({ ...t, root: equalizeNode(t.root) })));
    }

    case "openSurface": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key) ?? emptyTabSet();
      // A door is always new (⌘T); anything else comes forward if it is open
      // with the same data, in the current set, never navigating away.
      if (action.kind !== "door") {
        const open = panesOfKind(set, action.kind).find(({ pane }) => (action.data === undefined ? isSurfacePane(pane, key) : sameData(pane.data, action.data)));
        if (open) {
          const { tab, pane } = open;
          if (set.activeTabId === tab.id && tab.focusedPaneId === pane.id) return state;
          return putSet(state, key, {
            ...set,
            activeTabId: tab.id,
            tabs: { ...set.tabs, [tab.id]: { ...tab, focusedPaneId: pane.id } },
          });
        }
      }
      const paneId = action.paneId ?? newId("pane");
      const data = action.data ?? defaultData(action.kind, paneId, key);
      if (data === undefined) return state;
      const { set: next } = addTab(set, { kind: action.kind, data } as PaneInit, { tabId: action.tabId, paneId });
      return putSet(state, key, next);
    }

    case "revealTerminal": {
      // Shown where it is owned; an explicit other key is an adoption (the
      // tile leaves its old wall), so a PTY is never on two walls.
      const key = action.key ?? state.owners[action.ptyId] ?? state.activeKey;
      let next = takeTerminal(state, key, action.ptyId, { tabId: action.tabId, paneId: action.paneId });
      if (next.activeKey !== key) next = { ...next, activeKey: key, mru: mruFront(next.mru, key) };
      return next;
    }

    case "setWall": {
      const key = (Object.keys(state.sets) as SessionKey[]).find((k) => state.sets[k]?.panes[action.paneId]);
      const set = key ? state.sets[key] : undefined;
      const pane = set?.panes[action.paneId];
      if (!key || !set || !pane || pane.kind !== "terminals") return state;
      const data = normalizeWall(action.data);
      if (sameWall(pane.data, data)) return state;
      if (data.tiles.length === 0) return refillEmpty(putSet(state, key, dropPane(set, pane.id, false)));
      const added = data.tiles.filter((id) => !pane.data.tiles.includes(id));
      let next: WorkbenchState = state;
      if (added.length) {
        // One attachment per PTY: a tile new here leaves every other wall,
        // this set's included (the pane itself never held it).
        const gone = (id: string) => added.includes(id);
        let sets = state.sets;
        for (const k of Object.keys(state.sets) as SessionKey[]) {
          const other = state.sets[k];
          if (!other) continue;
          const stripped = stripSetTiles(other, gone);
          if (stripped !== other) sets = { ...sets, [k]: stripped };
        }
        const owners = { ...state.owners };
        for (const id of added) owners[id] = key;
        next = { ...state, sets, owners, stowed: state.stowed.filter((p) => !gone(p)) };
      }
      const current = next.sets[key] ?? set;
      const holder = current.panes[pane.id];
      if (!holder || holder.kind !== "terminals") return refillEmpty(next);
      return refillEmpty(putSet(next, key, { ...current, panes: { ...current.panes, [pane.id]: { ...holder, data } } }));
    }

    case "closeWall": {
      const key = keyOf(state, action.key);
      const set = setOf(state, key);
      const pane = set?.panes[action.paneId];
      if (!set || !pane || pane.kind !== "terminals") return state;
      const tiles = pane.data.tiles;
      // Kept running, the wall is remembered for ⌘⇧T like any closed tab:
      // reopening it puts back the terminals still kept (`reopenClosed`).
      // Terminated, it is not: a wall is its terminals.
      const next: WorkbenchState = action.keep
        ? { ...state, stowed: [...state.stowed, ...tiles.filter((id) => !state.stowed.includes(id))] }
        : {
            ...state,
            owners: Object.fromEntries(Object.entries(state.owners).filter(([id]) => !tiles.includes(id))),
            stowed: state.stowed.filter((id) => !tiles.includes(id)),
          };
      return refillEmpty(putSet(next, key, dropPane(set, pane.id, action.keep)));
    }

    case "adoptTerminal":
      // Ownership moves without navigating: the tile shows on the new
      // owner's wall and leaves every other.
      return takeTerminal(state, action.key, action.ptyId, { tabId: action.tabId, paneId: action.paneId });

    case "prune": {
      const live = new Set(action.liveSessions);
      const ptys = new Set(action.livePtys);
      const dead = (id: string) => !ptys.has(id);
      const keep = (key: SessionKey, set: TabSet): boolean => {
        const sid = sessionIdOf(key);
        if (sid) return live.has(sid);
        if (launchIdOf(key)) {
          // A launch is its agent terminal; without a live one it is stale.
          return panesOfKind(set, "chat").some(({ pane }) => pane.data.source === "agent" && ptys.has(pane.data.terminalId));
        }
        return true;
      };
      const sets: WorkbenchState["sets"] = {};
      let changed = false;
      for (const k of Object.keys(state.sets) as SessionKey[]) {
        const set = state.sets[k];
        if (!set) continue;
        if (!keep(k, set)) {
          changed = true;
          continue;
        }
        const stripped = stripSetTiles(set, dead);
        if (stripped !== set) changed = true;
        sets[k] = stripped;
      }
      if (!sets.home) {
        sets.home = emptyTabSet();
        changed = true;
      }
      const owners: Record<string, SessionKey> = {};
      for (const [pty, owner] of Object.entries(state.owners)) {
        if (dead(pty)) {
          changed = true;
          continue;
        }
        // A live terminal whose set went is an orphan, and orphans go Home.
        const next = sets[owner] ? owner : HOME_KEY;
        if (next !== owner) changed = true;
        owners[pty] = next;
      }
      const stowed = state.stowed.filter((p) => !dead(p));
      if (stowed.length !== state.stowed.length) changed = true;
      const mru = state.mru.filter((k) => sets[k]);
      if (mru.length !== state.mru.length) changed = true;
      if (!mru.includes(HOME_KEY)) mru.push(HOME_KEY);
      const activeKey = sets[state.activeKey] ? state.activeKey : HOME_KEY;
      if (activeKey !== state.activeKey) changed = true;
      if (!changed) return state;
      return refillEmpty({ ...state, sets, owners, stowed, mru, activeKey });
    }
  }
}
