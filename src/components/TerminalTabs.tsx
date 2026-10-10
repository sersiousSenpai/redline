// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
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
import {
  addTile as addTileSlot,
  reconcileTiles,
  removeTileAt,
  setTile as setTileSlot,
} from "../lib/tileSlots";
import {
  fitsAnotherTile,
  parkCandidate,
  placeTarget,
  shelfOrder,
  tileAtPoint,
  type TileBox,
} from "../lib/tilePolicy";
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
import { useAttentionAlerts } from "../hooks/useAttentionAlerts";
import type { LoudTerminal } from "../lib/attentionAlerts";
import type { ProjectOption } from "./ProjectPicker";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  TerminalView,
  enqueuePtyOp,
  focusTerminalView,
  tauriHandoffDeps,
} from "./TerminalView";
import { deliverToTerminal } from "../lib/terminalHandoff";
import {
  TerminalTileHeader,
  type TerminalIdentity,
} from "./TerminalTileHeader";
import { TerminalShelf, type ShelfChip } from "./TerminalShelf";
import {
  TerminalMenuDataContext,
  type TerminalMenuData,
  type TileActions,
} from "./TerminalTileMenu";
import { TileGutter } from "./TileGutter";
import { CloseConfirmModal } from "./CloseConfirmModal";
import { replaceablePlaceholder } from "../lib/placeholderTerminal";
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
  /** The dock's auto-spawned convenience shell; cleared the moment the user touches it. */
  placeholder?: boolean;
}

