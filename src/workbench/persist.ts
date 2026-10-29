// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The workbench on disk: one localStorage key, read synchronously on the
// first frame (the paint-cache rule), written on a debounce from the store
// with a flush on `pagehide`. What is stored is untrusted — a hand-edited
// value, an older build's shape, a truncated write — so the parser accepts
// only what it can vouch for, pane by pane, and drops the rest. The 40
// least-recently-used sets fall off at write time, and `prune` drops what
// the backend no longer has at boot.

import {
  AGENTS_FILLED_CAP,
  RECENT_TABS_CAP,
  CLOSED_CAP,
  DEFAULT_DOOR_DRAFT_KEY,
  HOME_KEY,
  MAX_WALL_TILES,
  SET_CAP,
  WORKBENCH_VERSION,
  emptyTabSet,
  emptyWorkbench,
  isPaneKind,
  isSessionKey,
  normalizeWeights,
  paneIdsOf,
  type AnyPane,
  type ClosedTab,
  type DoorDestination,
  type LayoutNode,
  type SessionKey,
  type Tab,
  type TabSet,
  type WorkbenchState,
} from "./model";
import type { DiffSource } from "../types";
import type { WorkbenchStore } from "./store";

export const WORKBENCH_KEY = "redline.workbench.v1";

/** App's keys this model replaced; read once by `migrateToWorkbenchOnce`,
 *  then removed by `retireLegacyKeys`. */
export const LEGACY_MAIN_SURFACE_KEY = "redline.mainSurface";
export const LEGACY_DOC_PINNED_KEY = "redline.doc.pinned";
export const LEGACY_SPLIT_VERTICAL_KEY = "redline.split.vertical";
export const LEGACY_SPLIT_RATIO_KEY = "redline.split.ratio";
/** The four per-pane booleans `redline.mainSurface` replaced (pre-07/09). */
const LEGACY_PANE_KEYS = ["redline.doc.open", "redline.browser.open", "redline.drafter.open", "redline.review.open"];

export const WRITE_DEBOUNCE_MS = 250;

// ── Untrusted parse ────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str) : []);

const DOOR_DESTINATIONS: readonly DoorDestination[] = ["plan", "chat", "drafter", "browser", "review", "memory", "servers"];
/** Every DiffSource, as a record so a new member is a type error here. */
const DIFF_SOURCE_SET: Record<DiffSource, true> = { uncommitted: true, staged: true, unstagedPlusUntracked: true, lastCommit: true, vsBase: true, commitSha: true };
const isDiffSource = (v: unknown): v is DiffSource => typeof v === "string" && Object.prototype.hasOwnProperty.call(DIFF_SOURCE_SET, v);

