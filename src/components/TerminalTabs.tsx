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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { homeDir } from "@tauri-apps/api/path";
import { usePersistedState } from "../theme/usePersistedState";
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
  setTile as setTileSlot,
} from "../lib/tileSlots";
import { rafCoalesce } from "../lib/raf";
import { isResizing, onResizeSession } from "../lib/resizeSession";
import { workSignal } from "../lib/termTitle";
import { iconFor } from "../lib/repoIcon";
import { useRepoIcons } from "../hooks/useRepoIcons";
import type { ProjectOption } from "./ProjectPicker";
import { ErrorBoundary } from "./ErrorBoundary";
import { TerminalView, enqueuePtyOp, tauriHandoffDeps } from "./TerminalView";
import { deliverToTerminal } from "../lib/terminalHandoff";
import {
  TerminalTileHeader,
  type OverflowPip,
  type TerminalIdentity,
} from "./TerminalTileHeader";
import {
  TerminalMenuDataContext,
  type TerminalMenuData,
  type TileActions,
} from "./TerminalTileMenu";
import { TileGutter } from "./TileGutter";
import { CloseConfirmModal } from "./CloseConfirmModal";

interface Tab {
  id: string;
  /** cwd this tab's shell was spawned in (null = $HOME, resolved backend). */
  cwd: string | null;
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
  onActivityChange: (hasUnseen: boolean) => void;
  /** Dock is fully collapsed (no tile is really visible). */
  collapsed: boolean;
  /** Notified whenever the focused terminal changes. The host (App) uses this
   *  to route post-submit PTY injects and cwd-follow polling to whichever
   *  terminal the reviewer is currently watching. Best-effort: a "wrong" tile
   *  is still strictly better than the alternative of no inject at all. */
  onActiveTabChange?: (id: string) => void;
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
   *  held/unseen state normally, so `selectTab` promotes it on demand. */
  openSessionTerminal: (
    cwd: string | null,
    opts?: { background?: boolean },
  ) => string;
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
// Every tile carries its own 26px header (repo mark + label + ▾ menu); the
// menu is the fleet's single inventory — the old tab strip, repo-bubble strip
// and action cluster all folded into it.
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
      onActivityChange,
      collapsed,
      onActiveTabChange,
      heldTerminalIds,
      heldPlanTitles,
      projectOptions,
    }: TerminalTabsProps,
    ref,
  ) {
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { id: crypto.randomUUID(), cwd: null },
  ]);
  // The visible tiles: terminal ids in row-major grid order, 1..MAX_TILES.
  // Tile count is deliberately NOT persisted — parity with the old dock,
  // whose split didn't survive a reload either.
  const [tiles, setTiles] = useState<readonly string[]>(() => [tabs[0].id]);
  const [focusedTile, setFocusedTile] = useState(0);
  // One tile temporarily taking the whole dock (menu row / header
  // double-click). Stored as the terminal id and DERIVED against `tiles`, so
  // a closed terminal can never leave the dock stuck zoomed.
  const [zoomedId, setZoomedId] = useState<string | null>(null);
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

  const paneContainerRef = useRef<HTMLDivElement | null>(null);
  // Tile wrappers keyed by terminal ID, not index — the live drag path and the
  // hover outline write styles through this map without a render.
  const tileElsRef = useRef(new Map<string, HTMLElement>());
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
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

  const handleExit = useCallback((_id: string) => {
    // Keep the terminal around so the user sees "[process exited]"; they
    // close it from its tile or the menu.
  }, []);

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

  useEffect(() => {
    onActivityChange(unseen.size > 0);
  }, [unseen, onActivityChange]);

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

  // Poll every VISIBLE tile in one batched `pty_cwds` — one subprocess per
  // tick at any tile count (perf-budget rule 5; the per-pane `pty_cwd` loop
  // this replaces was one `lsof` per pane per tick). Hidden terminals keep
  // their last-known label and refresh the instant they're shown (a `tiles`
  // change re-runs this effect) or the menu opens (refreshAllCwds).
  useEffect(() => {
    let cancelled = false;
    const ids = [...tiles];
    const poll = async () => {
      try {
        const map = await invoke<Record<string, string>>("pty_cwds", { ids });
        if (!cancelled) mergeCwds(Object.entries(map));
      } catch {
        /* keep last-known labels */
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tiles, mergeCwds]);

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

  // Everything high-churn (work lines, held, unseen, repo counts), served
  // through context and consumed only by an OPEN menu — an OSC title or a
  // 2.5s cwd tick then re-renders one component, usually zero. A terminal
  // that starts holding while the menu is open lights up live.
  const menuData = useMemo<TerminalMenuData>(() => {
    const terminalRefs: TerminalRef[] = identity.list.map((x) => {
      const tileIndex = tiles.indexOf(x.id);
      return {
        id: x.id,
        dir: x.dir,
        label: x.label,
        // What this one is *working on*: the plan it's holding for review,
        // else whatever it announced as its window title — minus the cwd
        // echoes every shell writes, which the row's location already says.
        work:
          workSignal(heldPlanTitles?.get(x.id), termTitles.get(x.id), x.dir)
            ?.text ?? null,
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
  ]);

  // The focused header's pip: terminals in no tile are otherwise invisible
  // now the tab strip is gone. Toned held > unseen > muted.
  const overflow = useMemo<OverflowPip | null>(() => {
    const untiled = tabs.filter((t) => !tiles.includes(t.id));
    if (untiled.length === 0) return null;
    return {
      count: untiled.length,
      tone: untiled.some((t) => heldTerminalIds?.has(t.id))
        ? "held"
        : untiled.some((t) => unseen.has(t.id))
          ? "unseen"
          : "muted",
    };
  }, [tabs, tiles, heldTerminalIds, unseen]);

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
    setFocusedTile(Math.min(index, next.length - 1));
    clearUnseen(id);
  };

  // Prefer a FRESH tile while the grid has room — with several tiles,
  // silently evicting the focused one is surprising; past MAX_TILES the
  // fallback tile's occupant is replaced.
  const openTerminalTile = (id: string, fallbackTile: number) => {
    const prev = tilesRef.current;
    const next = addTileSlot(prev, id, MAX_TILES);
    if (next !== prev) {
      setTiles(next);
      setFocusedTile(next.length - 1);
      clearUnseen(id);
    } else {
      showInTile(fallbackTile, id);
    }
  };

  // cwd null → backend resolves to $HOME ("root").
  const addTab = (cwd: string | null, fallbackTile?: number) => {
    const id = crypto.randomUUID();
    setTabs((prev) => [...prev, { id, cwd }]);
    openTerminalTile(id, fallbackTile ?? focusIdxRef.current);
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
      addTab(dir, tile);
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
  const openRepoTerminal = (tile: number, path: string) => {
    setRecentDirs((prev) => bumpMru(prev, path, MAX_MENU_REPOS));
    const id = addTab(path, tile);
    void typeClaudeInto(id);
  };

  const closeTab = (id: string) => {
    // Through the lifecycle fence: closing a terminal the instant it opened
    // must not let the kill overtake the still-queued spawn (orphan shell).
    void enqueuePtyOp(id, () => invoke("pty_kill", { id }));
    clearUnseen(id);
    setUntiledMru((m) => (m.includes(id) ? m.filter((x) => x !== id) : m));
    if (zoomedId === id) setZoomedId(null);

    if (tabs.length === 1 && tabs[0].id === id) {
      // Last terminal: never leave the dock empty — spawn a replacement.
      const newId = crypto.randomUUID();
      setTabs([{ id: newId, cwd: null }]);
      setTiles([newId]);
      setFocusedTile(0);
      return;
    }

    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);

    // Refill every tile that showed it (left neighbour, then right, skipping
    // already-tiled ids), dropping the tile when nothing is left.
    const rec = reconcileTiles(
      tilesRef.current,
      focusIdxRef.current,
      id,
      idx,
      next.map((t) => t.id),
    );
    if (rec.tiles !== tilesRef.current) setTiles(rec.tiles);
    setFocusedTile(rec.focus);
  };

  // The REVEAL rule, kept deliberately different from showInTile's placement
  // rule: App is saying "show me X" — if X is already tiled, focus that tile;
  // else load it into the focused tile. (The menu's picking rule swaps
  // instead, because there the user aimed at a specific tile.)
  const selectTab = (id: string) => {
    const i = tilesRef.current.indexOf(id);
    if (i !== -1) {
      setFocusedTile(i);
      clearUnseen(id);
      return;
    }
    showInTile(focusIdxRef.current, id);
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

  // Expose selection to the host. Handlers are recreated each render, so the
  // handle reads them through refs and guards against a stale id (a terminal
  // closed since the folder→terminal mapping was recorded).
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  const hailTileRef = useRef(hailTile);
  hailTileRef.current = hailTile;
  const openTileRef = useRef(openTerminalTile);
  openTileRef.current = openTerminalTile;
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
        setTabs((prev) => [...prev, { id, cwd }]);
        // Prefer an empty slot in the grid over silently evicting whatever
        // the reviewer was watching in the focused tile. Skipped entirely for
        // a background terminal: the tab exists (so its PTY spawns and the
        // menus list it), it simply occupies no tile until something asks.
        if (!opts?.background) openTileRef.current(id, focusIdxRef.current);
        return id;
      },
    }),
    [],
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
  };
  const tileActions = useMemo<TileActions>(
    () => ({
      onPick: (tile, id) => handlersRef.current.showInTile(tile, id),
      onCloseTerminal: (id) => handlersRef.current.closeTab(id),
      onNewHere: (tile) => handlersRef.current.newHere(tile),
      onNewHome: (tile) => handlersRef.current.addTab(null, tile),
      onNewRepo: (tile, path) =>
        handlersRef.current.openRepoTerminal(tile, path),
      onZoomTile: (tile) => handlersRef.current.zoomTile(tile),
      onFocusTile: (tile) => handlersRef.current.focusTile(tile),
      onHintTile: (tile) => handlersRef.current.hintTile(tile),
      onRefreshCwds: () => handlersRef.current.refreshAllCwds(),
    }),
    [],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  // Position each terminal's wrapper by its tile rect using CSS only — never
  // by moving it to a different JSX parent, which would unmount/remount the
  // TerminalView and kill its PTY. Untiled wrappers are display:none — a
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
    <div data-tour="terminal" className="flex flex-col h-full">
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
          // What this terminal is on, beside its name. Same derivation the
          // tile menu uses — a held plan's title, else the shell's laundered
          // OSC 0/2 window title — just no longer confined to the ▾ dropdown.
          //
          // Passed as PRIMITIVES, deliberately. TerminalTileHeader is memo'd
          // with the default shallow compare, so a fresh `{text, held}` object
          // per render would re-render all fourteen headers on every OSC-title
          // tick; two scalars re-render only the tile whose title actually
          // changed. For the same reason this stays OUT of the `identity`
          // memo — that memo's stability is what keeps the headers cheap, and
          // `menuData` depends on it.
          const work = ident
            ? workSignal(
                heldPlanTitles?.get(t.id),
                termTitles.get(t.id),
                ident.dir,
              )
            : null;
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
              style={wrapperStyle(rect, isZoomed, hiddenByZoom)}
            >
              {tiled && ident && (
                // The boundary wraps the HEADER ELEMENT ONLY — around the
                // whole wrapper it would unmount the TerminalView on a header
                // crash, and unmounting a TerminalView kills its PTY. A
                // crashed header just disappears; the shell keeps running.
                <ErrorBoundary fallback={() => null}>
                  <TerminalTileHeader
                    tile={tileIndex}
                    identity={ident}
                    focused={tileIndex === focusIdx}
                    overflow={tileIndex === focusIdx ? overflow : null}
                    zoomed={isZoomed}
                    workText={work?.text ?? null}
                    workHeld={work?.held ?? false}
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
