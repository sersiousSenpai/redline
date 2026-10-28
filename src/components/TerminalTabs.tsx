// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { homeDir } from "@tauri-apps/api/path";
import { usePersistedState } from "../theme/usePersistedState";
import { usePoll } from "../hooks/usePoll";
import {
  attachRepos,
  bumpMru,
  orderOpenRows,
  orderRepos,
  repoChoices,
  type TerminalRef,
} from "../lib/terminalMenu";
import {
  evenAt,
  gridShapeFor,
  gutters,
  normalizeFractions,
  putFractions,
  resizeAt,
  seedFromLegacyRatio,
  shapeKey,
  tileRects,
  TILE_HEADER_H,
  type FractionStore,
  type GridShape,
  type Gutter,
  type SizePx,
  type TileRect,
} from "../lib/tileGrid";
import { setTile as setTileSlot } from "../lib/tileSlots";
import { tileAtPoint, type TileBox } from "../lib/tilePolicy";
import { beginTerminalSwap } from "../lib/terminalSwap";
import { isAnswerInput } from "../lib/terminalInput";
import { beginMeasure, endMeasure } from "../workbench/perf";
import type { WallData } from "../workbench/model";
import { EMPTY_WALL, sameWall } from "../workbench/wall";
import { rafCoalesce } from "../lib/raf";
import { isResizing, onResizeSession } from "../lib/resizeSession";
import { workSignal } from "../lib/termTitle";
import {
  ackForInput,
  attentionText,
  deriveTermState,
  effectiveAttention,
  isLoud,
  loudOldestFirst,
  mergeAttention,
  mergeProcs,
  nextNeedsYou,
  putAck,
  SEEN_AFTER_MS,
  staleAcks,
  type AttentionAck,
  type TermState,
} from "../lib/termState";
import type { TermAttention, TermProc } from "../types";
import { iconFor } from "../lib/repoIcon";
import { useRepoIcons } from "../hooks/useRepoIcons";
import type { LoudTerminal } from "../lib/attentionAlerts";
import type { ProjectOption } from "./ProjectPicker";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  TerminalView,
  enqueuePtyOp,
  focusTerminalView,
} from "./TerminalView";
import { deliverToTerminal } from "../lib/terminalHandoff";
import { tauriHandoffDeps } from "../lib/terminalSeams";
import {
  TerminalTileHeader,
  type TerminalIdentity,
} from "./TerminalTileHeader";
import {
  TerminalMenuDataContext,
  type TerminalMenuData,
  type TileActions,
} from "./TerminalTileMenu";
import { TileGutter } from "./TileGutter";
import { CloseConfirmModal } from "./CloseConfirmModal";
import {
  readTerminalWorkspace,
  saveTerminalWorkspace,
  type LivePty,
  type TerminalWorkspace,
} from "../lib/terminalWorkspace";

interface Tab {
  id: string;
  /** cwd this tab's shell was spawned in (null = $HOME, resolved backend). */
  cwd: string | null;
  /** A convenience shell an older build auto-spawned into its dock; cleared
   *  the moment the user touches it. Nothing makes one any more. */
  placeholder?: boolean;
  /** A name the user gave it (the tile menu's Rename). */
  title?: string;
}

/** What the host shows about a terminal outside the wall: its state (one
 *  derivation, lib/termState) and the label its tile wears. */
export interface TerminalStatus {
  state: TermState;
  label: string;
}

interface TerminalTabsProps {
  theme: string;
  /** The wall on screen: which terminals pane's tiles, focus, zoom and pins
   *  this one component shows (`wall`). A wall is a view over the terminals,
   *  not their owner: every terminal's view stays mounted whichever wall is
   *  shown, so changing `wallKey` re-points tiles in one render — no xterm
   *  is rebuilt and no PTY reattached. Null when no wall is on screen. */
  wallKey: string | null;
  /** The pane data behind `wallKey`. A change from outside (a reveal adding
   *  a tile, another wall taking one) is adopted; what this component changes
   *  itself goes back through `onWallChange`. */
  wall: WallData | null;
  onWallChange?: (wallKey: string, wall: WallData) => void;
  /** A terminal opened here (the tile menu's new terminal rows) needs a
   *  wall: the host places it — on this wall while it has room, else in a
   *  new tab — and the new wall data comes back through `wall`. */
  onPlaceTerminal?: (id: string) => void;
  onTabsChange: (count: number) => void;
  /** The live terminal ids, whenever that SET changes (not on every cwd or
   *  title update). A host driving a specific terminal — the front door
   *  waiting on a plan it launched — needs to know when that one goes away,
   *  which a count can't tell it: close one and open another and the count
   *  never moved. */
  onTabIdsChange?: (ids: string[]) => void;
  /** How many terminals need you (needs-you, or an unread your-turn) —
   *  the footer's "N need you" chip and the ⌘⇧J gate. */
  onNeedsYouChange?: (count: number) => void;
  /** Every terminal's state and label, whenever one changes: the host's tab
   *  dots, the sidebar's nested terminal rows and the close-a-wall prompt
   *  read these, so nothing outside the wall derives a state of its own. */
  onStatesChange?: (states: ReadonlyMap<string, TerminalStatus>) => void;
  /** No wall is on screen, so no tile is really visible: the fleet poll
   *  and its `lsof` stop, and a terminal's output counts as unseen. */
  collapsed: boolean;
  /** Notified whenever the focused terminal changes. The host (App) uses this
   *  to route post-submit PTY injects and cwd-follow polling to whichever
   *  terminal the reviewer is currently watching. Best-effort: a "wrong" tile
   *  is still strictly better than the alternative of no inject at all. */
  onActiveTabChange?: (id: string) => void;
  /** The focused terminal's live cwd, whenever it or the focus moves — read
   *  by the fleet poll, so the host can follow a `cd` without an `lsof` loop
   *  of its own. */
  onFocusedCwd?: (id: string, cwd: string) => void;
  /** Terminals whose `claude` is currently held awaiting review. Each
   *  such terminal gets its own "plan intercepted by redline" strip inside
   *  its tile, so the grid shows the truth per tile. */
  heldTerminalIds?: ReadonlySet<string>;
  /** What each held terminal is stopped on, by tab id — the plan's title. The
   *  tile menu names it, so a row says which piece of work that terminal is,
   *  not just where it is. */
  heldPlanTitles?: ReadonlyMap<string, string>;
  /** Recent repo directories for the tile menu's NEW TERMINAL IN section. The
   *  same list the drafter's launch picker uses. */
  projectOptions?: readonly ProjectOption[];
  /** Which session each terminal belongs to, as the tile menu groups them:
   *  `others` names the session of every terminal that is not the set on
   *  screen's ("Other sessions"; picking one moves it here). Absent, every
   *  terminal is this session's. */
  others?: ReadonlyMap<string, string>;
  /** Agent terminals and the session each runs (fork / resume). */
  agentSessions?: ReadonlyMap<string, string>;
  /** The tile menu's Fork / Resume for an agent terminal. */
  onSessionAction?: (kind: "fork" | "resume", terminalId: string) => void;
  /** An Agent pane's CLI view: this one terminal alone, filling the
   *  layer, with no tile header or gutters — the session's own PTY in its
   *  pane. A view, like a zoom: no shell is spawned or killed, the
   *  wall's tiles are left exactly as they were, and every other terminal
   *  stays mounted underneath (display:none). An id that isn't open is
   *  ignored. */
  solo?: string | null;
}

// The tile cap is the workbench's (`MAX_WALL_TILES`): a full wall opens a
// new tab instead of giving a tile away. The shape math handles any n
// (tested to n=24), the shared graphics allocator (TerminalView) gives tiles
// past its ceiling xterm's DOM renderer, and `MAX_STORED_SHAPES` covers the
// spread of `n@rowsxcols` keys.

/** How many repos the menu offers and how deep the click-order memory runs. */
const MAX_MENU_REPOS = 12;

/** How many evictions the menu's "put that back" ordering remembers. */
const MAX_UNTILED_MRU = 32;

/** Pointer travel before a press on a header or shelf chip becomes a drag —
 *  under it, the press is the chip's ordinary click. */
const DRAG_THRESHOLD_PX = 4;

/** The fleet poll's tick: every visible tile's live cwd (a kernel read per
 *  shell, no fork) and the process sample. Twelve seconds, and only while
 *  the dock is open: a label that follows a `cd` a few seconds late costs
 *  nothing, and the events that matter (a tile shown, the focus moved, the
 *  menu opened) sample at once. */
const FLEET_POLL_MS = 12_000;

/** How often `pty_procs` samples every terminal's foreground program and
 *  ports — the one fork left, a system-wide `lsof` of listening sockets
 *  (perf-budget rule 5) — every fleet tick, while tiles are on screen. */
const PROCS_POLL_MS = FLEET_POLL_MS;

/** The intercept strip. Text can't be injected into the held PTY, so this fakes
 *  one line of terminal output: terminal bg + mono font + matching padding so
 *  it sits on the glyph grid and reads as native output. Click-through, so the
 *  shell underneath stays usable. Pinned to the bottom of whichever tile hosts
 *  the held terminal — the tile wrapper is `position: absolute`, so it is the
 *  containing block. */