function parsePane(raw: unknown): AnyPane | null {
  if (!isRecord(raw) || !str(raw.id) || !isPaneKind(raw.kind)) return null;
  const d = isRecord(raw.data) ? raw.data : {};
  let pane: AnyPane | null = null;
  switch (raw.kind) {
    case "door": {
      const destination = DOOR_DESTINATIONS.find((x) => x === d.destination);
      pane = { id: raw.id, kind: "door", data: { draftKey: str(d.draftKey) && d.draftKey ? d.draftKey : DEFAULT_DOOR_DRAFT_KEY, ...(destination ? { destination } : {}) } };
      break;
    }
    case "plan":
      if (!str(d.sessionId) || !d.sessionId) return null;
      pane = { id: raw.id, kind: "plan", data: { sessionId: d.sessionId, version: typeof d.version === "number" && Number.isFinite(d.version) ? d.version : null } };
      break;
    case "chat":
      if (d.source === "agent" && str(d.terminalId) && d.terminalId) {
        pane = { id: raw.id, kind: "chat", data: { source: "agent", terminalId: d.terminalId, sessionId: str(d.sessionId) && d.sessionId ? d.sessionId : null } };
      } else if (d.source === "companion" && str(d.companionId) && d.companionId) {
        pane = { id: raw.id, kind: "chat", data: { source: "companion", companionId: d.companionId } };
      } else return null;
      break;
    case "terminals": {
      const tiles = strings(d.tiles).filter((t, i, all) => t && all.indexOf(t) === i).slice(0, MAX_WALL_TILES);
      const zoomed = str(d.zoomed) && tiles.includes(d.zoomed) ? d.zoomed : null;
      const focus = typeof d.focus === "number" && Number.isInteger(d.focus) ? Math.max(0, Math.min(tiles.length - 1, d.focus)) : 0;
      pane = { id: raw.id, kind: "terminals", data: { tiles, focus: Math.max(0, focus), zoomed, pinned: strings(d.pinned).filter((t) => tiles.includes(t)) } };
      break;
    }
    case "file":
      if (!str(d.path) || !d.path) return null;
      pane = { id: raw.id, kind: "file", data: { path: d.path, ...(typeof d.line === "number" && Number.isInteger(d.line) && d.line > 0 ? { line: d.line } : {}) } };
      break;
    case "browser":
      pane = { id: raw.id, kind: "browser", data: { workspace: str(d.workspace) && d.workspace ? d.workspace : "regular" } };
      break;
    case "drafter":
      // An empty id is the drafter's own open document (App keeps which).
      if (!str(d.draftId)) return null;
      pane = { id: raw.id, kind: "drafter", data: { draftId: d.draftId } };
      break;
    case "review":
      // An empty repo is the review surface with its own picker.
      if (!str(d.repo) || !isDiffSource(d.source)) return null;
      pane = { id: raw.id, kind: "review", data: { repo: d.repo, source: d.source } };
      break;
    case "servers":
    case "memory":
      pane = { id: raw.id, kind: raw.kind, data: {} };
      break;
  }
  if (!pane) return null;
  if (raw.preview === true) pane.preview = true;
  if (str(raw.titleOverride) && raw.titleOverride) pane.titleOverride = raw.titleOverride;
  return pane;
}

/** A layout whose every leaf names a pane in `panes`; unknown leaves are
 *  dropped, one-child splits collapse, nothing left is null. */
