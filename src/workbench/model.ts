// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The workbench model: what the centre of the window holds, per session.
//
// Today App keeps that in a handful of unrelated values — `mainSurface`,
// `docPinned`, `split.*`, `activeId`, `activeFile`, the wall's own tiles —
// and every surface is a global that one header radio points at. Here the
// centre is a SET of tabs per session (plus Home), each tab a tree of typed
// panes, and the terminals a session owns are recorded against it. Nothing
// here touches React, storage or the DOM: `reducer.ts` moves the state,
// `persist.ts` keeps it, `view.ts` reads what the active tab shows. Pure,
// unit-tested like `tilePolicy.ts`.

import { DOOR_MIN_W } from "../lib/paneLayout";
import type { DiffSource } from "../types";

/** A tab set's owner: Home, a plan session, or a launch whose plan has not
 *  arrived yet. A launch rekeys to its plan on `plan-received`. */
export type SessionKey = "home" | `plan:${string}` | `launch:${string}`;

export const HOME_KEY: SessionKey = "home";

export function planKey(sessionId: string): SessionKey {
  return `plan:${sessionId}`;
}

export function launchKey(launchId: string): SessionKey {
  return `launch:${launchId}`;
}

/** The session id behind a `plan:` key, else null. */
export function sessionIdOf(key: SessionKey): string | null {
  return key.startsWith("plan:") ? key.slice(5) : null;
}

/** The launch id behind a `launch:` key, else null. */
export function launchIdOf(key: SessionKey): string | null {
  return key.startsWith("launch:") ? key.slice(7) : null;
}

/** The Front Door's shared sentence (`FRONT_DOOR_TEXT_KEY`): Home's first
 *  door keeps it, and so does a chat's compact composer. Spelled here so the
 *  model stays a leaf; `legacy.test.ts` pins it to the real constant. */
export const DEFAULT_DOOR_DRAFT_KEY = "redline.frontDoor.text";

/** Every other door tab has a draft of its own. */
export function doorDraftKey(paneId: string): string {
  return `redline.workbench.door.${paneId}`;
}

export function isSessionKey(value: unknown): value is SessionKey {
  return (
    typeof value === "string" &&
    (value === "home" ||
      (value.startsWith("plan:") && value.length > 5) ||
      (value.startsWith("launch:") && value.length > 7))
  );
}

/** Where the door sends a sentence. The launch destinations plus the
 *  surfaces a door tab converts into in place. */
export type DoorDestination =
  | "plan"
  | "chat"
  | "drafter"
  | "browser"
  | "review"
  | "memory"
  | "servers";

/** What a pane can show. The three document faces (`door`, `plan`, `file`)
 *  are the plate; the rest are the surfaces a door tab opens, plus the agent
 *  / companion chat. */
export type PaneKind =
  | "door"
  | "plan"
  | "chat"
  | "terminals"
  | "file"
  | "browser"
  | "drafter"
  | "review"
  | "servers"
  | "memory";

export const PANE_KINDS: readonly PaneKind[] = [
  "door",
  "plan",
  "chat",
  "terminals",
  "file",
  "browser",
  "drafter",
  "review",
  "servers",
  "memory",
];

export function isPaneKind(value: unknown): value is PaneKind {
  return typeof value === "string" && (PANE_KINDS as readonly string[]).includes(value);
}

/** The plate's three document faces: a door, a plan, or a file in the
 *  viewer. Everything else is a surface. */
export type DocumentKind = "door" | "plan" | "file";

export const DOCUMENT_KINDS: readonly DocumentKind[] = ["door", "plan", "file"];

/** Whether a pane kind is one of the plate's document faces. */
export function isDocumentKind(kind: PaneKind): kind is DocumentKind {
  return (DOCUMENT_KINDS as readonly PaneKind[]).includes(kind);
}

/** The kinds that open in the current set and never navigate you away. */
export const GLOBAL_KINDS: readonly PaneKind[] = [
  "memory",
  "servers",
  "drafter",
  "browser",
  "review",
];