function InterceptStrip() {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 20,
        pointerEvents: "none",
        background: "var(--color-paper)",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        lineHeight: "18px",
        padding: "2px 8px",
        color: "var(--color-warning)",
        whiteSpace: "pre",
        overflow: "hidden",
      }}
    >
      {"── plan intercepted by redline ──"}
    </div>
  );
}

/** Imperative handle so the host (App) can drive terminal selection — used by
 *  the reverse of linked navigation: clicking a folder tab focuses the
 *  terminal that lives in that folder. */
export interface TerminalTabsHandle {
  /** Flash a one-shot ring around a terminal's tile. `selectTab` puts the
   *  right tile under the focus ring; on a wall of fourteen that is not
   *  always where the eye is. Purely decorative — a no-op for an id that
   *  isn't open, or isn't currently tiled. */
  hailTerminal: (id: string) => void;
  /** Open a fresh terminal in `cwd` and return its id so the host can drive
   *  it (e.g. "Restore plan session" writes `claude --resume …` into it).
   *  cwd null → backend resolves to $HOME. The PTY spawns and the shell
   *  runs whether or not a wall shows it (every terminal's `<TerminalView>`
   *  stays mounted; one off the wall is `display:none`): where it shows is
   *  the host's call, through the workbench (`revealTerminal`). */
  openSessionTerminal: (cwd: string | null) => string;
  /** ⌘⇧J: the next terminal that needs you, across every session — the one
   *  visited longest ago (lib/termState), so each press lands on the next and
   *  the visit is recorded — or null when nothing does. The host selects its
   *  session, then its Agent tab or its wall and tile, and hails it. */
  nextNeedsYou: () => string | null;
  /** Hand a terminal's view the caret (a jump to a tile already on screen
   *  has no reveal transition to do it). */
  focusTerminal: (id: string) => void;
  /** Terminate terminals (a closed wall's, when the user says so): each
   *  shell is killed and its tile, wherever it is on screen, collapses. */
  closeTerminals: (ids: readonly string[]) => void;
  /** Which of `ids` are still running anything, sampled NOW (one
   *  `pty_procs` read, whatever the fleet poll last saw): a shell's
   *  foreground is only known once sampled, and closing a wall must never
   *  end a process it merely had not looked at. A terminal with no sample
   *  counts as running; only an idle shell or an exited process does not. */
  runningNow: (ids: readonly string[]) => Promise<string[]>;
  /** ⌘D in a wall: a new tile, in the focused tile's directory, placed by
   *  the host's rule (this wall while it has room, a new tab once full). */
  addTileHere: () => void;
  /** ⌘⇧↩ in a wall: zoom the focused tile, or put a zoomed one back. */
  toggleZoomFocused: () => void;
}

/** Trailing-slash-insensitive path compare key. */
function normPath(p: string): string {
  return p.replace(/\/+$/, "") || "/";
}

/** The directory a terminal's label and repo mark describe — its live cwd,
 *  normalized — or null when that's `$HOME` or `/`.
 *
 *  A bare shell in either isn't in a project, so it gets the "zsh" label and no
 *  repo lookup at all: `$HOME` has no `.git`, so resolving it would hand the tab
 *  a monogram for the user's own account name. */
function tabProjectDir(
  dir: string | null | undefined,
  homePath: string | null,
): string | null {
  if (!dir) return null;
  const n = normPath(dir);
  if (n === "/" || (homePath !== null && n === homePath)) return null;
  return n;
}

/** A terminal's label: the basename of its project directory, or "zsh". */
function tabBaseLabel(dir: string | null): string {
  return dir === null ? "zsh" : dir.slice(dir.lastIndexOf("/") + 1) || "zsh";
}

/** `/Users/me/redline` → `~/redline`, so a tooltip stays readable. */
function tildeify(path: string, homePath: string | null): string {
  if (homePath && (path === homePath || path.startsWith(`${homePath}/`))) {
    return `~${path.slice(homePath.length)}`;
  }
  return path;
}

const pct = (v: number) => `${v * 100}%`;