function parseLayout(raw: unknown, panes: Record<string, AnyPane>, seen: Set<string>): LayoutNode | null {
  if (!isRecord(raw)) return null;
  if (str(raw.pane)) {
    if (!panes[raw.pane] || seen.has(raw.pane)) return null;
    seen.add(raw.pane);
    return { pane: raw.pane };
  }
  if (raw.split !== true || !Array.isArray(raw.children)) return null;
  const direction = raw.direction === "column" ? "column" : "row";
  const children: LayoutNode[] = [];
  const weights: number[] = [];
  const rawWeights = Array.isArray(raw.weights) ? raw.weights : [];
  raw.children.forEach((child, i) => {
    const node = parseLayout(child, panes, seen);
    if (!node) return;
    children.push(node);
    weights.push(typeof rawWeights[i] === "number" ? (rawWeights[i] as number) : 1);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { split: true, direction, children, weights: normalizeWeights(weights, children.length) };
}

function parseTab(raw: unknown, panes: Record<string, AnyPane>): Tab | null {
  if (!isRecord(raw) || !str(raw.id)) return null;
  const root = parseLayout(raw.root, panes, new Set());
  if (!root) return null;
  const ids = paneIdsOf(root);
  const focusedPaneId = str(raw.focusedPaneId) && ids.includes(raw.focusedPaneId) ? raw.focusedPaneId : ids[0];
  // A zoom comes back only as the reducer keeps it: the focused pane of a
  // split.
  const zoomed = ids.length > 1 && raw.zoomed === focusedPaneId ? focusedPaneId : undefined;
  return zoomed ? { id: raw.id, root, focusedPaneId, zoomed } : { id: raw.id, root, focusedPaneId };
}

function parseClosed(raw: unknown): ClosedTab | null {
  if (!isRecord(raw) || !Array.isArray(raw.panes)) return null;
  const panes: Record<string, AnyPane> = {};
  const list: AnyPane[] = [];
  for (const p of raw.panes) {
    const pane = parsePane(p);
    if (pane && !panes[pane.id]) {
      panes[pane.id] = pane;
      list.push(pane);
    }
  }
  const tab = parseTab(raw.tab, panes);
  if (!tab) return null;
  const kept = new Set(paneIdsOf(tab.root));
  return { tab, panes: list.filter((p) => kept.has(p.id)), index: typeof raw.index === "number" && Number.isInteger(raw.index) ? Math.max(0, raw.index) : 0 };
}

function parseSet(raw: unknown): TabSet | null {
  if (!isRecord(raw)) return null;
  const panes: Record<string, AnyPane> = {};
  if (isRecord(raw.panes)) {
    for (const [id, p] of Object.entries(raw.panes)) {
      const pane = parsePane(p);
      if (pane && pane.id === id) panes[id] = pane;
    }
  }
  const tabs: Record<string, Tab> = {};
  const used = new Set<string>();
  if (isRecord(raw.tabs)) {
    for (const [id, t] of Object.entries(raw.tabs)) {
      const tab = parseTab(t, panes);
      if (!tab || tab.id !== id) continue;
      // A pane belongs to one tab; a second claim loses its tab.
      const ids = paneIdsOf(tab.root);
      if (ids.some((p) => used.has(p))) continue;
      ids.forEach((p) => used.add(p));
      tabs[id] = tab;
    }
  }
  // Panes no tab shows are dead weight.
  for (const id of Object.keys(panes)) if (!used.has(id)) delete panes[id];
  const order = strings(raw.order).filter((id, i, all) => tabs[id] && all.indexOf(id) === i);
  for (const id of Object.keys(tabs)) if (!order.includes(id)) order.push(id);
  const activeTabId = str(raw.activeTabId) && tabs[raw.activeTabId] ? raw.activeTabId : (order[0] ?? null);
  const closed = (Array.isArray(raw.closed) ? raw.closed : []).map(parseClosed).filter((c): c is ClosedTab => c !== null).slice(-CLOSED_CAP);
  const agentsFilled = strings(raw.agentsFilled).filter((id, i, all) => id && all.indexOf(id) === i).slice(-AGENTS_FILLED_CAP);
  const recent = strings(raw.recent).filter((id, i, all) => tabs[id] && id !== activeTabId && all.indexOf(id) === i).slice(0, RECENT_TABS_CAP);
  return {
    order, activeTabId, tabs, panes, closed,
    ...(agentsFilled.length ? { agentsFilled } : {}),
    ...(recent.length ? { recent } : {}),
  };
}

/** The state a stored value describes, or null when it is not a workbench
 *  at all. Partial damage is repaired, never fatal. */
export function parseWorkbench(raw: unknown): WorkbenchState | null {
  if (!isRecord(raw) || raw.v !== WORKBENCH_VERSION) return null;
  const sets: WorkbenchState["sets"] = {};
  if (isRecord(raw.sets)) {
    for (const [key, value] of Object.entries(raw.sets)) {
      if (!isSessionKey(key)) continue;
      const set = parseSet(value);
      if (set) sets[key] = set;
    }
  }
  if (!sets.home) sets.home = emptyTabSet();
  const mru = strings(raw.mru).filter((k, i, all): k is SessionKey => isSessionKey(k) && sets[k] !== undefined && all.indexOf(k) === i);
  for (const k of Object.keys(sets) as SessionKey[]) if (!mru.includes(k)) mru.push(k);
  const owners: Record<string, SessionKey> = {};
  if (isRecord(raw.owners)) {
    for (const [pty, key] of Object.entries(raw.owners)) if (pty && isSessionKey(key) && sets[key]) owners[pty] = key;
  }
  const activeKey = isSessionKey(raw.activeKey) && sets[raw.activeKey] ? raw.activeKey : HOME_KEY;
  return {
    v: WORKBENCH_VERSION,
    activeKey,
    sets,
    mru,
    owners,
    stowed: strings(raw.stowed).filter((p, i, all) => p && all.indexOf(p) === i),
  };
}

/** Keep Home plus the `cap` most recently used sets. Sets missing from the
 *  mru count as the oldest. */
export function trimSets(state: WorkbenchState, cap = SET_CAP): WorkbenchState {
  const keys = Object.keys(state.sets) as SessionKey[];
  if (keys.length <= cap) return state;
  const ranked = [...state.mru.filter((k) => k !== HOME_KEY && state.sets[k]), ...keys.filter((k) => k !== HOME_KEY && !state.mru.includes(k))];
  const keep = new Set<SessionKey>([HOME_KEY, ...ranked.slice(0, Math.max(0, cap - 1))]);
  const sets: WorkbenchState["sets"] = {};
  for (const k of keys) if (keep.has(k)) sets[k] = state.sets[k];
  const owners: Record<string, SessionKey> = {};
  for (const [pty, key] of Object.entries(state.owners)) owners[pty] = keep.has(key) ? key : HOME_KEY;
  return {
    ...state,
    sets,
    owners,
    mru: state.mru.filter((k) => keep.has(k)),
    activeKey: keep.has(state.activeKey) ? state.activeKey : HOME_KEY,
  };
}

// ── Storage ────────────────────────────────────────────────────────────────

/** The stored workbench, or an empty one. Synchronous: the first frame
 *  reads it. */
export function readWorkbench(storage: Pick<Storage, "getItem">): WorkbenchState {
  try {
    const raw = storage.getItem(WORKBENCH_KEY);
    if (raw == null) return emptyWorkbench();
    return parseWorkbench(JSON.parse(raw)) ?? emptyWorkbench();
  } catch {
    return emptyWorkbench();
  }
}

export function writeWorkbench(storage: Pick<Storage, "setItem">, state: WorkbenchState): boolean {
  try {
    storage.setItem(WORKBENCH_KEY, JSON.stringify(trimSets(state)));
    return true;
  } catch {
    return false;
  }
}

export interface PersistOptions {
  debounceMs?: number;
  /** Where `pagehide` fires; defaults to `window` when there is one. */
  target?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
}

/** Write the store on a debounce, flush on `pagehide`. Returns a stop that
 *  also flushes. */
export function persistWorkbench(store: WorkbenchStore, storage: Pick<Storage, "setItem">, opts: PersistOptions = {}): () => void {
  const delay = opts.debounceMs ?? WRITE_DEBOUNCE_MS;
  const target = opts.target === undefined ? (typeof window !== "undefined" ? window : null) : opts.target;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    writeWorkbench(storage, store.getState());
  };
  const unsubscribe = store.subscribe(() => {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delay);
  });
  target?.addEventListener("pagehide", flush);
  return () => {
    unsubscribe();
    target?.removeEventListener("pagehide", flush);
    flush();
  };
}

