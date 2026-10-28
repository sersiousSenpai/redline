// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  HELD_COLOR,
  matchesTerminalQuery,
  type AttributedTerminal,
  type RepoChoice,
} from "../lib/terminalMenu";
import { Panel, PanelHeader, type PanelProps } from "./popover";
import {
  TERM_STATE_COLOR,
  TermStateBadge,
  termStateWords,
} from "./TermStateBadge";

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
const MENU_FILTER_THRESHOLD = 12;

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
  /** Pin or unpin a terminal: a pinned tile never parks itself. */
  onTogglePin: (id: string) => void;
  /** A press on a header chip that may become a drag onto another tile.
   *  TerminalTabs owns the gesture: under its threshold it is a plain click
   *  and nothing happens here. */
  onDragStart: (id: string, e: React.PointerEvent<HTMLElement>) => void;
  /** Give a terminal a name of its own (empty clears it). */
  onRename?: (id: string, name: string) => void;
  /** Copy a terminal's ids (its PTY's, and its session's when it is one's
   *  agent) to the clipboard. */
  onCopyIds?: (id: string) => void;
  /** A session's agent terminal: fork its conversation into a new
   *  terminal, or resume it where the agent is no longer running. */
  onSessionAction?: (kind: "fork" | "resume", id: string) => void;
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
  /** Agent terminals and the session each one runs: fork and resume are
   *  offered for these. */
  agents?: ReadonlyMap<string, string>;
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
  /** The terminal this tile shows: what Rename, Copy ids, Fork and Resume
   *  act on. */
  terminalId?: string;
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
  terminalId,
  dir,
  zoomed,
  actions,
  panelProps,
  onClose,
}: TerminalTileMenuProps) {
  const { rows, repos, homePath, agents } = useContext(TerminalMenuDataContext);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState(false);
  const self = terminalId ? rows.find((r) => r.id === terminalId) : undefined;
  const agentSession = terminalId ? agents?.get(terminalId) : undefined;
  // Resume only where the agent is no longer running: a second claude on
  // the same conversation would race the first.
  const resumable = !!agentSession && (self?.state === "exited" || self?.state === "idle" || self?.state === undefined);
  const forkable = !!agentSession && !resumable;
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
    ...(terminalId && actions.onRename ? [{ key: "rename", run: () => setRenaming(true) }] : []),
    ...(terminalId && actions.onCopyIds
      ? [{ key: "copy", run: () => { onClose(); actions.onCopyIds!(terminalId); } }]
      : []),
    ...(terminalId && actions.onSessionAction && (forkable || resumable)
      ? [{ key: "session", run: () => { onClose(); actions.onSessionAction!(resumable ? "resume" : "fork", terminalId); } }]
      : []),
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

  // The menu is the keyboard's way to an untiled terminal (the shelf is the
  // pointer's), so it earns real keyboard reach: focus lands in the filter
  // (or the list), arrows rove, Enter activates. Escape rides useDismiss.
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
    if (renaming) return; // the name field owns its keys
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
        {visibleRows.length > 0 && !visibleRows.some((r) => r.owner) && heading("Open")}
        {visibleRows.length > 0 && visibleRows.some((r) => r.owner) && !visibleRows[0].owner && heading("This session")}
        {visibleRows.map((r, i) => (
          <Fragment key={r.id}>
          {r.owner && !visibleRows[i - 1]?.owner && heading("Other sessions")}
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
          </Fragment>
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
        {terminalId && (actions.onRename || actions.onCopyIds || actions.onSessionAction) && (
          <>
            {sep}
            {heading("This terminal")}
            {renaming ? (
              <div className="px-3 py-1.5">
                <input
                  autoFocus
                  defaultValue={self?.label ?? ""}
                  aria-label="Terminal name"
                  className="w-full rounded-sm px-2 py-1 font-sans"
                  style={{ fontSize: "12px", border: "1px solid var(--color-rule)", background: "var(--color-paper)", color: "var(--color-ink)" }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      actions.onRename?.(terminalId, e.currentTarget.value.trim());
                      onClose();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setRenaming(false);
                    }
                  }}
                />
              </div>
            ) : actions.onRename && (
              <FooterRow selected={activeKey === "rename"} onClick={() => setRenaming(true)}>
                Rename…
              </FooterRow>
            )}
            {actions.onCopyIds && (
              <FooterRow
                selected={activeKey === "copy"}
                caption={agentSession ? "terminal + session" : undefined}
                onClick={() => {
                  onClose();
                  actions.onCopyIds!(terminalId);
                }}
              >
                Copy ids
              </FooterRow>
            )}
            {actions.onSessionAction && (forkable || resumable) && (
              <FooterRow
                selected={activeKey === "session"}
                onClick={() => {
                  onClose();
                  actions.onSessionAction!(resumable ? "resume" : "fork", terminalId);
                }}
              >
                {resumable ? "Resume the session in a new terminal" : "Fork the session into a new terminal"}
              </FooterRow>
            )}
          </>
        )}
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
  // What the terminal is doing, in words: "needs you", "working", ":5173".
  // Idle says nothing — "new output" (below) is the only news an idle
  // terminal has.
  const state = row.state;
  const chip = state ? termStateWords(state, row.port ?? null) : null;
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
  // Another session's terminal names that session first: picking it moves
  // it here (and off whatever wall had it).
  const where = row.repo
    ? [row.owner ?? null, row.repo.name, row.subPath || null, tiled ? "on screen" : null]
    : [row.owner ?? null, row.dir ? tildeify(row.dir, homePath) : "~", tiled ? "on screen" : null];

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
            {state && chip ? (
              <span
                className="flex items-center gap-1"
                style={{ color: TERM_STATE_COLOR[state], fontSize: "10px" }}
              >
                <TermStateBadge state={state} size={5} />
                {chip}
              </span>
            ) : row.held && !state ? (
              <span style={{ color: HELD_COLOR, fontSize: "10px" }}>
                plan held
              </span>
            ) : null}
            {!chip && row.unseen && !row.held && (
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
              color: row.held ? HELD_COLOR : "var(--color-ink)",
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
                background: row.held ? HELD_COLOR : "var(--color-ink-muted)",
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
