// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  HELD_RED,
  matchesTerminalQuery,
  type AttributedTerminal,
  type RepoChoice,
} from "../lib/terminalMenu";
import { Panel, PanelHeader, type PanelProps } from "./popover";

// The tile dropdown — the single place that answers "what's running, switch
// me to it, or start me a new one", which is what let the tab strip, the repo
// bubble strip and the action cluster all be deleted. Built on useClickPopover
// + Panel (which brings useMenuOverlay — the embedded browser is a native
// child webview painted above all React DOM, so a menu that skipped the
// overlay registration would be occluded by it). DocumentsMenu is the
// structural template, including its OPEN-row shape: a div.rl-menu-item
// holding a role=menuitem body button PLUS a separate button for the ✕ —
// nested buttons are invalid HTML.

/** Menu width. Wider than PANEL_WIDTH because a row carries a bold label, a
 *  right-aligned held/new-output chip, an elided work line and a location
 *  line. Threaded through useClickPopover so the placement clamp and the
 *  panel can never disagree — never override width in Panel's style. */
export const TILE_MENU_WIDTH = 320;

/** The filter row appears at this many terminals — derived, not taste: at
 *  320px an OPEN row is ~44px, and the height budget the placement helper
 *  hands a comfortably-placed menu is a few hundred px ≈ 12 rows, so the
 *  filter earns its place at about the point the list stops fitting.
 *
 *  A threshold is all this can be. The real budget is now the room beside the
 *  anchor (`placeUnder` → `maxHeight`), which differs per tile and per window
 *  size; the list scrolls when it exceeds that, whatever this number says. */
export const MENU_FILTER_THRESHOLD = 12;

/** Everything a header/menu can DO, one stable object for all N tiles —
 *  every callback takes the tile index up front so one identity serves the
 *  whole grid (currying per tile would mint N fresh closures per render and
 *  defeat every memo in the dock). */
export interface TileActions {
  /** The picking rule, from tile `tile` (see TerminalTabs.pickIntoTile). */
  onPick: (tile: number, id: string) => void;
  /** Close a terminal (kills its shell). The menu stays open — closing
   *  several is a real errand; the row vanishes under the pointer. */
  onCloseTerminal: (id: string) => void;
  onNewHere: (tile: number) => void;
  onNewHome: (tile: number) => void;
  onNewRepo: (tile: number, path: string) => void;
  onZoomTile: (tile: number) => void;
  onFocusTile: (tile: number) => void;
  /** Outline tile `tile` imperatively while a row is hovered (null clears) —
   *  a style write on the ref-mapped element, no render. */
  onHintTile: (tile: number | null) => void;
  /** Refresh every terminal's cwd (one batched pty_cwds) — the menu is the
   *  fleet's only inventory, and a never-tiled terminal would otherwise show
   *  its stale spawn cwd. Called on open. */
  onRefreshCwds: () => void;
}

/** Everything high-churn the menu renders (work lines, held, unseen, repo
 *  counts), served through context and consumed only by an OPEN menu — an
 *  OSC title or a 2.5s cwd tick re-renders one component, usually zero. A
 *  terminal that starts holding while the menu is open lights up live. */
export interface TerminalMenuData {
  /** OPEN rows, pre-ordered: tiled in tile order, then untiled
   *  most-recently-evicted first. */
  rows: readonly AttributedTerminal[];
  repos: readonly RepoChoice[];
  homePath: string | null;
}

export const TerminalMenuDataContext = createContext<TerminalMenuData>({
  rows: [],
  repos: [],
  homePath: null,
});

/** `/Users/me/redline` → `~/redline`, so paths in the menu stay readable. */
function tildeify(path: string, homePath: string | null): string {
  if (homePath && (path === homePath || path.startsWith(`${homePath}/`))) {
    return `~${path.slice(homePath.length)}`;
  }
  return path;
}

interface TerminalTileMenuProps {
  tile: number;
  /** This tile's terminal's live cwd — the panel header and the "New
   *  terminal here" caption. */
  dir: string | null;
  zoomed: boolean;
  actions: TileActions;
  panelProps: Pick<PanelProps, "style" | "panelRef">;
  onClose: () => void;
}

/** One actionable row for the roving keyboard selection. */
interface MenuItem {
  key: string;
  run: () => void;
}