// ── Boot ───────────────────────────────────────────────────────────────────

/** Every launch lands on Home's door (what `bootOnFrontDoor` did for the
 *  surface key): Home is the active set, and its active tab is a door — the
 *  first one it has, or a new one in front. The other sets keep their tabs
 *  for when their session is selected. */
export function bootToHome(state: WorkbenchState, opts: { tabId?: string; paneId?: string } = {}): WorkbenchState {
  // By hand rather than through the reducer: this runs on the first frame,
  // and the reducer is a lazy chunk (store.ts).
  const home = state.sets.home ?? emptyTabSet();
  const door = home.order.find((tabId) => {
    const tab = home.tabs[tabId];
    return tab && paneIdsOf(tab.root).some((id) => home.panes[id]?.kind === "door");
  });
  let next: TabSet;
  if (door) {
    next = home.activeTabId === door ? home : { ...home, activeTabId: door };
  } else {
    const paneId = opts.paneId ?? `pane-boot-door-${Date.now().toString(36)}`;
    const tabId = opts.tabId ?? `tab-boot-door-${Date.now().toString(36)}`;
    next = {
      ...home,
      order: [tabId, ...home.order],
      activeTabId: tabId,
      tabs: { ...home.tabs, [tabId]: { id: tabId, root: { pane: paneId }, focusedPaneId: paneId } },
      panes: { ...home.panes, [paneId]: { id: paneId, kind: "door", data: { draftKey: DEFAULT_DOOR_DRAFT_KEY } } },
    };
  }
  return {
    ...state,
    activeKey: HOME_KEY,
    mru: [HOME_KEY, ...state.mru.filter((k) => k !== HOME_KEY)],
    sets: { ...state.sets, home: next },
  };
}