/** A terminal wall's own state, as `TerminalTabs` keeps it: tiles in
 *  row-major order (up to `MAX_WALL_TILES`), the focused index, the zoomed
 *  tile and the pinned ones. */
export interface WallData {
  tiles: string[];
  focus: number;
  zoomed: string | null;
  pinned: string[];
}

/** The wall's tile cap (`TerminalTabs.MAX_TILES`). A wall that is full opens
 *  a new tab instead of evicting a tile. */
export const MAX_WALL_TILES = 14;

export type ChatData =
  /** A session's own conversation: the agent in its terminal. The session
   *  is null while a launch's plan has not arrived. */
  | { source: "agent"; terminalId: string; sessionId: string | null }
  /** A companion room. */
  | { source: "companion"; companionId: string };

/** Per-kind pane data. Kinds with nothing of their own carry an empty
 *  record so every pane still has a `data`. */
export interface PaneDataByKind {
  door: { draftKey: string; destination?: DoorDestination };
  plan: { sessionId: string; version: number | null };
  chat: ChatData;
  terminals: WallData;
  /** `at` is a reveal nonce, never persisted: asking for the same line of
   *  an open file again scrolls to it again. */
  file: { path: string; line?: number; at?: number };
  browser: { workspace: string };
  drafter: { draftId: string };
  review: { repo: string; source: DiffSource };
  servers: Record<string, never>;
  memory: Record<string, never>;
}

export interface Pane<K extends PaneKind = PaneKind> {
  id: string;
  kind: K;
  /** A preview pane is replaced by the next preview (a plain click in the
   *  Files rail); pinning clears it. */
  preview?: boolean;
  titleOverride?: string;
  data: PaneDataByKind[K];
}

/** `Pane<K>` for every K, distributed — so a switch on `kind` narrows `data`. */
export type AnyPane = { [K in PaneKind]: Pane<K> }[PaneKind];

/** What `openTab` and friends take: a pane without its id. */
export type PaneInit = { [K in PaneKind]: { kind: K; data: PaneDataByKind[K]; preview?: boolean; titleOverride?: string } }[PaneKind];

export type SplitDirection = "row" | "column";

/** A tab's layout: a pane, or an n-ary weighted split of layouts. Weights
 *  are positive and sum to 1 (`normalizeWeights`). */
export type LayoutNode =
  | { pane: string }
  | { split: true; direction: SplitDirection; children: LayoutNode[]; weights: number[] };

export interface Tab {
  id: string;
  root: LayoutNode;
  focusedPaneId: string;
  /** ⌘⇧↩: the focused pane of a split fills the tab while the rest stay
   *  mounted, hidden. Always the focused pane: focus moving elsewhere, a
   *  split, a close or a merge puts the tab back (the reducer keeps it so). */
  zoomed?: string;
}

/** A closed tab, kept for ⌘⇧T: the tab, its panes, and where it sat. */
export interface ClosedTab {
  tab: Tab;
  panes: AnyPane[];
  index: number;
}

export const CLOSED_CAP = 10;

/** How many agent terminals a set remembers having given a default tab. */
export const AGENTS_FILLED_CAP = 8;

export interface TabSet {
  order: string[];
  activeTabId: string | null;
  tabs: Record<string, Tab>;
  panes: Record<string, AnyPane>;
  closed: ClosedTab[];
  /** Agent terminals this set has already given their default Agent tab,
   *  oldest first (cap `AGENTS_FILLED_CAP`). A default is filled once: a
   *  terminal listed here never gets its tab back from `ensureDefaults` or
   *  `selectSession`, so an Agent tab the user closed stays closed until
   *  they reopen it (the sidebar row, `openSurface`). Absent = none yet. */
  agentsFilled?: string[];
  /** The tabs shown before the active one, most recent first (cap
   *  `RECENT_TABS_CAP`): closing the active tab returns to the one you came
   *  from — an untouched door's Esc lands back where ⌘T was pressed — not
   *  to its neighbour in the strip. Absent = none yet. */
  recent?: string[];
}

/** How many previously shown tabs a set remembers. */
export const RECENT_TABS_CAP = 10;