// Owns the set of terminals and their lifecycle. Every terminal's
// <TerminalView> stays mounted (shells + scrollback persist); the ones shown
// are the TILES of the wall on screen — an ordered list of up to MAX_TILES
// terminal ids arranged by lib/tileGrid into a resizable grid. A wall is a
// terminals pane's data (`wall`, keyed `wallKey`): changing which wall, or
// which terminal a tile shows, is purely a view change — it never
// spawns-and-kills shells and never reattaches a PTY, so sessions and
// scrollback survive and one PTY has one attachment. Labels are
// project-aware: each terminal is named after its live cwd's basename,
// numbered per project in creation order ("redline 1, redline 2, zsh 1") —
// $HOME and / fall back to "zsh".
//
// Every tile carries its own 26px header (state badge, repo mark, label, ▾
// menu); the menu is the fleet's single inventory. Each terminal has a
// derived state (lib/termState) the headers, the menu, the host's tab dots
// and sidebar rows all read. Nothing is ever taken off a wall on its own: a
// tile changes only when the user (or the host, on the user's behalf) asks.
//
// Memoized: an unrelated App state change must not walk the whole terminal
// fleet's tree.
export const TerminalTabs = memo(
  forwardRef<TerminalTabsHandle, TerminalTabsProps>(
  function TerminalTabs(
    {
      theme,
      wallKey,
      wall,
      onWallChange,
      onPlaceTerminal,
      onTabsChange,
      onTabIdsChange,
      onNeedsYouChange,
      onStatesChange,
      collapsed,
      onActiveTabChange,
      onFocusedCwd,
      heldTerminalIds,
      heldPlanTitles,
      projectOptions,
      others,
      agentSessions,
      onSessionAction,
      solo = null,
    }: TerminalTabsProps,
    ref,
  ) {
  const [initialWorkspace] = useState<TerminalWorkspace>(
    () => readTerminalWorkspace() ?? { tabs: [] },
  );
  const [tabs, setTabsState] = useState<Tab[]>(initialWorkspace.tabs);
  const tabsRef = useRef(tabs);
  // Imperative launch/restore can open several terminals before React renders.
  // Keep refs current at the mutation, so two launches cannot overwrite one
  // another's tab.
  const setTabs = useCallback((next: Tab[] | ((prev: Tab[]) => Tab[])) => {
    const value = typeof next === "function" ? next(tabsRef.current) : next;
    tabsRef.current = value;
    setTabsState(value);
  }, []);

  // ── The wall on screen ────────────────────────────────────────────────────
  //
  // Local mirrors of the wall's four values, so a gesture paints in the frame
  // it happens in and successive imperative operations read what the last one
  // wrote. What THIS component changes marks the wall dirty and goes back to
  // the host after the commit (`onWallChange`); what the host changes (a new
  // `wall` object that differs from ours, or another `wallKey`) is adopted
  // during render, so the commit that brings it is the one that paints it.
  const known = (ids: readonly string[]) => ids.filter((id) => tabsRef.current.some((t) => t.id === id));
  const firstWall = wall ?? EMPTY_WALL;
  const [tiles, setTilesState] = useState<readonly string[]>(() => known(firstWall.tiles));
  const tilesRef = useRef(tiles);
  const dirtyRef = useRef(false);
  const setTiles = useCallback((next: readonly string[]) => {
    dirtyRef.current = true;
    tilesRef.current = next;
    setTilesState(next);
  }, []);
  const [focusedTile, setFocusedTileState] = useState(firstWall.focus);
  const setFocusedTile = useCallback((next: number) => {
    dirtyRef.current = true;
    setFocusedTileState(next);
  }, []);
  // One tile temporarily taking the whole wall (menu row / header
  // double-click). Stored as the terminal id and DERIVED against `tiles`, so
  // a closed terminal can never leave the wall stuck zoomed.
  const [zoomedId, setZoomedIdState] = useState<string | null>(firstWall.zoomed);
  const setZoomedId = useCallback((next: string | null | ((prev: string | null) => string | null)) => {
    dirtyRef.current = true;
    setZoomedIdState(next);
  }, []);
  // Tiles pinned on this wall: the user's own "keep this here".
  const [pinned, setPinnedState] = useState<ReadonlySet<string>>(() => new Set(firstWall.pinned));
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const setPinned = useCallback((next: (prev: ReadonlySet<string>) => ReadonlySet<string>) => {
    dirtyRef.current = true;
    setPinnedState(next);
  }, []);

  const [adopted, setAdopted] = useState<{ key: string | null; wall: WallData | null }>({ key: wallKey, wall });
  if (adopted.key !== wallKey || adopted.wall !== wall) {
    const keyChanged = adopted.key !== wallKey;
    setAdopted({ key: wallKey, wall });
    const incoming = wall ?? EMPTY_WALL;
    const local: WallData = { tiles: [...tiles], focus: focusedTile, zoomed: zoomedId, pinned: [...pinned] };
    if (keyChanged || !sameWall(incoming, local)) {
      // `wb:terminal-swap` runs from here to the first frame painted with
      // the new wall (`beginTerminalSwap`, in the layout effect below).
      if (keyChanged && wallKey !== null) beginMeasure("wb:terminal-swap");
      const nextTiles = known(incoming.tiles);
      tilesRef.current = nextTiles;
      setTilesState(nextTiles);
      setFocusedTileState(incoming.focus);
      setZoomedIdState(incoming.zoomed);
      setPinnedState(new Set(incoming.pinned));
      dirtyRef.current = false;
    }
  }
  // The swap's frame: hold the tiles' fits and show work until it has
  // painted, then end the measure (lib/terminalSwap).
  const swapKeyRef = useRef(wallKey);
  useLayoutEffect(() => {
    if (swapKeyRef.current === wallKey) return;
    swapKeyRef.current = wallKey;
    if (wallKey !== null) beginTerminalSwap(() => endMeasure("wb:terminal-swap"));
  }, [wallKey]);

  // Local answers to the agents' attention transitions (lib/termState):
  // typed into, interrupted, read. Persisted with the tabs so a reload
  // doesn't relight every your-turn already read.
  const [acks, setAcksState] = useState<ReadonlyMap<string, AttentionAck>>(
    () => new Map(Object.entries(initialWorkspace.acks ?? {})),
  );
  const acksRef = useRef(acks);
  const setAcks = useCallback(
    (
      next: (
        prev: ReadonlyMap<string, AttentionAck>,
      ) => ReadonlyMap<string, AttentionAck>,
    ) => {
      const value = next(acksRef.current);
      if (value === acksRef.current) return;
      acksRef.current = value;
      setAcksState(value);
    },
    [],
  );
  const workspaceRef = useRef<TerminalWorkspace>(initialWorkspace);
  workspaceRef.current = {
    tabs,
    ...(acks.size ? { acks: Object.fromEntries(acks) } : {}),
  };
  useEffect(() => {
    saveTerminalWorkspace(workspaceRef.current);
  }, [tabs, acks]);
  useEffect(() => {
    const save = () => saveTerminalWorkspace({
      ...workspaceRef.current,
      tabs: tabsRef.current,
    });
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      save();
    };
  }, []);
  const [detached, setDetached] = useState<LivePty[]>([]);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    let gone = false;
    const owned = new Set(tabsRef.current.map((tab) => tab.id));
    void invoke<LivePty[]>("pty_list").then((list) => {
      if (!gone) setDetached(list.filter((pty) => pty.alive && !owned.has(pty.id)));
    }).catch(() => {
      if (!gone) setRecoveryError("Couldn't check for detached terminals.");
    });
    return () => { gone = true; };
  }, []);
  const [fractionStore, setFractionStore] = usePersistedState<FractionStore>(
    "redline.terminalGrid.fractions",
    {},
    // A gutter drag commits once per release; the debounce batches the
    // localStorage writes off the interaction.
    { debounceMs: 250 },
  );
  // Most-recently-evicted terminals lead the menu's off-wall rows, so "put
  // that back" after re-pointing a tile is one click.
  const [untiledMru, setUntiledMru] = useState<readonly string[]>([]);
  // Click order for the menu's repo rows: the repo you opened a terminal in
  // last leads, ahead of the host's own recency order.
  const [recentDirs, setRecentDirs] = usePersistedState<string[]>(
    "redline.terminalPane.recentDirs",
    [],
  );
  const [unseen, setUnseen] = useState<Set<string>>(() => new Set());
  // Set when a window-close is intercepted because a terminal has moved off its
  // start dir; drives the Redline-styled confirmation modal.
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  // Clamp at READ time, not in an effect: an effect would give one render
  // where focusedId is undefined and onActiveTabChange(undefined) would reach
  // App's setActiveTermId, which routes post-submit PTY injects.
  const focusIdx = Math.max(0, Math.min(focusedTile, tiles.length - 1));
  const focusedId = tiles[focusIdx] as string | undefined;
  const zoomed = zoomedId !== null && tiles.includes(zoomedId) ? zoomedId : null;
  // Derived against `tabs`, like the zoom: a closed terminal can never leave
  // the layer showing nothing.
  const soloId = solo !== null && tabs.some((t) => t.id === solo) ? solo : null;
  const zoomedRef = useRef(zoomed);
  zoomedRef.current = zoomed;

  // What this component changed goes back to the host, once per commit.
  useEffect(() => {
    if (!dirtyRef.current || wallKey === null) return;
    dirtyRef.current = false;
    onWallChange?.(wallKey, {
      tiles: [...tiles],
      focus: focusIdx,
      zoomed,
      pinned: tiles.filter((id) => pinned.has(id)),
    });
  }, [tiles, focusIdx, zoomed, pinned, wallKey, onWallChange]);

  const paneContainerRef = useRef<HTMLDivElement | null>(null);
  // Tile wrappers keyed by terminal ID, not index — the live drag path and the
  // hover outline write styles through this map without a render.
  const tileElsRef = useRef(new Map<string, HTMLElement>());
  const focusIdxRef = useRef(focusIdx);
  focusIdxRef.current = focusIdx;
  const onPlaceRef = useRef(onPlaceTerminal);
  onPlaceRef.current = onPlaceTerminal;
  const sessionActionRef = useRef(onSessionAction);
  sessionActionRef.current = onSessionAction;

  // ── Grid geometry ─────────────────────────────────────────────────────────

  const [containerSize, setContainerSize] = useState<SizePx>({
    width: 0,
    height: 0,
  });
  useEffect(() => {
    const el = paneContainerRef.current;
    if (!el) return;
    const read = rafCoalesce(() => {
      // The grid must never reshape mid-drag — that teleports every tile
      // under the pointer. The session-end edge below recomputes once.
      if (isResizing()) return;
      const r = el.getBoundingClientRect();
      setContainerSize((prev) =>
        prev.width === r.width && prev.height === r.height
          ? prev
          : { width: r.width, height: r.height },
      );
    });
    const ro = new ResizeObserver(() => read());
    ro.observe(el);
    read();
    const off = onResizeSession((active) => {
      if (!active) read();
    });
    return () => {
      ro.disconnect();
      read.cancel();
      off();
    };
  }, []);

  // The current shape, with hysteresis against its own previous value so a
  // 2px container change can't flip the arrangement.
  const shapeRef = useRef<GridShape | null>(null);
  const shape = useMemo(() => {
    const next = gridShapeFor(tiles.length, containerSize, {
      current: shapeRef.current ?? undefined,
    });
    shapeRef.current = next;
    return next;
  }, [tiles.length, containerSize]);

  // One-time lazy migration of the legacy two-pane split ratio. The old key
  // stays in place and is never written again (rollback safety).
  useEffect(() => {
    let legacy: unknown = null;
    try {
      const raw = localStorage.getItem("redline.terminalPane.splitRatio");
      legacy = raw === null ? null : JSON.parse(raw);
    } catch {
      /* no legacy ratio */
    }
    setFractionStore((prev) => seedFromLegacyRatio(prev, legacy));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gridKey = shapeKey(shape);
  const fractions = useMemo(
    () => normalizeFractions(shape, fractionStore[gridKey]),
    [shape, fractionStore, gridKey],
  );
  const fractionsRef = useRef(fractions);
  fractionsRef.current = fractions;
  const rects = useMemo(() => tileRects(shape, fractions), [shape, fractions]);
  const gutterList = useMemo(
    () => gutters(shape, fractions, containerSize),
    [shape, fractions, containerSize],
  );

  // The live drag path: position every tile wrapper directly, keyed by ID.
  // With each header INSIDE its wrapper, nothing outside a wrapper needs
  // moving — a drag frame is these style writes and no React render, no DOM
  // queries. Don't snap to integer px: the gutter's 1px rule papers over any
  // sub-pixel seam.
  const applyRects = useCallback((rs: readonly TileRect[]) => {
    const els = tileElsRef.current;
    const ids = tilesRef.current;
    for (const r of rs) {
      const el = els.get(ids[r.index]);
      if (!el) continue;
      el.style.left = pct(r.left);
      el.style.top = pct(r.top);
      el.style.width = pct(r.width);
      el.style.height = pct(r.height);
    }
  }, []);

  const handleGutterLive = useCallback(
    (g: Gutter, pos: number) => {
      const s = shapeRef.current;
      if (!s) return;
      applyRects(tileRects(s, resizeAt(s, fractionsRef.current, g, pos)));
    },
    [applyRects],
  );
  const handleGutterCommit = useCallback(
    (g: Gutter, pos: number) => {
      const s = shapeRef.current;
      if (!s) return;
      const f = resizeAt(s, fractionsRef.current, g, pos);
      setFractionStore((prev) => putFractions(prev, shapeKey(s), f));
    },
    [setFractionStore],
  );
  const handleGutterEven = useCallback(
    (g: Gutter) => {
      const s = shapeRef.current;
      if (!s) return;
      const f = evenAt(s, fractionsRef.current, g);
      setFractionStore((prev) => putFractions(prev, shapeKey(s), f));
    },
    [setFractionStore],
  );

  // ── Unseen tracking ───────────────────────────────────────────────────────

  // Drop `id` from the unseen set (it's now on screen / chosen).
  const clearUnseen = (id: string) =>
    setUnseen((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  // Stable handler for the memoized TerminalView fleet: re-identities only
  // when the visible set / collapse change, which is exactly when its
  // visibility test should be re-evaluated.
  const handleActivity = useCallback(
    (id: string) => {
      const visibleNow = tiles.includes(id);
      if (!visibleNow || collapsed) {
        setUnseen((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      }
    },
    [tiles, collapsed],
  );

  // ── Terminal state (lib/termState) ───────────────────────────────────────

  // The agents' own word on each terminal: the latest `term-attention` per
  // terminal, seeded from the daemon's snapshot so a reload (or a dock that
  // mounted late) starts from the truth. Listener first, snapshot second —
  // `mergeAttention` keeps the newer `at` whichever lands last.
  const [attention, setAttention] = useState<ReadonlyMap<string, TermAttention>>(
    () => new Map(),
  );
  const [attentionReady, setAttentionReady] = useState(false);
  const attentionRef = useRef(attention);
  attentionRef.current = attention;
  useEffect(() => {
    let gone = false;
    let unlisten: (() => void) | undefined;
    void listen<TermAttention>("term-attention", (e) => {
      setAttention((prev) => mergeAttention(prev, [e.payload]));
    })
      .then((u) => {
        if (gone) u();
        else unlisten = u;
      })
      .catch(() => {});
    void invoke<TermAttention[]>("term_attention_snapshot")
      .then((rows) => {
        if (!gone && Array.isArray(rows)) {
          setAttention((prev) => mergeAttention(prev, rows));
        }
      })
      .catch(() => {})
      // The states it reports wait for the snapshot: until then a reload
      // would paint every agent that needs you as idle.
      .finally(() => {
        if (!gone) setAttentionReady(true);
      });
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  // What each terminal is running and serving, for hidden terminals too (an
  // untiled terminal's OSC title never updates — its bytes aren't parsed).
  // A sample that finds the shell back in the foreground also retires a
  // working or needs-you older than it: the agent that reported it has
  // exited. Sampled by the fleet poll (see "Live cwds").
  const [procs, setProcs] = useState<ReadonlyMap<string, TermProc>>(
    () => new Map(),
  );
  const sampleProcs = async (): Promise<TermProc[] | null> => {
    const sampledAt = Date.now();
    const rows = await invoke<TermProc[]>("pty_procs");
    if (!Array.isArray(rows)) return null;
    setProcs((prev) => mergeProcs(prev, rows));
    const stale = staleAcks(attentionRef.current, acksRef.current, rows, sampledAt);
    if (stale.length) {
      setAcks((prev) =>
        stale.reduce((next, [id, ack]) => putAck(next, id, ack), prev),
      );
    }
    return rows;
  };

  // Terminals whose process has exited. They stay on the wall showing
  // "[process exited]" until closed.
  const [exited, setExited] = useState<ReadonlySet<string>>(() => new Set());
  const exitedRef = useRef(exited);
  exitedRef.current = exited;
  const handleExit = useCallback((id: string) => {
    // Keep the terminal around so the user sees "[process exited]"; they
    // close it from its tile or the menu.
    setExited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  // Typing answers a needs-you and reads a your-turn (`ackForInput`); Esc or
  // Ctrl-C interrupts the agent, which no hook will ever report.
  const ackInput = useCallback(
    (id: string, interrupt: boolean) => {
      const entry = attentionRef.current.get(id);
      if (!entry) return;
      setAcks((prev) => {
        const ack = ackForInput(entry, prev.get(id), interrupt);
        return ack ? putAck(prev, id, ack) : prev;
      });
    },
    [setAcks],
  );

  // Keystrokes claim a placeholder shell; only an answer acknowledges what
  // an agent asked (`isAnswerInput`: navigation and mouse reports don't).
  const handleUserInput = useCallback((id: string) => {
    if (!tabsRef.current.some((tab) => tab.id === id && tab.placeholder)) return;
    setTabs((prev) => prev.map((tab) => tab.id === id ? { ...tab, placeholder: false } : tab));
  }, [setTabs]);

  const handleUserData = useCallback((id: string, data: string) => {
    if (isAnswerInput(data)) ackInput(id, false);
  }, [ackInput]);

  const handleInterrupt = useCallback(
    (id: string) => {
      ackInput(id, true);
      // No hook reports an interrupt. The dock has cleared its own badge
      // above; the daemon clears it for everything else that reads
      // `term-attention` — the sidebar's rows, the conversation's turn.
      void invoke("term_attention_interrupted", { terminalId: id }).catch(() => {});
    },
    [ackInput],
  );

  // Last window title each terminal announced (OSC 0/2) — "what is running in
  // here", for the tile menu. Stable identity, and it bails when the title
  // is unchanged, so a shell that rewrites the same title on every prompt costs
  // no render. Titles only arrive for terminals xterm has actually parsed: a
  // hidden one's bytes are stashed unparsed, so its title lands when shown.
  const [termTitles, setTermTitles] = useState<Map<string, string>>(
    () => new Map(),
  );
  const handleTitle = useCallback((id: string, title: string) => {
    setTermTitles((prev) => {
      if (prev.get(id) === title) return prev;
      const next = new Map(prev);
      next.set(id, title);
      return next;
    });
  }, []);

  // Clicking into a terminal focuses the tile that shows it. One stable
  // callback for the whole fleet — TerminalView hands back its id.
  const handlePaneFocus = useCallback((id: string) => {
    const i = tilesRef.current.indexOf(id);
    if (i !== -1) setFocusedTile(i);
  }, []);

  // Whether this window holds the user's attention at all — a your-turn can
  // only be READ while it does.
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setWindowFocused(true);
    const off = () => setWindowFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);

  useEffect(() => {
    onTabsChange(tabs.length);
  }, [tabs.length, onTabsChange]);

  // Keyed on the joined ids, not on `tabs`: that array's identity churns on
  // every cwd poll and title change, and re-firing this on all of those would
  // hand the host a new array to diff many times a second.
  const tabIdKey = tabs.map((t) => t.id).join(",");
  useEffect(() => {
    onTabIdsChange?.(tabIdKey ? tabIdKey.split(",") : []);
  }, [tabIdKey, onTabIdsChange]);

  // A tile's view is genuinely seen once it's shown on a wall on screen.
  useEffect(() => {
    if (collapsed) return;
    setUnseen((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const vid of tiles) {
        if (next.delete(vid)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [tiles, collapsed]);

  // Notify the host whenever the focused terminal changes so post-submit PTY
  // injects and cwd-follow polling target the terminal being watched.
  // The solo terminal is the one being watched while it is shown alone.
  // With no wall on screen the last one watched stays the target.
  const watchedId = soloId ?? focusedId;
  useEffect(() => {
    if (watchedId) onActiveTabChange?.(watchedId);
  }, [watchedId, onActiveTabChange]);

  // ── Live cwds ─────────────────────────────────────────────────────────────

  // Live cwd per terminal, polled so labels follow the shell's `cd`. Spawn
  // cwd covers the gap until the first poll lands.
  const [liveCwds, setLiveCwds] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [homePath, setHomePath] = useState<string | null>(null);
  const liveCwdsRef = useRef(liveCwds);
  liveCwdsRef.current = liveCwds;
  const homePathRef = useRef(homePath);
  homePathRef.current = homePath;
  useEffect(() => {
    void homeDir()
      .then((h) => setHomePath(normPath(h)))
      .catch(() => {});
  }, []);

  // Merge onto prior values so hidden terminals keep their last-known cwd.
  const mergeCwds = useCallback((entries: Iterable<[string, string]>) => {
    setLiveCwds((prev) => {
      let next: Map<string, string> | null = null;
      for (const [id, dir] of entries) {
        if (dir && prev.get(id) !== dir) {
          if (!next) next = new Map(prev);
          next.set(id, dir);
        }
      }
      return next ?? prev;
    });
  }, []);

  // The fleet poll: ONE clock for everything the wall reads from the OS
  // (perf-budget rule 5). Every tick reads every VISIBLE tile's cwd in one
  // batched `pty_cwds` — one `lsof` at any tile count. Every other tick also
  // runs `sampleProcs` (one `ps` + one listening-socket `lsof` for the whole
  // fleet); "every other" is measured in time, so a sample a `tiles` change
  // asks for between ticks never shifts that cadence. The host follows the
  // focused terminal's cwd from these reads (`onFocusedCwd`) instead of
  // running an `lsof` loop of its own.
  //
  // Each read runs one at a time: on a loaded machine a slow scan must not
  // stack a second one behind it. The cwd read goes through usePoll; the
  // process scan keeps its own flag and runs beside it, never in front of it,
  // because its system-wide `lsof` is the read that crawls or hangs, and the
  // cwds are what the labels and the host's folder-follow wait on. Paused
  // while the window is hidden and while the dock is collapsed — nothing it
  // reads is on screen. Hidden terminals keep their last-known label
  // and refresh the instant they're shown (a `tiles` change samples now) or
  // the menu opens (refreshAllCwds).
  const procsAtRef = useRef(-Infinity);
  const procsOutRef = useRef(false);
  const sampleFleetNow = usePoll(
    async () => {
      if (
        !procsOutRef.current &&
        Date.now() - procsAtRef.current >= PROCS_POLL_MS - FLEET_POLL_MS / 2
      ) {
        procsAtRef.current = Date.now();
        procsOutRef.current = true;
        void sampleProcs()
          .catch(() => {
            /* keep the last sample */
          })
          .finally(() => {
            procsOutRef.current = false;
          });
      }
      await invoke<Record<string, string>>("pty_cwds", { ids: [...tilesRef.current] })
        .then((map) => mergeCwds(Object.entries(map)))
        .catch(() => {
          /* keep last-known labels */
        });
    },
    collapsed ? null : FLEET_POLL_MS,
    { pauseWhenHidden: true, leading: false },
    [collapsed],
  );
  // A tile shown, the focus moved, or the dock opened: read now.
  useEffect(() => {
    if (!collapsed) sampleFleetNow();
  }, [tiles, focusedId, collapsed, sampleFleetNow]);

  const focusedCwd = focusedId ? liveCwds.get(focusedId) : undefined;
  useEffect(() => {
    if (focusedId && focusedCwd) onFocusedCwd?.(focusedId, focusedCwd);
  }, [focusedId, focusedCwd, onFocusedCwd]);

  // The menu is the fleet's only inventory, and a never-tiled terminal only
  // has its spawn cwd — refresh EVERY terminal (still one subprocess) when a
  // menu opens so its rows are accurate.
  const refreshAllCwds = () => {
    const ids = tabsRef.current.map((t) => t.id);
    void invoke<Record<string, string>>("pty_cwds", { ids })
      .then((map) => mergeCwds(Object.entries(map)))
      .catch(() => {});
  };

  // ── Derived render data (three memos, deliberately split) ────────────────

  // The project directory behind each terminal's label, in creation order.
  // Hoisted because `useRepoIcons` resolves per directory and a hook can't be
  // called from inside a useMemo callback.
  const tabDirs = useMemo(
    () => tabs.map((t) => tabProjectDir(liveCwds.get(t.id) ?? t.cwd, homePath)),
    [tabs, liveCwds, homePath],
  );
  // Cached per directory for the session, so this is a map read per render.
  const repoIcons = useRepoIcons(tabDirs);

  // What the memoized HEADERS render: one shared array + byId map, so a
  // header takes scalars plus the map and does an O(1) lookup — never a
  // freshly built per-tile object. Labels are numbered here in one pass over
  // the creation-ordered list, so header and menu can never disagree.
  const identity = useMemo(() => {
    const labelCounts = new Map<string, number>();
    const list: TerminalIdentity[] = tabs.map((t, i) => {
      const projectDir = tabDirs[i] ?? null;
      const base = tabBaseLabel(projectDir);
      const n = (labelCounts.get(base) ?? 0) + 1;
      labelCounts.set(base, n);
      const resolved =
        projectDir === null ? undefined : repoIcons.get(projectDir);
      // The mark says which repo, the label says which folder. Surface the
      // resolved root in the tooltip only when the two disagree — otherwise
      // it would just repeat the label back.
      const repoName = resolved?.name ?? "";
      return {
        id: t.id,
        label: t.title || `${base} ${n}`,
        icon: iconFor(resolved, base),
        repoRoot:
          resolved && repoName && repoName !== base
            ? tildeify(resolved.root, homePath)
            : undefined,
        dir: liveCwds.get(t.id) ?? t.cwd,
      };
    });
    return { list, byId: new Map(list.map((x) => [x.id, x])) };
  }, [tabs, tabDirs, repoIcons, liveCwds, homePath]);

  // What every terminal is doing — one derivation (lib/termState) that the
  // headers, the menu and the footer all read, so no two surfaces can
  // disagree about a terminal.
  const termStates = useMemo(() => {
    const out = new Map<string, TermState>();
    for (const t of tabs) {
      const { kind, seen } = effectiveAttention(attention.get(t.id), acks.get(t.id));
      const proc = procs.get(t.id);
      out.set(
        t.id,
        deriveTermState({
          attention: kind,
          seen,
          held: heldTerminalIds?.has(t.id) ?? false,
          exited: exited.has(t.id),
          fgComm: proc?.fgComm ?? null,
          fgIsShell: proc?.fgIsShell ?? false,
          ports: proc?.ports ?? [],
          placeholder: !!t.placeholder,
        }),
      );
    }
    return out;
  }, [tabs, attention, acks, procs, heldTerminalIds, exited]);
  const statesRef = useRef(termStates);
  statesRef.current = termStates;
  // Keyed on what the host reads, so an OSC title or a cwd tick that moved
  // no state and no label never reaches it.
  const statusKey = tabs.map((t) => `${t.id}\u0001${termStates.get(t.id) ?? "idle"}\u0001${identity.byId.get(t.id)?.label ?? ""}`).join("\u0002");
  useEffect(() => {
    // Not before the daemon's snapshot has landed: until then a terminal's
    // state is its process sample alone, and a reload would paint every
    // agent that needs you as idle or running (the host reads the hooks it
    // re-read itself meanwhile).
    if (!onStatesChange || !attentionReady) return;
    const out = new Map<string, TerminalStatus>();
    for (const t of tabsRef.current) {
      out.set(t.id, { state: statesRef.current.get(t.id) ?? "idle", label: identity.byId.get(t.id)?.label ?? "terminal" });
    }
    onStatesChange(out);
    // `statusKey` is the change; the rest is read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusKey, onStatesChange, attentionReady]);

  // A terminal's work line: a loud state carries the agent's own words (the
  // needs-you message, the your-turn excerpt); anything else keeps what it
  // was already working on — a held plan's title, else its laundered OSC
  // window title.
  const workLine = (id: string, dir: string | null) => {
    const state = termStates.get(id) ?? "idle";
    if (isLoud(state)) {
      return { state, text: attentionText(attention.get(id)), held: false };
    }
    const work = workSignal(heldPlanTitles?.get(id), termTitles.get(id), dir);
    return { state, text: work?.text ?? null, held: work?.held ?? false };
  };
  const servingPort = (id: string) => procs.get(id)?.ports[0] ?? null;

  // Every terminal that needs you, oldest transition first: the footer's
  // count and ⌘⇧J's walk. The Dock badge and the OS notifications are App's
  // (`useAttentionAlerts`), across every kind of agent.
  const loudTerminals = useMemo<LoudTerminal[]>(
    () =>
      loudOldestFirst(
        tabs.map((t) => t.id),
        termStates,
        attention,
      ).map((id) => ({
        id,
        state: termStates.get(id) === "needs-you" ? "needs-you" : "your-turn",
        at: attention.get(id)?.at ?? 0,
        label: identity.byId.get(id)?.label ?? "terminal",
        text: attentionText(attention.get(id)),
      })),
    [tabs, termStates, attention, identity],
  );
  const loudRef = useRef(loudTerminals);
  loudRef.current = loudTerminals;
  useEffect(() => {
    onNeedsYouChange?.(loudTerminals.length);
  }, [loudTerminals.length, onNeedsYouChange]);

  // A your-turn is READ once its tile has been on screen and focused, in a
  // focused window, for SEEN_AFTER_MS. Keyed on the transition's `at`, so the
  // excerpt filling in (same `at`) doesn't restart the clock and a new turn
  // (new `at`) does.
  // Shown alone, the solo terminal is the one on screen and in focus.
  const seenId = soloId ?? focusedId;
  const focusedAt = seenId ? attention.get(seenId)?.at : undefined;
  const focusedState = seenId ? termStates.get(seenId) : undefined;
  const focusedOnScreen = !collapsed && (soloId !== null || zoomed === null || zoomed === focusedId);
  useEffect(() => {
    if (
      !seenId ||
      focusedAt === undefined ||
      focusedState !== "your-turn" ||
      !focusedOnScreen ||
      !windowFocused
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      setAcks((prev) => putAck(prev, seenId, { at: focusedAt, as: "seen" }));
    }, SEEN_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [seenId, focusedAt, focusedState, focusedOnScreen, windowFocused, setAcks]);

  // Everything high-churn (work lines, held, unseen, repo counts), served
  // through context and consumed only by an OPEN menu — an OSC title or a
  // 2.5s cwd tick then re-renders one component, usually zero. A terminal
  // that starts holding while the menu is open lights up live.
  const menuData = useMemo<TerminalMenuData>(() => {
    const terminalRefs: TerminalRef[] = identity.list.map((x) => {
      const tileIndex = tiles.indexOf(x.id);
      const line = workLine(x.id, x.dir);
      return {
        id: x.id,
        dir: x.dir,
        label: x.label,
        // What this one is *working on*: what its agent just said to you, else
        // the plan it's holding for review, else whatever it announced as its
        // window title — minus the cwd echoes every shell writes, which the
        // row's location already says.
        work: line.text,
        state: line.state,
        port: line.state === "serving" ? servingPort(x.id) : null,
        held: heldTerminalIds?.has(x.id) ?? false,
        unseen: unseen.has(x.id),
        // Same "really visible" test as the held strip: with the dock
        // collapsed a tile isn't on screen, so the menu shouldn't claim it is.
        tile: collapsed ? null : tileIndex === -1 ? null : tileIndex,
        owner: others?.get(x.id) ?? null,
      };
    });
    const repos = orderRepos(
      projectOptions ?? [],
      recentDirs,
      homePath,
      MAX_MENU_REPOS,
    );
    return {
      rows: orderOpenRows(attachRepos(repos, terminalRefs, homePath), untiledMru),
      repos: repoChoices(repos, terminalRefs, homePath),
      homePath,
      agents: agentSessions,
    };
  }, [
    identity,
    tiles,
    collapsed,
    heldTerminalIds,
    heldPlanTitles,
    termTitles,
    unseen,
    projectOptions,
    recentDirs,
    homePath,
    untiledMru,
    termStates,
    attention,
    procs,
    others,
    agentSessions,
  ]);

  // ── Tile + terminal operations (side effects live HERE, never in a
  //    setState updater — StrictMode double-invokes updaters and previously
  //    desynced the panes / spawned two replacement shells) ─────────────────

  // Track evictions for the menu's "put that back" ordering.
  const recordEvictions = (
    prev: readonly string[],
    next: readonly string[],
  ) => {
    const evicted = prev.filter((id) => !next.includes(id));
    if (evicted.length === 0) return;
    setUntiledMru((m) =>
      [...evicted, ...m.filter((x) => !evicted.includes(x))].slice(
        0,
        MAX_UNTILED_MRU,
      ),
    );
  };

  // The PICK rule: show `id` in tile `index` — swapping when `id` is already
  // tiled elsewhere on this wall, re-pointing the tile otherwise (the
  // occupant leaves the wall, still running, listed under its session). The
  // user aimed at *this tile*. A terminal picked from another wall leaves
  // that one (the host's `setWall`): one PTY, one tile. Same frame: the
  // terminal's view is already mounted, so this is a style change, never a
  // `pty_attach`.
  const showInTile = (index: number, id: string) => {
    const prev = tilesRef.current;
    const next = setTileSlot(prev, index, id);
    if (next !== prev) {
      beginMeasure("wb:terminal-swap");
      beginTerminalSwap(() => endMeasure("wb:terminal-swap"));
      recordEvictions(prev, next);
      setTiles(next);
    }
    if (zoomedRef.current !== null && zoomedRef.current !== id) setZoomedId(null);
    setFocusedTile(Math.min(index, next.length - 1));
    clearUnseen(id);
  };

  // A terminal opened here needs a place: the host's (`onPlaceTerminal`),
  // which puts it on this wall while it has room and in a new tab once it is
  // full — a full wall never gives a tile away.
  const addTab = (cwd: string | null) => {
    const id = crypto.randomUUID();
    setTabs((prev) => [...prev, { id, cwd }]);
    onPlaceRef.current?.(id);
    return id;
  };

  // Open a new terminal in whatever directory tile `tile`'s terminal is
  // currently in (follows the user's `cd`). Falls back to $HOME.
  const newHere = (tile: number) => {
    const anchor = tilesRef.current[tile] ?? focusedId;
    void (async () => {
      let dir: string | null = null;
      try {
        dir = await invoke<string | null>("pty_cwd", { id: anchor });
      } catch {
        /* fall back to home */
      }
      addTab(dir);
    })();
  };

  // The shared "land `claude` in a fresh terminal" delivery. Failure paints
  // into the terminal itself (it is on screen — no toast plumbing here).
  const typeClaudeInto = (id: string) => {
    void deliverToTerminal(tauriHandoffDeps, id, [
      { stage: "launch", data: "claude --permission-mode plan\r" },
    ]).then((r) => {
      if (!r.ok) {
        console.error(`claude launch handoff failed (${r.stage}): ${r.reason}`);
      }
    });
  };

  // A repo row always opens a *new* terminal there (an existing one is what
  // the OPEN section is for), lands `claude` in it, and bumps the repo to the
  // front of the menu. The point is the whole errand — "work on that repo" —
  // not a bare shell you then have to launch from.
  const openRepoTerminal = (path: string) => {
    setRecentDirs((prev) => bumpMru(prev, path, MAX_MENU_REPOS));
    const id = addTab(path);
    void typeClaudeInto(id);
  };

  const forgetTab = useCallback((id: string) => {
    // Through the lifecycle fence: closing a terminal the instant it opened
    // must not let the kill overtake the still-queued spawn (orphan shell).
    void enqueuePtyOp(id, () => invoke("pty_kill", { id }));
    setUnseen((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setUntiledMru((m) => (m.includes(id) ? m.filter((x) => x !== id) : m));
    setZoomedId((prev) => prev === id ? null : prev);
    setDetached((prev) => prev.filter((pty) => pty.id !== id));
    setExited((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setAcks((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setPinned((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, [setAcks]);

  // Close a terminal: its shell is killed and its tile collapses. Nothing
  // is pulled onto the wall in its place, and a wall left with no tile
  // closes (the host's `setWall`).
  const closeTab = (id: string) => {
    const current = tabsRef.current;
    if (!current.some((tab) => tab.id === id)) return;
    forgetTab(id);
    setTabs(current.filter((t) => t.id !== id));
    const prev = tilesRef.current;
    const at = prev.indexOf(id);
    if (at === -1) return;
    const next = prev.filter((tid) => tid !== id);
    setTiles(next);
    const focus = focusIdxRef.current;
    setFocusedTile(Math.max(0, Math.min(focus > at ? focus - 1 : focus, next.length - 1)));
  };

  const renameTab = (id: string, name: string) => {
    setTabs((prev) => prev.map((t) => {
      if (t.id !== id) return t;
      const { title: _old, ...rest } = t;
      return name ? { ...rest, title: name } : rest;
    }));
  };

  // A terminal's ids, for a bug report or a script: its PTY's, and its
  // session's when it is one's agent.
  const copyIds = (id: string) => {
    const session = agentSessions?.get(id);
    const text = session ? `terminal ${id}\nsession ${session}` : id;
    void navigator.clipboard?.writeText(text).catch(() => {});
  };

  const togglePin = (id: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const zoomTile = (tile: number) => {
    const id = tilesRef.current[tile];
    if (!id) return;
    setZoomedId((prev) => (prev === id ? null : id));
    setFocusedTile(tile);
  };

  const focusTile = (tile: number) => {
    const clamped = Math.min(tile, tilesRef.current.length - 1);
    if (clamped < 0) return;
    setFocusedTile(clamped);
    clearUnseen(tilesRef.current[clamped]);
  };

  // "Which tile is that?" — outline it imperatively while its menu row is
  // hovered: a style write on the ref-mapped element, no render (the same
  // no-render discipline as applyRects).
  const lastHintRef = useRef<HTMLElement | null>(null);
  const hintTile = (tile: number | null) => {
    const prevEl = lastHintRef.current;
    if (prevEl) {
      prevEl.style.outline = "";
      prevEl.style.outlineOffset = "";
      lastHintRef.current = null;
    }
    if (tile === null) return;
    const id = tilesRef.current[tile];
    const el = id ? tileElsRef.current.get(id) : undefined;
    if (!el) return;
    el.style.outline = "2px solid var(--color-info)";
    el.style.outlineOffset = "-2px";
    lastHintRef.current = el;
  };

  // "That one" — a one-shot bloom on the tile a caller just revealed. Same
  // no-render discipline as `hintTile`: a class write on the ref-mapped
  // element, never a state change that would re-render fourteen terminals.
  //
  // The remove/reflow/add dance is what makes a REPEAT hail visible: a CSS
  // animation restarts only when the element re-enters the animating state,
  // so re-adding a class the node already carries plays nothing — and
  // clicking the pill twice is precisely the press that must not look
  // ignored. Reading `offsetWidth` between the two flushes the style change.
  const hailTimerRef = useRef<number | null>(null);
  const hailElRef = useRef<HTMLElement | null>(null);
  const HAIL_MS = 1400;
  const hailTile = (id: string) => {
    if (hailTimerRef.current !== null) {
      window.clearTimeout(hailTimerRef.current);
      hailTimerRef.current = null;
    }
    // An earlier hail still glowing on a DIFFERENT tile would otherwise be
    // left lit forever by the timer we just cancelled.
    hailElRef.current?.classList.remove("is-hailed");
    const el = tileElsRef.current.get(id);
    if (!el) return;
    el.classList.remove("is-hailed");
    void el.offsetWidth;
    el.classList.add("is-hailed");
    hailElRef.current = el;
    hailTimerRef.current = window.setTimeout(() => {
      el.classList.remove("is-hailed");
      hailTimerRef.current = null;
      if (hailElRef.current === el) hailElRef.current = null;
    }, HAIL_MS);
  };
  useEffect(
    () => () => {
      if (hailTimerRef.current !== null) window.clearTimeout(hailTimerRef.current);
    },
    [],
  );

  // ── Drag to arrange ───────────────────────────────────────────────────────
  //
  // Pointer events, never HTML5 drag-and-drop: xterm owns the pointer inside
  // a tile and the webview intercepts native drags for its file drop. A press
  // on a header chip becomes a drag past DRAG_THRESHOLD_PX;
  // the tiles' boxes are measured ONCE at that moment (per-move reads would
  // force layout above frame rate, the gutter's lesson), the tile under the
  // pointer is outlined with `hintTile`, and a label follows the pointer as a
  // fixed-position ghost. Dropping a header on a tile SWAPS the two
  // (`setTile`). The click that ends a drag is swallowed, so the chip's own
  // click (open the menu) never fires on top of the drop.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // A drag in flight (past the threshold) — parking holds still for it. A
  // press that never travels doesn't count.
  const draggingRef = useRef(false);
  const dropTerminal = (id: string, target: number) => {
    if (!tabsRef.current.some((t) => t.id === id)) return;
    if (tilesRef.current[target] === undefined) return;
    if (zoomed !== null) setZoomedId(null);
    const moved = tilesRef.current[target] !== id;
    showInTile(target, id);
    // Say where it landed: the tile it now holds blooms once, after the
    // swap has painted (a drop onto its own tile changes nothing).
    if (moved) requestAnimationFrame(() => requestAnimationFrame(() => hailTileRef.current(id)));
  };
  const dropRef = useRef(dropTerminal);
  dropRef.current = dropTerminal;
  const beginDrag = (id: string, e: React.PointerEvent<HTMLElement>) => {
    if (dragCleanupRef.current) return;
    const handle = e.currentTarget;
    const { pointerId } = e;
    const startX = e.clientX;
    const startY = e.clientY;
    const label = identity.byId.get(id)?.label ?? "terminal";
    let active = false;
    let boxes: TileBox[] = [];
    let target: number | null = null;
    let ghost: HTMLDivElement | null = null;

    const follow = rafCoalesce((x: number, y: number) => {
      if (ghost) {
        ghost.style.left = `${x + 12}px`;
        ghost.style.top = `${y + 12}px`;
      }
      const next = tileAtPoint(boxes, x, y);
      if (next !== target) {
        target = next;
        hintTileRef.current(next);
      }
    });
    const start = () => {
      active = true;
      draggingRef.current = true;
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        /* the handle left the DOM; window listeners still carry the drag */
      }
      boxes = tilesRef.current.map((tid, index) => {
        const r = tileElsRef.current.get(tid)?.getBoundingClientRect();
        return r
          ? { index, left: r.left, top: r.top, right: r.right, bottom: r.bottom }
          : { index, left: 0, top: 0, right: 0, bottom: 0 };
      });
      ghost = document.createElement("div");
      ghost.className = "rl-tile-drag-ghost";
      ghost.setAttribute("aria-hidden", "true");
      ghost.textContent = label;
      document.body.appendChild(ghost);
      document.documentElement.dataset.rlTileDrag = "";
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!active) {
        const moved = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (moved < DRAG_THRESHOLD_PX) return;
        start();
      }
      follow(ev.clientX, ev.clientY);
    };
    const finish = (drop: number | null) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("dragstart", noNativeDrag, true);
      follow.cancel();
      dragCleanupRef.current = null;
      if (!active) return;
      draggingRef.current = false;
      hintTileRef.current(null);
      ghost?.remove();
      delete document.documentElement.dataset.rlTileDrag;
      // The click this release is about to produce belongs to the drop.
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(
        () => window.removeEventListener("click", swallow, { capture: true }),
        0,
      );
      if (drop !== null) dropRef.current(id, drop);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      // A release that travelled is a drop even when no move was reported
      // on the way (a fast flick, a synthetic drag): measure there and then.
      if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) >= DRAG_THRESHOLD_PX) start();
      finish(active ? tileAtPoint(boxes, ev.clientX, ev.clientY) : null);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(null);
    };
    // A press on the chip must never become the webview's own drag: WebKit
    // cancels the pointer when one starts, and the drop is lost.
    const noNativeDrag = (ev: DragEvent) => ev.preventDefault();
    window.addEventListener("dragstart", noNativeDrag, true);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !active) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    dragCleanupRef.current = () => finish(null);
  };
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const hintTileRef = useRef(hintTile);
  hintTileRef.current = hintTile;

  // ⌘⇧J: the next terminal that needs you, by visit (never by which tile
  // has focus), and the visit recorded.
  const visitsRef = useRef(new Map<string, number>());
  const visitSeqRef = useRef(0);
  const nextNeedsYouNow = (): string | null => {
    const target = nextNeedsYou(loudRef.current.map((t) => t.id), visitsRef.current);
    if (target) visitsRef.current.set(target, ++visitSeqRef.current);
    return target;
  };
  const nextRef = useRef(nextNeedsYouNow);
  nextRef.current = nextNeedsYouNow;

  // Expose the fleet to the host. Handlers are recreated each render, so the
  // handle reads them through refs and guards against a stale id (a terminal
  // closed since the mapping that named it was recorded).
  const hailTileRef = useRef(hailTile);
  hailTileRef.current = hailTile;
  const closeRef = useRef(closeTab);
  closeRef.current = closeTab;
  const runningNow = async (ids: readonly string[]): Promise<string[]> => {
    let rows: TermProc[] | null = null;
    try {
      rows = await sampleProcs();
    } catch {
      /* unread: every terminal counts as running */
    }
    const byId = new Map((rows ?? []).map((r) => [r.id, r]));
    return ids.filter((id) => {
      if (exitedRef.current.has(id)) return false;
      const proc = byId.get(id);
      if (!proc) return true;
      const { kind, seen } = effectiveAttention(attentionRef.current.get(id), acksRef.current.get(id));
      const state = deriveTermState({
        attention: kind,
        seen,
        held: heldTerminalIds?.has(id) ?? false,
        exited: false,
        fgComm: proc.fgComm ?? null,
        fgIsShell: proc.fgIsShell ?? false,
        ports: proc.ports ?? [],
        placeholder: false,
      });
      return state !== "idle" && state !== "exited";
    });
  };
  const runningNowRef = useRef(runningNow);
  runningNowRef.current = runningNow;
  const recoverDetached = async () => {
    if (recovering) return;
    setRecovering(true);
    setRecoveryError(null);
    try {
      // Recheck on click so a process that exited since boot isn't silently
      // replaced by a fresh shell under its old id.
      const live = await invoke<LivePty[]>("pty_list");
      const owned = new Set(tabsRef.current.map((tab) => tab.id));
      for (const pty of live.filter((pty) => pty.alive && !owned.has(pty.id))) {
        setTabs((prev) => [...prev, { id: pty.id, cwd: pty.cwd }]);
        onPlaceRef.current?.(pty.id);
      }
      setDetached([]);
    } catch {
      setRecoveryError("Couldn't recover detached terminals. Try again.");
    } finally {
      setRecovering(false);
    }
  };
  useImperativeHandle(
    ref,
    () => ({
      hailTerminal: (id: string) => {
        if (tabsRef.current.some((t) => t.id === id)) hailTileRef.current(id);
      },
      openSessionTerminal: (cwd: string | null) => {
        const id = crypto.randomUUID();
        setTabs((prev) => [...prev, { id, cwd }]);
        return id;
      },
      nextNeedsYou: () => nextRef.current(),
      focusTerminal: (id: string) => focusTerminalView(id),
      closeTerminals: (ids: readonly string[]) => {
        for (const id of ids) closeRef.current(id);
      },
      runningNow: (ids: readonly string[]) => runningNowRef.current(ids),
      addTileHere: () => handlersRef.current.newHere(focusIdxRef.current),
      toggleZoomFocused: () => handlersRef.current.zoomTile(focusIdxRef.current),
    }),
    [setTabs],
  );

  // Guard the window close: like a real terminal app, confirm before tearing
  // down a session that has work in flight. We treat "moved off the directory
  // it opened in" as the signal — a terminal still sitting at its start dir
  // ($HOME, or its "open here" dir) is disposable and closes without a prompt.
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;

    const norm = (p: string) => p.replace(/\/+$/, "") || "/";
    const anyTerminalMoved = async (): Promise<boolean> => {
      let home = "";
      try {
        home = await homeDir();
      } catch {
        /* compare against explicit cwds only if HOME is unreadable */
      }
      // One batched lookup for the whole fleet; unreadable → treat as not
      // moved rather than blocking the close.
      let live: Record<string, string> = {};
      try {
        live = await invoke<Record<string, string>>("pty_cwds", {
          ids: tabsRef.current.map((t) => t.id),
        });
      } catch {
        return false;
      }
      for (const t of tabsRef.current) {
        const initial = t.cwd ?? home;
        if (!initial) continue;
        const cur = live[t.id];
        if (cur && norm(cur) !== norm(initial)) return true;
      }
      return false;
    };

    void win
      .onCloseRequested(async (event) => {
        let moved = false;
        try {
          moved = await anyTerminalMoved();
        } catch {
          /* on any failure, don't block the close */
        }
        if (!moved) return;
        event.preventDefault();
        setShowCloseConfirm(true);
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // ── Stable action surface for the N headers/menus ─────────────────────────

  // The handlers close over live state, so they change identity on every
  // render — which would defeat every header's memo. They're routed through a
  // ref instead; each action takes the tile index up front so ONE object
  // serves all N headers (currying per tile would mint N fresh closures per
  // render and defeat the memos the same way).
  const handlersRef = useRef({
    showInTile,
    closeTab,
    newHere,
    addTab,
    openRepoTerminal,
    zoomTile,
    focusTile,
    hintTile,
    refreshAllCwds,
    togglePin,
    beginDrag,
    renameTab,
    copyIds,
  });
  handlersRef.current = {
    showInTile,
    closeTab,
    newHere,
    addTab,
    openRepoTerminal,
    zoomTile,
    focusTile,
    hintTile,
    refreshAllCwds,
    togglePin,
    beginDrag,
    renameTab,
    copyIds,
  };
  const tileActions = useMemo<TileActions>(
    () => ({
      onPick: (tile, id) => handlersRef.current.showInTile(tile, id),
      onCloseTerminal: (id) => handlersRef.current.closeTab(id),
      onNewHere: (tile) => handlersRef.current.newHere(tile),
      // New terminals land by the placement rule, not in the menu's tile.
      onNewHome: () => handlersRef.current.addTab(null),
      onNewRepo: (_tile, path) => handlersRef.current.openRepoTerminal(path),
      onZoomTile: (tile) => handlersRef.current.zoomTile(tile),
      onFocusTile: (tile) => handlersRef.current.focusTile(tile),
      onHintTile: (tile) => handlersRef.current.hintTile(tile),
      onRefreshCwds: () => handlersRef.current.refreshAllCwds(),
      onTogglePin: (id) => handlersRef.current.togglePin(id),
      onDragStart: (id, e) => handlersRef.current.beginDrag(id, e),
      onRename: (id, name) => handlersRef.current.renameTab(id, name),
      onCopyIds: (id) => handlersRef.current.copyIds(id),
      onSessionAction: (kind, id) => sessionActionRef.current?.(kind, id),
    }),
    [],
  );
  // ── Render ────────────────────────────────────────────────────────────────

  // Position each terminal's wrapper by its tile rect using CSS only — never
  // by moving it to a different JSX parent, which would recreate xterm and
  // replay its PTY. Untiled wrappers are display:none — a
  // full-bleed invisible box would still hit-test over the visible tiles
  // (any tab later in `tabs` order) and swallow their clicks; their
  // TerminalView is display:none internally already, so nothing changes for
  // the PTY.
  const wrapperStyle = (
    rect: TileRect | null,
    isZoomed: boolean,
    hiddenByZoom: boolean,
  ): CSSProperties => {
    if (isZoomed) return { position: "absolute", inset: 0, overflow: "hidden" };
    if (!rect || hiddenByZoom) {
      return { position: "absolute", inset: 0, display: "none" };
    }
    // Explicit width/height (never right/bottom) so the live drag path is a
    // uniform four-property write for every tile. No will-change: several
    // promoted layers each holding a WebGL canvas is exactly the compositing
    // pressure to avoid.
    return {
      position: "absolute",
      left: pct(rect.left),
      top: pct(rect.top),
      width: pct(rect.width),
      height: pct(rect.height),
      overflow: "hidden",
    };
  };

  return (
    <div className="flex flex-col h-full">
      {(detached.some((pty) => !tabs.some((tab) => tab.id === pty.id)) || recoveryError) && (
        <div className="flex items-center gap-2 px-2 py-1 text-xs" role="status" data-recovery="">
          {recoveryError && <span>{recoveryError}</span>}
          <button type="button" disabled={recovering} onClick={() => void recoverDetached()} className="underline">
            {recovering ? "Reattaching…" : recoveryError ? "Retry terminal recovery" : `Reattach ${detached.filter((pty) => !tabs.some((tab) => tab.id === pty.id)).length} detached terminals`}
          </button>
        </div>
      )}
      <TerminalMenuDataContext.Provider value={menuData}>
      <div ref={paneContainerRef} className="flex-1 relative">
        {wallKey !== null && soloId === null && tiles.length === 0 && (
          // A wall with nothing on it (a fresh Terminals tab): one way to
          // start, never a shell spawned unasked.
          <div className="rl-wall-empty" role="status">
            <p>No terminals on this wall</p>
            <button type="button" onClick={() => handlersRef.current.addTab(null)}>
              New terminal
            </button>
          </div>
        )}
        {tabs.map((t) => {
          const tileIndex = tiles.indexOf(t.id);
          const tiled = tileIndex !== -1;
          const rect = tiled ? rects[tileIndex] : null;
          // Solo outranks the wall's own layout and zoom, without touching
          // either: the tile keeps its rect for when the view comes back.
          const isSolo = soloId === t.id;
          const isZoomed = soloId === null ? zoomed === t.id : isSolo;
          const hiddenByZoom = soloId === null ? zoomed !== null && !isZoomed : !isSolo;
          const visible = (tiled || isSolo) && !collapsed && !hiddenByZoom;
          const ident = identity.byId.get(t.id);
          // What this terminal is doing and on, beside its name. Same
          // derivation the tile menu uses (`workLine`) — just no longer
          // confined to the ▾ dropdown.
          //
          // Passed as PRIMITIVES, deliberately. TerminalTileHeader is memo'd
          // with the default shallow compare, so a fresh `{text, held}` object
          // per render would re-render all fourteen headers on every OSC-title
          // tick; scalars re-render only the tile whose line actually changed.
          // For the same reason this stays OUT of the `identity` memo — that
          // memo's stability is what keeps the headers cheap, and `menuData`
          // depends on it.
          const line = workLine(t.id, ident?.dir ?? null);
          return (
            <div
              key={t.id}
              ref={(el) => {
                if (el) tileElsRef.current.set(t.id, el);
                else tileElsRef.current.delete(t.id);
              }}
              // A stable hook for the hail keyframe. The wrapper was
              // style-only; `hailTile` adds `is-hailed` to this same node.
              className="rl-tile-wrap"
              // Frames the tile in amber while its agent is blocked on you
              // (styles.css), on the wall and in a zoom alike.
              data-term-state={tiled ? line.state : undefined}
              style={wrapperStyle(rect, isZoomed, hiddenByZoom)}
            >
              {tiled && soloId === null && ident && (
                // The boundary wraps the HEADER ELEMENT ONLY — around the
                // whole wrapper it would unmount the TerminalView on a header
                // crash, which would discard its local rendered history. A
                // crashed header just disappears; the shell keeps running.
                <ErrorBoundary fallback={() => null}>
                  <TerminalTileHeader
                    tile={tileIndex}
                    identity={ident}
                    focused={tileIndex === focusIdx}
                    zoomed={isZoomed}
                    pinned={pinned.has(t.id)}
                    state={line.state}
                    port={line.state === "serving" ? servingPort(t.id) : null}
                    workText={line.text}
                    workHeld={line.held}
                    actions={tileActions}
                  />
                </ErrorBoundary>
              )}
              <div
                style={{
                  position: "absolute",
                  top: soloId === null ? TILE_HEADER_H : 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                }}
              >
                <TerminalView
                  id={t.id}
                  cwd={t.cwd}
                  theme={theme}
                  visible={visible}
                  // The caret goes only to the wall's focused tile (or the
                  // one shown alone), never to every tile a swap shows.
                  focusOnShow={isSolo || tileIndex === focusIdx}
                  onActivity={handleActivity}
                  onExit={handleExit}
                  onTitle={handleTitle}
                  onPaneFocus={handlePaneFocus}
                  onUserInput={handleUserInput}
                  onInterrupt={handleInterrupt}
                  onUserData={handleUserData}
                />
              </div>
              {visible && heldTerminalIds?.has(t.id) && <InterceptStrip />}
            </div>
          );
        })}
        {!collapsed && zoomed === null && soloId === null && (
          // Null fallback: a crashed gutter layer just disappears (resize the
          // dock to get it back); the tiles keep their shells. ONE boundary
          // around the whole layer, not one per gutter.
          <ErrorBoundary fallback={() => null}>
            {gutterList.map((g) => (
              <TileGutter
                key={g.id}
                gutter={g}
                containerRef={paneContainerRef}
                onLive={handleGutterLive}
                onCommit={handleGutterCommit}
                onEven={handleGutterEven}
              />
            ))}
          </ErrorBoundary>
        )}
      </div>
      </TerminalMenuDataContext.Provider>
      {showCloseConfirm && (
        <CloseConfirmModal
          onConfirm={() => {
            // destroy() bypasses the onCloseRequested guard we set above —
            // and normal unmount teardown with it, so kill the shells first
            // rather than leaving orphans to outlive the window.
            void invoke("pty_kill_all")
              .catch(() => {})
              .finally(() => void getCurrentWindow().destroy());
          }}
          onCancel={() => setShowCloseConfirm(false)}
        />
      )}
    </div>
  );
  },
  ),
);