// ── Migration ──────────────────────────────────────────────────────────────

function readJson(storage: Pick<Storage, "getItem">, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const SURFACE_KINDS = ["browser", "drafter", "review", "servers", "memory", "chat"] as const;

/** One-time: Home's first tab from what App persisted — `redline.mainSurface`
 *  (a surface beside the door when `doc.pinned`, split by `split.*`), else a
 *  door. Idempotent on the workbench key; `retireLegacyKeys` removes what it
 *  read once it has run. Returns the state written, or null when there was
 *  nothing to do. */
export function migrateToWorkbenchOnce(storage: Pick<Storage, "getItem" | "setItem">, opts: { draftKey?: string; tabIds?: string[]; paneIds?: string[] } = {}): WorkbenchState | null {
  try {
    if (storage.getItem(WORKBENCH_KEY) != null) return null;
  } catch {
    return null;
  }
  const surface = readJson(storage, LEGACY_MAIN_SURFACE_KEY);
  const pinned = readJson(storage, LEGACY_DOC_PINNED_KEY) === true;
  const vertical = readJson(storage, LEGACY_SPLIT_VERTICAL_KEY) === true;
  const ratioRaw = readJson(storage, LEGACY_SPLIT_RATIO_KEY);
  const ratio = typeof ratioRaw === "number" && ratioRaw > 0 && ratioRaw < 1 ? ratioRaw : 0.5;
  const kind = SURFACE_KINDS.find((k) => k === surface);
  const draftKey = opts.draftKey ?? DEFAULT_DOOR_DRAFT_KEY;
  const tabId = opts.tabIds?.[0] ?? "tab-home-1";
  const doorId = opts.paneIds?.[0] ?? "pane-home-door";
  const surfaceId = opts.paneIds?.[1] ?? "pane-home-surface";

  const door: AnyPane = { id: doorId, kind: "door", data: { draftKey } };
  const panes: Record<string, AnyPane> = {};
  let root: LayoutNode;
  let focusedPaneId: string;
  // Only the kinds that open with nothing but their kind can be restored
  // from a bare surface name: a chat room, drafter draft or review target
  // was never in these keys, so those land on the door.
  const restorable = kind === "browser" || kind === "servers" || kind === "memory";
  if (restorable) {
    const surfacePane: AnyPane = kind === "browser" ? { id: surfaceId, kind, data: { workspace: "regular" } } : { id: surfaceId, kind, data: {} };
    panes[surfaceId] = surfacePane;
    if (pinned) {
      panes[doorId] = door;
      root = { split: true, direction: vertical ? "column" : "row", children: [{ pane: doorId }, { pane: surfaceId }], weights: normalizeWeights([ratio, 1 - ratio], 2) };
    } else {
      root = { pane: surfaceId };
    }
    focusedPaneId = surfaceId;
  } else {
    panes[doorId] = door;
    root = { pane: doorId };
    focusedPaneId = doorId;
  }
  const state: WorkbenchState = {
    ...emptyWorkbench(),
    sets: { home: { order: [tabId], activeTabId: tabId, tabs: { [tabId]: { id: tabId, root, focusedPaneId } }, panes, closed: [] } },
  };
  return writeWorkbench(storage, state) ? state : null;
}

/** Every boot, after `migrateToWorkbenchOnce`: the keys the workbench
 *  replaced are gone, so nothing can read a stale surface or doc pin back
 *  (the workbench is the one record of what the centre shows). */
export function retireLegacyKeys(storage: Pick<Storage, "removeItem">): void {
  for (const key of [LEGACY_MAIN_SURFACE_KEY, LEGACY_DOC_PINNED_KEY, LEGACY_SPLIT_VERTICAL_KEY, LEGACY_SPLIT_RATIO_KEY, ...LEGACY_PANE_KEYS]) {
    try {
      storage.removeItem(key);
    } catch {
      /* storage unavailable — nothing to retire */
    }
  }
}