export interface WorkbenchState {
  v: 1;
  activeKey: SessionKey;
  sets: Partial<Record<SessionKey, TabSet>>;
  /** Most recently shown first. Home is always present. */
  mru: SessionKey[];
  /** Which set each terminal (PTY id) belongs to. */
  owners: Record<string, SessionKey>;
  /** Terminals the user kept running after closing their pane: not in any
   *  wall, listed under their session until a click puts them back. */
  stowed: string[];
}

export const WORKBENCH_VERSION = 1 as const;

/** How many sets `persist.ts` keeps, least recently used first out. */
export const SET_CAP = 40;

export function emptyTabSet(): TabSet {
  return { order: [], activeTabId: null, tabs: {}, panes: {}, closed: [] };
}

export function emptyWorkbench(): WorkbenchState {
  return {
    v: WORKBENCH_VERSION,
    activeKey: HOME_KEY,
    sets: { home: emptyTabSet() },
    mru: [HOME_KEY],
    owners: {},
    stowed: [],
  };
}

// ── Layout helpers (pure, shared by the reducer and the view) ──────────────

export function isSplit(
  node: LayoutNode,
): node is { split: true; direction: SplitDirection; children: LayoutNode[]; weights: number[] } {
  return "split" in node;
}

/** Every pane id under `node`, in reading order (left to right, top to
 *  bottom — a depth-first walk). */
export function paneIdsOf(node: LayoutNode): string[] {
  if (!isSplit(node)) return [node.pane];
  return node.children.flatMap(paneIdsOf);
}

/** The panes a tab shows: its zoomed pane alone, else all of them. */
export function shownPaneIds(tab: Tab): string[] {
  const ids = paneIdsOf(tab.root);
  return tab.zoomed && ids.includes(tab.zoomed) ? [tab.zoomed] : ids;
}

