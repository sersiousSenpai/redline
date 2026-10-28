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
// `persist.ts` keeps it, `legacy.ts` reads it back in App's old vocabulary
// while the two coexist. Pure, unit-tested like `tilePolicy.ts`.

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

/** The sentence the Front Door shares with the footer pill's compact
 *  composer (`FRONT_DOOR_TEXT_KEY`): Home's first door keeps sharing it, so
 *  the pill and the door tab are one draft. Spelled here so the model stays
 *  a leaf; `legacy.test.ts` pins it to the real constant. */
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
  | "run"
  | "chat"
  | "drafter"
  | "browser"
  | "review"
  | "memory"
  | "servers"
  | "runs";

/** What a pane can show. The three document faces (`door`, `plan`, `file`)
 *  are what `documentPlate.ts` calls the plate; the rest are the surfaces
 *  the header radio used to point at, plus the agent / companion chat. */
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
  | "memory"
  | "runs";

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
  "runs",
];

export function isPaneKind(value: unknown): value is PaneKind {
  return typeof value === "string" && (PANE_KINDS as readonly string[]).includes(value);
}

/** The kinds that are "the document" in App's old vocabulary: a door, a
 *  plan, or a file in the viewer. Everything else is a surface. */
export const DOCUMENT_KINDS: readonly PaneKind[] = ["door", "plan", "file"];

/** Whether a pane kind is one of the plate's document faces. */
export function isDocumentKind(kind: PaneKind): boolean {
  return DOCUMENT_KINDS.includes(kind);
}

/** The kinds that open in the current set and never navigate you away. */
export const GLOBAL_KINDS: readonly PaneKind[] = [
  "memory",
  "servers",
  "runs",
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
  runs: Record<string, never>;
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
}

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

// ── Layout helpers (pure, shared by the reducer and the adapter) ───────────

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

/** The pane ids a set is showing: its active tab's, in reading order. */
export function visiblePaneIds(set: TabSet): string[] {
  const tab = activeTabOf(set);
  return tab ? paneIdsOf(tab.root) : [];
}

/** Which visible pane of `kind` holds a singleton body (the plan, the
 *  browser): the pane "Bring here" asked for, while it is on screen; else
 *  the focused one; else the first. Exactly one holds; the others show
 *  where it went. */
export function singletonHolder(state: WorkbenchState, kind: PaneKind, asked: string | null): string | undefined {
  const set = state.sets[state.activeKey];
  const tab = set && activeTabOf(set);
  const ids: unknown[] = tab ? paneIdsOf(tab.root).filter((id) => set.panes[id]?.kind === kind) : [];
  return [asked, tab?.focusedPaneId, ids[0]].find((id) => ids.includes(id)) as string | undefined;
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
    case "runs":
      return "Runs";
  }
}