interface TerminalTabsProps {
  theme: string;
  onTabsChange: (count: number) => void;
  /** The live terminal ids, whenever that SET changes (not on every cwd or
   *  title update). A host driving a specific terminal — the front door
   *  waiting on a plan it launched — needs to know when that one goes away,
   *  which a count can't tell it: close one and open another and the count
   *  never moved. */
  onTabIdsChange?: (ids: string[]) => void;
  /** Notified when the GRID changes: visible tile count and its row count.
   *  Distinct from onTabsChange — tab count ≠ tile count, and 9 tabs / 2
   *  tiles is normal. App grows the dock from this. */
  onTileCountChange?: (count: number, rows: number) => void;
  /** How many terminals need you (needs-you, or an unread your-turn) —
   *  the footer's "N need you" chip and the ⌘⇧J gate. */
  onNeedsYouChange?: (count: number) => void;
  /** Dock is fully collapsed (no tile is really visible). */
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
  /** Dock terminals whose `claude` is currently held awaiting review. Each
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
}

/** UI policy: how many tiles the grid will show at once. Deliberately absent
 *  from every geometry function — the shape math handles any n (tested to
 *  n=24), so raising this is a one-line policy change, not a structural one.
 *
 *  At 14 the tiles are small, which is the point: a wall of agents you can see
 *  at a glance beats seven you have to cycle. Two neighbouring caps are
 *  deliberately left alone because both degrade gracefully rather than
 *  failing — `MAX_WEBGL` (TerminalView) now binds, so tiles past the eighth
 *  keep xterm's DOM renderer, and `MAX_STORED_SHAPES` still covers the wider
 *  spread of `n@rowsxcols` keys. */
const MAX_TILES = 14;

/** How many repos the menu offers and how deep the click-order memory runs. */
const MAX_MENU_REPOS = 12;

/** How many evictions the menu's "put that back" ordering remembers. */
const MAX_UNTILED_MRU = 32;

/** Pointer travel before a press on a header or shelf chip becomes a drag —
 *  under it, the press is the chip's ordinary click. */
const DRAG_THRESHOLD_PX = 4;

/** How often the wall considers parking a quiet tile. At most one tile parks
 *  per tick, so a wall of settled tiles empties out one at a time rather
 *  than reshaping all at once. */
const PARK_TICK_MS = 2000;

/** How long a just-parked terminal leads the shelf, outlined, so the eye can
 *  follow it off the wall. */
const FRESH_PARKED_MS = 4000;

/** The fleet poll's tick: every visible tile's live cwd, in one `lsof`. */
const FLEET_POLL_MS = 2000;

/** How often `pty_procs` samples every terminal's foreground program and
 *  ports (one `ps` + one `lsof` for the whole fleet, perf-budget rule 5) —
 *  every other fleet tick. Slower than the cwds: a state badge a few seconds
 *  late costs nothing, and the settle windows that act on it are fifteen
 *  seconds and up. */
const PROCS_POLL_MS = 2 * FLEET_POLL_MS;

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
        color: "#e8553d",
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
  selectTab: (id: string) => void;
  /** Flash a one-shot ring around a terminal's tile. `selectTab` puts the
   *  right tile under the focus ring; on a wall of fourteen that is not
   *  always where the eye is. Purely decorative — a no-op for an id that
   *  isn't open, or isn't currently tiled. */
  hailTerminal: (id: string) => void;
  /** Open a fresh terminal in `cwd`, show it, and return its id so the host
   *  can drive it (e.g. "Restore plan session" writes `claude --resume …`
   *  into it). cwd null → backend resolves to $HOME.
   *
   *  `background` creates the terminal without tiling, selecting or focusing
   *  it: the PTY spawns and the shell runs exactly as always (every tab's
   *  `<TerminalView>` is mounted whether tiled or not — untiled ones are
   *  `display:none`), it just doesn't take a tile out from under whatever the
   *  reviewer is watching. Used by a restore, whose terminal is machinery
   *  rather than a place to work; it stays in the tile menus and takes
   *  held/unseen state normally, so `selectTab` promotes it on demand. A sole
   *  untouched convenience shell yields its tile even to a background open. */
  openSessionTerminal: (
    cwd: string | null,
    opts?: { background?: boolean },
  ) => string;
  /** ⌘⇧J: put the next terminal that needs you — oldest transition first,
   *  walking on from the focused one — on the wall by the placement rule,
   *  hail it and hand it the caret. False when nothing needs you. The host
   *  reveals the dock. */
  jumpToNeedsYou: () => boolean;
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
// are the TILES — an ordered list of up to MAX_TILES terminal ids arranged by
// lib/tileGrid into a resizable grid. Changing which terminal a tile shows is
// purely a view change: it never spawns-and-kills shells, so sessions and
// scrollback survive. The dock is never empty: closing the last terminal
// spawns a fresh replacement. Labels are project-aware: each terminal is named
// after its live cwd's basename, numbered per project in creation order
// ("redline 1, redline 2, zsh 1") — $HOME and / fall back to "zsh".
//
// Every tile carries its own 26px header (state badge, repo mark, label, ▾
// menu); the menu is the fleet's single inventory — the old tab strip,
// repo-bubble strip and action cluster all folded into it. Every terminal
// without a tile also sits on the shelf above the grid, so nothing open is
// ever out of sight. Each terminal has a derived state (lib/termState) that
// decides where it goes (lib/tilePolicy): quiet tiles park themselves on the
// shelf, and a terminal that needs you glows there until you bring it back.
//
// Memoized: a dock drag's one release commit (and any unrelated App state
// change) must not walk the whole terminal fleet's tree.
export const TerminalTabs = memo(
  forwardRef<TerminalTabsHandle, TerminalTabsProps>(
  function TerminalTabs(
    {
      theme,
      onTabsChange,
      onTabIdsChange,
      onTileCountChange,
      onNeedsYouChange,
      collapsed,
      onActiveTabChange,
      onFocusedCwd,
      heldTerminalIds,
      heldPlanTitles,
      projectOptions,
    }: TerminalTabsProps,
    ref,
  ) {
  const [initialWorkspace] = useState<TerminalWorkspace>(() => {
    const saved = readTerminalWorkspace(MAX_TILES);
    if (saved) return saved;
    const tab: Tab = { id: crypto.randomUUID(), cwd: null, placeholder: true };
    return { tabs: [tab], tiles: [tab.id], focusedTile: 0, zoomedId: null };
  });
  const [tabs, setTabsState] = useState<Tab[]>(initialWorkspace.tabs);
  const tabsRef = useRef(tabs);
  // Imperative launch/restore can open several terminals before React renders.
  // Keep refs current at the mutation, so two launches cannot both replace
  // the same placeholder or overwrite one another's tile slot.
  const setTabs = useCallback((next: Tab[] | ((prev: Tab[]) => Tab[])) => {
    const value = typeof next === "function" ? next(tabsRef.current) : next;
    tabsRef.current = value;
    setTabsState(value);
  }, []);
  // The visible tiles: terminal ids in row-major grid order, 1..MAX_TILES.
  const [tiles, setTilesState] = useState<readonly string[]>(initialWorkspace.tiles);
  const tilesRef = useRef(tiles);
  const setTiles = useCallback((next: readonly string[]) => {
    tilesRef.current = next;
    setTilesState(next);
  }, []);
  const [focusedTile, setFocusedTile] = useState(initialWorkspace.focusedTile);
  // One tile temporarily taking the whole dock (menu row / header
  // double-click). Stored as the terminal id and DERIVED against `tiles`, so
  // a closed terminal can never leave the dock stuck zoomed.
  const [zoomedId, setZoomedId] = useState<string | null>(initialWorkspace.zoomedId);
  // Local answers to the agents' attention transitions (lib/termState):
  // typed into, interrupted, read. Persisted with the layout so a reload
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
  // Terminals pinned to the wall: parking never takes their tile, and
  // automatic placement replaces it only once the wall is at its tile cap.
  const [pinned, setPinned] = useState<ReadonlySet<string>>(
    () => new Set(initialWorkspace.pinned ?? []),
  );
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const workspaceRef = useRef<TerminalWorkspace>(initialWorkspace);
  workspaceRef.current = {
    tabs,
    tiles,
    focusedTile,
    zoomedId,
    ...(pinned.size ? { pinned: [...pinned] } : {}),
    ...(acks.size ? { acks: Object.fromEntries(acks) } : {}),
  };
  useEffect(() => {
    saveTerminalWorkspace(workspaceRef.current);
  }, [tabs, tiles, focusedTile, zoomedId, pinned, acks]);
  useEffect(() => {
    const save = () => saveTerminalWorkspace({
      ...workspaceRef.current,
      tabs: tabsRef.current,
      tiles: tilesRef.current,
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
  // Most-recently-evicted terminals lead the menu's untiled section, so
  // "put that back" after a silent eviction is one click.
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
  const focusIdx = Math.min(focusedTile, tiles.length - 1);
  const focusedId = tiles[focusIdx];
  const zoomed = zoomedId !== null && tiles.includes(zoomedId) ? zoomedId : null;
  const zoomedRef = useRef(zoomed);
  zoomedRef.current = zoomed;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  const paneContainerRef = useRef<HTMLDivElement | null>(null);
  // Tile wrappers keyed by terminal ID, not index — the live drag path and the
  // hover outline write styles through this map without a render.
  const tileElsRef = useRef(new Map<string, HTMLElement>());
  const focusIdxRef = useRef(focusIdx);
  focusIdxRef.current = focusIdx;

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

  // The last size the grid really had. A collapsed dock measures 0 tall, and
  // "would one more tile still fit?" must be asked of the dock the user will
  // see when it opens, not of the fold.
  const lastSizeRef = useRef<SizePx | null>(null);
  if (containerSize.width > 0 && containerSize.height > 0) {
    lastSizeRef.current = containerSize;
  }

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
      // Alerts wait for the snapshot: what it holds happened before this
      // dock existed and was never news here (useAttentionAlerts).
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
  const sampleProcs = async () => {
    const sampledAt = Date.now();
    const rows = await invoke<TermProc[]>("pty_procs");
    if (!Array.isArray(rows)) return;
    setProcs((prev) => mergeProcs(prev, rows));
    const stale = staleAcks(attentionRef.current, acksRef.current, rows, sampledAt);
    if (stale.length) {
      setAcks((prev) =>
        stale.reduce((next, [id, ack]) => putAck(next, id, ack), prev),
      );
    }
  };

  // Terminals whose process has exited. They stay on the wall showing
  // "[process exited]" until closed; the state lets them park.
  const [exited, setExited] = useState<ReadonlySet<string>>(() => new Set());
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

  // When each terminal was last typed in, placed, or focused away from — any
  // sign the user was just there, which restarts its parking clock.
  const touchedRef = useRef(new Map<string, number>());
  const touch = (id: string) => touchedRef.current.set(id, Date.now());

  const handleUserInput = useCallback((id: string) => {
    touchedRef.current.set(id, Date.now());
    ackInput(id, false);
    if (!tabsRef.current.some((tab) => tab.id === id && tab.placeholder)) return;
    setTabs((prev) => prev.map((tab) => tab.id === id ? { ...tab, placeholder: false } : tab));
  }, [setTabs, ackInput]);

  const handleInterrupt = useCallback(
    (id: string) => ackInput(id, true),
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

  useEffect(() => {
    onTileCountChange?.(tiles.length, shape.rows);
  }, [tiles.length, shape.rows, onTileCountChange]);

  // A tile's view is genuinely seen once it's shown and the dock is open.
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
  useEffect(() => {
    onActiveTabChange?.(focusedId);
  }, [focusedId, onActiveTabChange]);

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
  // while the window is hidden. Hidden terminals keep their last-known label
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
    FLEET_POLL_MS,
    { pauseWhenHidden: true, leading: false },
  );
  useEffect(() => sampleFleetNow(), [tiles, sampleFleetNow]);

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
        label: `${base} ${n}`,
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
  // count, ⌘⇧J's walk, the Dock badge and the OS notifications.
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
  useAttentionAlerts(loudTerminals, collapsed, attentionReady);

  // A your-turn is READ once its tile has been on screen and focused, in a
  // focused window, for SEEN_AFTER_MS. Keyed on the transition's `at`, so the
  // excerpt filling in (same `at`) doesn't restart the clock and a new turn
  // (new `at`) does.
  const focusedAt = focusedId ? attention.get(focusedId)?.at : undefined;
  const focusedState = focusedId ? termStates.get(focusedId) : undefined;
  const focusedOnScreen = !collapsed && (zoomed === null || zoomed === focusedId);
  useEffect(() => {
    if (
      !focusedId ||
      focusedAt === undefined ||
      focusedState !== "your-turn" ||
      !focusedOnScreen ||
      !windowFocused
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      setAcks((prev) => putAck(prev, focusedId, { at: focusedAt, as: "seen" }));
    }, SEEN_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [focusedId, focusedAt, focusedState, focusedOnScreen, windowFocused, setAcks]);

  // ── Parking (park-only automation) ───────────────────────────────────────
  //
  // A tile whose terminal has gone quiet takes itself off the wall once it
  // has stayed quiet and untouched for its settle window (tilePolicy's
  // PARK_SETTLE_MS): 15 s for a server, a held plan or a dead shell, two
  // minutes for an idle one. Never the focused, zoomed, pinned or last tile,
  // and nothing is ever pulled ONTO the wall automatically — a terminal that
  // needs you glows on the shelf instead. To keep the grid steady, parking
  // waits while the pointer is over the dock or a gutter is being dragged,
  // and reshapes at most once per tick.
  const sinceRef = useRef(new Map<string, number>());
  const lastStateRef = useRef(new Map<string, TermState>());
  useEffect(() => {
    const now = Date.now();
    const last = lastStateRef.current;
    for (const [id, state] of termStates) {
      if (last.get(id) === state) continue;
      last.set(id, state);
      sinceRef.current.set(id, now);
    }
    for (const id of [...last.keys()]) {
      if (termStates.has(id)) continue;
      last.delete(id);
      sinceRef.current.delete(id);
      touchedRef.current.delete(id);
    }
  }, [termStates]);
  // Looking at a tile and moving on is a touch too: a server you just
  // checked must not vanish the moment you click away from it.
  const prevFocusedRef = useRef(focusedId);
  useEffect(() => {
    const prev = prevFocusedRef.current;
    if (prev && prev !== focusedId) touchedRef.current.set(prev, Date.now());
    prevFocusedRef.current = focusedId;
  }, [focusedId]);
  const hoverRef = useRef(false);
  const [freshParked, setFreshParked] = useState<string | null>(null);
  useEffect(() => {
    if (freshParked === null) return;
    const timer = window.setTimeout(() => setFreshParked(null), FRESH_PARKED_MS);
    return () => window.clearTimeout(timer);
  }, [freshParked]);

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
  ]);

  // The shelf: every terminal with no tile, loud first (tilePolicy's
  // `shelfOrder`). Nothing the wall isn't showing is out of sight.
  const shelfChips = useMemo<ShelfChip[]>(() => {
    const untiled = tabs.filter((t) => !tiles.includes(t.id)).map((t) => t.id);
    return shelfOrder(untiled, termStates, untiledMru, freshParked).map((id) => {
      const ident = identity.byId.get(id);
      const line = workLine(id, ident?.dir ?? null);
      return {
        id,
        label: ident?.label ?? "terminal",
        state: line.state,
        text: line.text,
        port: line.state === "serving" ? servingPort(id) : null,
        fresh: id === freshParked,
      };
    });
    // `workLine` and `servingPort` read attention, procs and the titles.
  }, [tabs, tiles, termStates, untiledMru, freshParked, identity, attention, procs, heldPlanTitles, termTitles]);

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

  // The PLACEMENT rule: show `id` in tile `index` — swapping when `id` is
  // already tiled elsewhere, evicting the occupant otherwise. The user aimed
  // at *this tile*; jumping focus to wherever `id` already lives would make
  // "put these two side by side" inexpressible. (Contrast selectTab below.)
  const showInTile = (index: number, id: string) => {
    const prev = tilesRef.current;
    const next = setTileSlot(prev, index, id);
    if (next !== prev) {
      recordEvictions(prev, next);
      setTiles(next);
    }
    // Both ends of a swap were just arranged by hand; neither should park
    // out from under the arrangement.
    touch(id);
    if (prev[index] !== undefined && next.includes(prev[index])) touch(prev[index]);
    setFocusedTile(Math.min(index, next.length - 1));
    clearUnseen(id);
  };

  // Put an untiled terminal on the wall by the ONE placement rule
  // (tilePolicy's `placeTarget`): its own tile while `shapeFits`, else the
  // quietest tile that may give way, the focused one only as a last resort.
  // `mayGrow` false never adds a tile, not even to spare a pin. Returns the
  // tile it landed in. A zoom would hide the result, so it ends.
  const placeOnWall = (
    id: string,
    shapeFits: boolean,
    mayGrow = true,
  ): number => {
    const prev = tilesRef.current;
    const target = placeTarget(
      prev,
      statesRef.current,
      pinnedRef.current,
      focusIdxRef.current,
      shapeFits,
      mayGrow && prev.length < MAX_TILES,
    );
    setZoomedId(null);
    if (target.kind === "add") {
      const next = addTileSlot(prev, id, MAX_TILES);
      if (next !== prev) {
        touch(id);
        setTiles(next);
        setFocusedTile(next.length - 1);
        clearUnseen(id);
        return next.length - 1;
      }
    }
    const index = target.kind === "replace" ? target.index : focusIdxRef.current;
    showInTile(index, id);
    return index;
  };

  // A NEW terminal gets a fresh tile while the wall is under its cap — the
  // wall of agents is the point — and only at the cap does it take a tile,
  // the one the placement rule picks rather than whichever is focused.
  const openTerminalTile = (id: string) => {
    placeOnWall(id, tilesRef.current.length < MAX_TILES);
  };

  // The REVEAL rule (App's "show me X", a shelf click, ⌘⇧J): a terminal
  // already on the wall just takes focus; otherwise it is placed — in a new
  // tile only while one more still fits as a real terminal (80×24). Either
  // way it must end up on screen, so a zoom on another tile ends.
  const revealTerminal = (id: string): number => {
    const i = tilesRef.current.indexOf(id);
    if (i !== -1) {
      if (zoomedRef.current !== null && zoomedRef.current !== id) {
        setZoomedId(null);
      }
      setFocusedTile(i);
      clearUnseen(id);
      return i;
    }
    // A collapsed dock doesn't grow: a new tile is what makes App open the
    // dock (its tile-driven growth), and a linked folder click selects the
    // folder's terminal without asking for the dock.
    const grow = !collapsedRef.current;
    return placeOnWall(
      id,
      grow &&
        fitsAnotherTile(tilesRef.current.length, lastSizeRef.current, MAX_TILES),
      grow,
    );
  };

  // cwd null → backend resolves to $HOME ("root").
  const addTab = (cwd: string | null) => {
    const id = crypto.randomUUID();
    setTabs((prev) => [...prev, { id, cwd }]);
    openTerminalTile(id);
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

  const closeTab = (id: string) => {
    const current = tabsRef.current;
    if (!current.some((tab) => tab.id === id)) return;
    forgetTab(id);

    if (current.length === 1 && current[0].id === id) {
      // Last terminal: never leave the dock empty — spawn a replacement.
      const newId = crypto.randomUUID();
      setTabs([{ id: newId, cwd: null, placeholder: true }]);
      setTiles([newId]);
      setFocusedTile(0);
      return;
    }

    const next = current.filter((t) => t.id !== id);
    setTabs(next);

    // The tile it leaves pulls in a terminal that NEEDS YOU, oldest first —
    // and otherwise collapses, rather than resurrecting a quiet neighbour
    // the user (or parking) had already put away. Only a grid that would
    // otherwise be empty takes the shelf's first terminal.
    const untiled = next
      .map((t) => t.id)
      .filter((tid) => !tilesRef.current.includes(tid));
    const rec = reconcileTiles(
      tilesRef.current,
      focusIdxRef.current,
      id,
      loudOldestFirst(untiled, statesRef.current, attentionRef.current),
      shelfOrder(untiled, statesRef.current, untiledMru, null),
    );
    if (rec.tiles !== tilesRef.current) setTiles(rec.tiles);
    setFocusedTile(rec.focus);
  };

  // App is saying "show me X": the reveal rule, kept deliberately different
  // from showInTile's — the menu's pick swaps, because there the user aimed
  // at a specific tile.
  const selectTab = (id: string) => {
    revealTerminal(id);
  };

  // A shelf chip, clicked: on the wall by the same rule, glowing once so the
  // eye finds where it landed.
  const placeFromShelf = (id: string) => {
    revealTerminal(id);
    requestAnimationFrame(() => hailTileRef.current(id));
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
  // on a header chip or a shelf chip becomes a drag past DRAG_THRESHOLD_PX;
  // the tiles' boxes are measured ONCE at that moment (per-move reads would
  // force layout above frame rate, the gutter's lesson), the tile under the
  // pointer is outlined with `hintTile`, and a label follows the pointer as a
  // fixed-position ghost. Dropping a header on a tile SWAPS the two
  // (`setTile`); dropping a shelf chip PLACES it there and sends the occupant
  // to the shelf. The click that ends a drag is swallowed, so the chip's own
  // click (open the menu, place by rule) never fires on top of the drop.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // A drag in flight (past the threshold) — parking holds still for it. A
  // press that never travels doesn't count.
  const draggingRef = useRef(false);
  const dropTerminal = (id: string, target: number) => {
    if (!tabsRef.current.some((t) => t.id === id)) return;
    if (tilesRef.current[target] === undefined) return;
    if (zoomed !== null) setZoomedId(null);
    showInTile(target, id);
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
      finish(active ? tileAtPoint(boxes, ev.clientX, ev.clientY) : null);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(null);
    };
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

  const parkTile = (index: number) => {
    const prev = tilesRef.current;
    const id = prev[index];
    const next = removeTileAt(prev, index);
    if (next === prev) return;
    recordEvictions(prev, next);
    setTiles(next);
    // Keep focus on the same terminal when the parked tile sat before it.
    const focus = focusIdxRef.current;
    if (index < focus) setFocusedTile(focus - 1);
    setFreshParked(id);
  };
  const parkRef = useRef(parkTile);
  parkRef.current = parkTile;
  usePoll(
    () => {
      if (hoverRef.current || isResizing() || draggingRef.current) return;
      const index = parkCandidate({
        tiles: tilesRef.current,
        states: statesRef.current,
        pinned: pinnedRef.current,
        focusIdx: focusIdxRef.current,
        zoomedId: zoomedRef.current,
        since: sinceRef.current,
        touched: touchedRef.current,
        now: Date.now(),
      });
      if (index !== null) parkRef.current(index);
    },
    PARK_TICK_MS,
    { pauseWhenHidden: true, leading: false },
  );
  const hintTileRef = useRef(hintTile);
  hintTileRef.current = hintTile;

  // ⌘⇧J and the footer chip. The tile it lands in is hailed (on a wall of
  // fourteen the focus ring alone doesn't catch the eye) and its terminal
  // takes the caret a frame later, once the placement has painted — a jump
  // to a tile already on screen has no reveal transition to focus it.
  const jumpToNeedsYou = (): boolean => {
    const target = nextNeedsYou(
      loudRef.current.map((t) => t.id),
      tilesRef.current[focusIdxRef.current],
    );
    if (!target) return false;
    revealTerminal(target);
    requestAnimationFrame(() => {
      hailTileRef.current(target);
      focusTerminalView(target);
    });
    return true;
  };
  const jumpRef = useRef(jumpToNeedsYou);
  jumpRef.current = jumpToNeedsYou;

  // Expose selection to the host. Handlers are recreated each render, so the
  // handle reads them through refs and guards against a stale id (a terminal
  // closed since the folder→terminal mapping was recorded).
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  const hailTileRef = useRef(hailTile);
  hailTileRef.current = hailTile;
  const openTileRef = useRef(openTerminalTile);
  openTileRef.current = openTerminalTile;
  const addSessionTab = useCallback((tab: Tab, background = false) => {
    const victim = replaceablePlaceholder(tabsRef.current, liveCwdsRef.current, homePathRef.current);
    setTabs((prev) => [...prev.filter((existing) => existing.id !== victim), tab]);
    if (victim) {
      // A background restore must inherit this tile too: an empty dock is
      // never useful, and the pristine shell was only holding its place.
      setTiles(tilesRef.current.map((id) => id === victim ? tab.id : id));
      forgetTab(victim);
    } else if (!background) {
      openTileRef.current(tab.id);
    }
  }, [setTabs, setTiles, forgetTab]);
  const recoverDetached = async () => {
    if (recovering) return;
    setRecovering(true);
    setRecoveryError(null);
    try {
      // Recheck on click so a process that exited since boot isn't silently
      // replaced by a fresh shell under its old id.
      const live = await invoke<LivePty[]>("pty_list");
      // Snapshot ownership before replacement removes a placeholder; that
      // shell can also appear later in this list and must not be resurrected.
      const owned = new Set(tabsRef.current.map((tab) => tab.id));
      for (const pty of live.filter((pty) => pty.alive && !owned.has(pty.id))) {
        if (!tabsRef.current.some((tab) => tab.id === pty.id)) {
          addSessionTab({ id: pty.id, cwd: pty.cwd }, tilesRef.current.length >= MAX_TILES);
        }
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
      selectTab: (id: string) => {
        if (tabsRef.current.some((t) => t.id === id)) selectTabRef.current(id);
      },
      hailTerminal: (id: string) => {
        // Same stale-id guard `selectTab` takes: the mapping that produced
        // this id may outlive the terminal it named.
        if (tabsRef.current.some((t) => t.id === id)) hailTileRef.current(id);
      },
      openSessionTerminal: (cwd: string | null, opts) => {
        const id = crypto.randomUUID();
        addSessionTab({ id, cwd }, opts?.background);
        return id;
      },
      jumpToNeedsYou: () => jumpRef.current(),
    }),
    [addSessionTab],
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
    placeFromShelf,
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
    placeFromShelf,
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
    }),
    [],
  );
  // The shelf's two verbs, stable for its memo the same way.
  const placeShelfChip = useCallback(
    (id: string) => handlersRef.current.placeFromShelf(id),
    [],
  );
  const dragShelfChip = useCallback(
    (id: string, e: React.PointerEvent<HTMLElement>) =>
      handlersRef.current.beginDrag(id, e),
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
    <div
      data-tour="terminal"
      className="flex flex-col h-full"
      // Parking holds still while the pointer is over the dock: a tile must
      // never leave from under a hand reaching for it.
      onPointerEnter={() => {
        hoverRef.current = true;
      }}
      onPointerLeave={() => {
        hoverRef.current = false;
      }}
    >
      {(detached.some((pty) => !tabs.some((tab) => tab.id === pty.id)) || recoveryError) && (
        <div className="flex items-center gap-2 px-2 py-1 text-xs" role="status">
          {recoveryError && <span>{recoveryError}</span>}
          <button type="button" disabled={recovering} onClick={() => void recoverDetached()} className="underline">
            {recovering ? "Reattaching…" : recoveryError ? "Retry terminal recovery" : `Reattach ${detached.filter((pty) => !tabs.some((tab) => tab.id === pty.id)).length} detached terminals`}
          </button>
        </div>
      )}
      <TerminalShelf
        chips={shelfChips}
        onPlace={placeShelfChip}
        onDragStart={dragShelfChip}
      />
      <TerminalMenuDataContext.Provider value={menuData}>
      <div ref={paneContainerRef} className="flex-1 relative">
        {tabs.map((t) => {
          const tileIndex = tiles.indexOf(t.id);
          const tiled = tileIndex !== -1;
          const rect = tiled ? rects[tileIndex] : null;
          const isZoomed = zoomed === t.id;
          const hiddenByZoom = zoomed !== null && !isZoomed;
          const visible = tiled && !collapsed && !hiddenByZoom;
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
              {tiled && ident && (
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
                  top: TILE_HEADER_H,
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
                  onActivity={handleActivity}
                  onExit={handleExit}
                  onTitle={handleTitle}
                  onPaneFocus={handlePaneFocus}
                  onUserInput={handleUserInput}
                  onInterrupt={handleInterrupt}
                />
              </div>
              {visible && heldTerminalIds?.has(t.id) && <InterceptStrip />}
            </div>
          );
        })}
        {!collapsed && zoomed === null && (
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