/** Positive weights that sum to 1. Anything unusable becomes an even split. */
export function normalizeWeights(weights: readonly number[], count: number): number[] {
  if (count <= 0) return [];
  const usable =
    weights.length === count && weights.every((w) => typeof w === "number" && Number.isFinite(w) && w > 0);
  if (!usable) return Array(count).fill(1 / count);
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

/** A set's active tab, or null. */
export function activeTabOf(set: TabSet): Tab | null {
  return set.activeTabId ? (set.tabs[set.activeTabId] ?? null) : null;
}

/** The pane ids a set is showing: its active tab's, in reading order (the
 *  zoomed one alone while a pane is zoomed). */
export function visiblePaneIds(set: TabSet): string[] {
  const tab = activeTabOf(set);
  return tab ? shownPaneIds(tab) : [];
}

/** Which visible pane of `kind` holds a singleton body (the plan, the
 *  browser): the pane "Bring here" asked for, while it is on screen; else
 *  the focused one; else the first. Exactly one holds; the others show
 *  where it went. */
export function singletonHolder(state: WorkbenchState, kind: PaneKind, asked: string | null): string | undefined {
  const set = state.sets[state.activeKey];
  const tab = set && activeTabOf(set);
  const ids: unknown[] = tab ? shownPaneIds(tab).filter((id) => set.panes[id]?.kind === kind) : [];
  return [asked, tab?.focusedPaneId, ids[0]].find((id) => ids.includes(id)) as string | undefined;
}

/** The plan session a pane is about: a plan's, or a session's own Agent
 *  pane's once its plan has arrived; null for everything else. */
export function sessionOfPane(pane: AnyPane): string | null {
  if (pane.kind === "plan") return pane.data.sessionId;
  if (pane.kind === "chat" && pane.data.source === "agent") return pane.data.sessionId;
  return null;
}

/** The first session a tab is about: its focused pane's, else its first. */
function tabSession(set: TabSet, tab: Tab): string | null {
  const focused = set.panes[tab.focusedPaneId];
  const fromFocus = focused ? sessionOfPane(focused) : null;
  if (fromFocus) return fromFocus;
  for (const id of paneIdsOf(tab.root)) {
    const pane = set.panes[id];
    const sid = pane ? sessionOfPane(pane) : null;
    if (sid) return sid;
  }
  return null;
}

/** The session the stage is showing (D29): the tab in front's, else the one
 *  of the tab shown most recently before it that has one — a set keeps the
 *  session it was last about, as a session's own set always did — else the
 *  set's own. A plan opened as a tab in Home's set (a sidebar click) is the
 *  selected session from then on; a fresh Home is none. */
export function activeSessionOf(state: WorkbenchState): string | null {
  const key = state.activeKey;
  const set = state.sets[key];
  const own = key.startsWith("plan:") ? key.slice(5) : null;
  if (!set) return own;
  const tab = activeTabOf(set);
  const here = tab ? tabSession(set, tab) : null;
  if (here) return here;
  for (const id of set.recent ?? []) {
    const before = set.tabs[id];
    const sid = before ? tabSession(set, before) : null;
    if (sid) return sid;
  }
  return own;
}

/** A short, display-worthy title for a pane when it has no override. The
 *  tab strip refines this with session titles it knows; this is the floor. */
export function paneTitle(pane: AnyPane): string {
  if (pane.titleOverride) return pane.titleOverride;
  switch (pane.kind) {
    case "door":
      return "New";
    case "plan":
      return pane.data.version == null ? "Plan" : `Plan v${pane.data.version}`;
    case "chat":
      return pane.data.source === "agent" ? "Agent" : "Chat";
    case "terminals":
      return "Terminals";
    case "file": {
      const base = pane.data.path.split("/").filter(Boolean).pop();
      return base || pane.data.path;
    }
    case "browser":
      return "Browser";
    case "drafter":
      return "Draft";
    case "review":
      return "Review";
    case "servers":
      return "Localhost";
    case "memory":
      return "Memory";
  }
}

// ── Hard stops (D38, D40) ───────────────────────────────────────────────
// Pure, and here rather than in the lazy reducer: App reads what the tab on
// screen asks of the stage on the boot path.

/** A split's seam between two panes, in px (D38: one rule). */
export const SPLIT_SEAM_W = 1;

/** Each pane kind's hard stop in a split, px (D40): a split never takes a
 *  pane below it — the divider stops there, and a split or a merge whose
 *  panes cannot all keep theirs is refused. */
export const PANE_MIN_W: Record<PaneKind, number> = {
  // The composer's one chip row (harness · project · destination · History,
  // then + 🎙 ↑) and a one-line headline.
  door: DOOR_MIN_W,
  // The docked contents (~216 px) beside a 48 ch measure of plan text.
  plan: 600,
  // The draft's editor and its toolbar's one row, as the door's.
  drafter: DOOR_MIN_W,
  // The page strip beside the address bar.
  browser: 420,
  // The compact composer's chips and its send.
  chat: 400,
  // Two terminal tiles side by side.
  terminals: 480,
  review: 480,
  memory: 420,
  file: 360,
  servers: 360,
};

/** A pane's hard stop (D40). */
export function paneMinWidth(pane: AnyPane | undefined): number {
  return pane ? PANE_MIN_W[pane.kind] : 0;
}

/** The narrowest `node` can draw with every pane at its minimum: a row adds
 *  its children and their seams, a column takes its widest child. */
export function layoutMinWidth(node: LayoutNode, panes: Record<string, AnyPane>): number {
  if (!isSplit(node)) return paneMinWidth(panes[node.pane]);
  const mins = node.children.map((child) => layoutMinWidth(child, panes));
  return node.direction === "row" ? mins.reduce((a, b) => a + b, 0) + (mins.length - 1) * SPLIT_SEAM_W : Math.max(0, ...mins);
}

/** What the tab on screen asks of the stage: a zoomed pane alone, else its
 *  whole layout. A lone pane asks nothing beyond the stage's own floor,
 *  which every lone pane fits. */
export function tabMinWidth(tab: Tab | null | undefined, panes: Record<string, AnyPane>): number {
  if (!tab || tab.zoomed || !isSplit(tab.root)) return 0;
  return layoutMinWidth(tab.root, panes);
}