export function TerminalTileMenu({
  tile,
  dir,
  zoomed,
  actions,
  panelProps,
  onClose,
}: TerminalTileMenuProps) {
  const { rows, repos, homePath } = useContext(TerminalMenuDataContext);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);

  const showFilter = rows.length >= MENU_FILTER_THRESHOLD;
  const visibleRows = rows.filter((r) =>
    matchesTerminalQuery(
      {
        label: r.label,
        work: r.work,
        subPath: r.subPath,
        dir: r.dir,
        repoName: r.repo?.name ?? null,
      },
      query,
    ),
  );
  const visibleRepos = repos.filter((r) =>
    matchesTerminalQuery({ repoName: r.name }, query),
  );

  // The flat action list the roving selection walks — one matcher, both
  // sections, then the fixed verbs. Rebuilt per render from the same filter
  // the JSX renders from, so index i here IS row i on screen.
  const items: MenuItem[] = [
    ...visibleRows.map((r) => ({
      key: `t:${r.id}`,
      run: () => {
        onClose();
        actions.onPick(tile, r.id);
      },
    })),
    ...visibleRepos.map((r) => ({
      key: `r:${r.path}`,
      run: () => {
        onClose();
        actions.onNewRepo(tile, r.path);
      },
    })),
    {
      key: "new-here",
      run: () => {
        onClose();
        actions.onNewHere(tile);
      },
    },
    {
      key: "new-home",
      run: () => {
        onClose();
        actions.onNewHome(tile);
      },
    },
    {
      key: "zoom",
      run: () => {
        onClose();
        actions.onZoomTile(tile);
      },
    },
  ];
  const activeIdx = Math.min(active, items.length - 1);
  const activeKey = items[activeIdx]?.key;

  // The menu is now the only way to reach an untiled terminal, so it earns
  // real keyboard reach: focus lands in the filter (or the list), arrows
  // rove, Enter activates. Escape rides useDismiss.
  useEffect(() => {
    (filterRef.current ?? listRef.current)?.focus();
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  // A hint outline must never outlive the menu that painted it.
  useEffect(() => () => actions.onHintTile(null), [actions]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[activeIdx]?.run();
    }
  };

  const heading = (text: string) => (
    <div className="rl-menu-heading" style={{ marginTop: "4px" }}>
      {text}
    </div>
  );
  const sep = <div className="rl-menu-sep" aria-hidden />;
  const hereLabel = dir ? tildeify(dir, homePath) : "~";

  return (
    <Panel label={`Terminals — tile ${tile + 1}`} {...panelProps}>
      <PanelHeader>{hereLabel}</PanelHeader>
      <div
        ref={listRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="rl-thin-scroll-y py-1 outline-none"
        // The bound comes from Panel's `maxHeight` — the room actually left
        // beside this tile's ▾ — not from a `60vh` fraction of a window the
        // menu was never measured against. `minHeight: 0` is what lets a flex
        // child shrink below its content and therefore scroll at all.
        style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto" }}
      >
        {showFilter && (
          <div className="px-2 pb-1">
            <input
              ref={filterRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder="⌕ filter terminals and repos…"
              aria-label="Filter terminals and repos"
              className="w-full rounded-sm px-2 py-1 font-sans"
              style={{
                fontSize: "12px",
                border: "1px solid var(--color-rule)",
                background: "var(--color-paper)",
                color: "var(--color-ink)",
              }}
            />
          </div>
        )}
        {visibleRows.length > 0 && heading("Open")}
        {visibleRows.map((r) => (
          <OpenRow
            key={r.id}
            row={r}
            menuTile={tile}
            homePath={homePath}
            selected={activeKey === `t:${r.id}`}
            onPick={() => {
              onClose();
              actions.onPick(tile, r.id);
            }}
            onCloseTerminal={() => actions.onCloseTerminal(r.id)}
            onHintTile={actions.onHintTile}
          />
        ))}
        {visibleRepos.length > 0 && (
          <>
            {sep}
            {heading("New terminal in")}
            {visibleRepos.map((r) => (
              <button
                key={r.path}
                type="button"
                role="menuitem"
                aria-selected={activeKey === `r:${r.path}` || undefined}
                onClick={() => {
                  onClose();
                  actions.onNewRepo(tile, r.path);
                }}
                title={`New terminal in ${r.path} + Claude (plan mode)`}
                className="rl-menu-item w-full text-left px-3 py-1.5 font-sans flex items-baseline gap-2"
                style={{ fontSize: "12px", color: "var(--color-ink)", cursor: "pointer" }}
              >
                <span className="min-w-0 flex-1 truncate" style={{ fontWeight: 600 }}>
                  {r.name}
                </span>
                <span
                  className="shrink-0"
                  style={{ color: "var(--color-ink-muted)", fontSize: "11px" }}
                >
                  {r.count === 0
                    ? "no terminals"
                    : `${r.count} ${r.count === 1 ? "terminal" : "terminals"}`}
                </span>
              </button>
            ))}
          </>
        )}
        {sep}
        <FooterRow
          selected={activeKey === "new-here"}
          caption={hereLabel}
          onClick={() => {
            onClose();
            actions.onNewHere(tile);
          }}
        >
          ＋ New terminal here
        </FooterRow>
        <FooterRow
          selected={activeKey === "new-home"}
          caption="~"
          onClick={() => {
            onClose();
            actions.onNewHome(tile);
          }}
        >
          ＋ New terminal in home
        </FooterRow>
        <FooterRow
          selected={activeKey === "zoom"}
          onClick={() => {
            onClose();
            actions.onZoomTile(tile);
          }}
        >
          {zoomed ? "⤡ Unzoom this tile" : "⤢ Zoom this tile"}
        </FooterRow>
      </div>
    </Panel>
  );
}

/** One OPEN row. Structure per DocumentsMenu's OPEN rows: the body and the ✕
 *  are SIBLING buttons inside the .rl-menu-item div — nested buttons are
 *  invalid HTML. The ✕ closes that terminal and LEAVES THE MENU OPEN. */
function OpenRow({
  row,
  menuTile,
  homePath,
  selected,
  onPick,
  onCloseTerminal,
  onHintTile,
}: {
  row: AttributedTerminal;
  menuTile: number;
  homePath: string | null;
  selected: boolean;
  onPick: () => void;
  onCloseTerminal: () => void;
  onHintTile: (tile: number | null) => void;
}) {
  const isThisTile = row.tile === menuTile;
  const tiled = row.tile !== null;
  // State-dot grammar (DocumentsMenu's): filled info = this tile, filled
  // muted = another tile, hollow ring = alive but untiled.
  const dot: CSSProperties = {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    flexShrink: 0,
    ...(tiled
      ? {
          background: isThisTile
            ? "var(--color-info)"
            : "var(--color-ink-muted)",
        }
      : { border: "1px solid var(--color-ink-muted)" }),
  };
  // The location line says "on screen" rather than an unverifiable "tile 3" —
  // "which tile?" is answered by the hover outlining the tile itself.
  const where = row.repo
    ? [row.repo.name, row.subPath || null, tiled ? "on screen" : null]
    : [row.dir ? tildeify(row.dir, homePath) : "~", tiled ? "on screen" : null];

  return (
    <div
      className="rl-menu-item flex items-start gap-2 px-3 py-1.5 font-sans"
      aria-selected={selected || undefined}
      style={{ fontSize: "12px", cursor: "pointer" }}
      onPointerEnter={tiled ? () => onHintTile(row.tile) : undefined}
      onPointerLeave={tiled ? () => onHintTile(null) : undefined}
    >
      <button
        type="button"
        role="menuitem"
        onClick={onPick}
        aria-label={`Show ${row.label} in this tile`}
        className="min-w-0 flex-1 text-left"
        style={{ display: "block", cursor: "pointer" }}
      >
        <span className="flex items-center gap-2">
          <span aria-hidden style={dot} />
          <span
            className="truncate"
            style={{
              fontWeight: isThisTile ? 600 : 400,
              color: "var(--color-ink)",
            }}
          >
            {row.label}
          </span>
          <span className="flex items-center gap-2 ml-auto shrink-0">
            {row.held && (
              <span style={{ color: HELD_RED, fontSize: "10px" }}>
                plan held
              </span>
            )}
            {row.unseen && !row.held && (
              <span
                className="flex items-center gap-1"
                style={{ color: "var(--color-info)", fontSize: "10px" }}
              >
                <span
                  aria-hidden
                  style={{
                    width: "5px",
                    height: "5px",
                    borderRadius: "50%",
                    background: "var(--color-info)",
                  }}
                />
                new output
              </span>
            )}
          </span>
        </span>
        {/* What this terminal is on. A held plan is the one thing Redline can
            state outright — its `claude` is stopped at that document — so it
            gets the intercept red; anything else came from the shell's own
            window title and stays quieter. Absent when the terminal has
            volunteered nothing, rather than padding the row with a guess. */}
        {row.work && (
          <span
            className="flex items-center gap-1.5"
            style={{
              fontSize: "11px",
              color: row.held ? HELD_RED : "var(--color-ink)",
              marginTop: "2px",
            }}
          >
            <span
              aria-hidden
              className="shrink-0"
              style={{
                width: "4px",
                height: "4px",
                borderRadius: "50%",
                background: row.held ? HELD_RED : "var(--color-ink-muted)",
              }}
            />
            <span className="truncate">{row.work}</span>
          </span>
        )}
        <span
          className="truncate"
          style={{
            display: "block",
            fontSize: "10px",
            color: "var(--color-ink-muted)",
            marginTop: "1px",
          }}
        >
          {where.filter(Boolean).join(" · ")}
        </span>
      </button>
      <button
        type="button"
        onClick={onCloseTerminal}
        title="Close terminal"
        aria-label={`Close ${row.label}`}
        className="shrink-0"
        style={{
          color: "var(--color-ink-muted)",
          cursor: "pointer",
          fontSize: "12px",
          lineHeight: 1,
          padding: "2px",
        }}
      >
        ×
      </button>
    </div>
  );
}

function FooterRow({
  children,
  caption,
  selected,
  onClick,
}: {
  children: React.ReactNode;
  caption?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-selected={selected || undefined}
      onClick={onClick}
      className="rl-menu-item w-full text-left px-3 py-1.5 font-sans flex items-baseline gap-2"
      style={{ fontSize: "12px", color: "var(--color-ink)", cursor: "pointer" }}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {caption && (
        <span
          className="shrink-0 truncate"
          style={{
            color: "var(--color-ink-muted)",
            fontSize: "10.5px",
            maxWidth: "45%",
          }}
        >
          {caption}
        </span>
      )}
    </button>
  );
}
