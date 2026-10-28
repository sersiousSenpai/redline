// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo, useRef, useState } from "react";
import { Pin } from "lucide-react";

import { HELD_RED } from "../lib/terminalMenu";
import { TILE_HEADER_H } from "../lib/tileGrid";
import { isLoud, type TermState } from "../lib/termState";
import type { TabIcon } from "../lib/repoIcon";
import { markImage } from "../lib/repoMarkImage";
import { useClickPopover } from "./popover";
import { TermStateBadge, termStateWords } from "./TermStateBadge";
import {
  TerminalTileMenu,
  TILE_MENU_WIDTH,
  type TileActions,
} from "./TerminalTileMenu";

/** What a tile header renders about its terminal — the stable slice served by
 *  TerminalTabs' identity memo. Headers do an O(1) byId lookup; they are
 *  never handed a freshly built per-tile object. */
export interface TerminalIdentity {
  id: string;
  /** "redline 2" — numbered in one pass over the creation-ordered tab list,
   *  so header and menu can never disagree. */
  label: string;
  icon: TabIcon;
  /** Set only when the resolved repo root disagrees with the label (`cd src`
   *  inside redline) — the tooltip explains why mark and words differ. */
  repoRoot?: string;
  /** Live cwd, else spawn cwd, else null (= $HOME). */
  dir: string | null;
}

/** The 14px mark in front of a tile's label: the repo's own logo when it
 *  ships one, otherwise the Julia set generated from its name (repoIcon.ts).
 *  Across a wall of near-identical strips the mark is the strongest identity
 *  cue, so it keeps a real logo's footprint and weight. (Moved from the
 *  deleted TerminalTabBar.) */
function TabIconMark({ icon }: { icon: TabIcon }) {
  // Keyed by src rather than a bare boolean so a tab that resolves to a
  // different repo gets a fresh attempt instead of inheriting a stale failure.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const box = {
    width: "14px",
    height: "14px",
    borderRadius: "3px",
    flexShrink: 0,
  } as const;

  const logo = icon.src !== null && failedSrc !== icon.src ? icon.src : null;
  const src = logo ?? markImage(icon.mark);
  if (src !== null) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        draggable={false}
        onError={logo === null ? undefined : () => setFailedSrc(logo)}
        // A logo is someone else's artwork and must not be cropped; the
        // generated tile is square by construction and fills the box exactly.
        style={{ ...box, objectFit: logo === null ? "cover" : "contain" }}
      />
    );
  }
  // No canvas at all — a flat chip in the mark's own hue still tells two
  // tiles apart, which is the whole job.
  return <span aria-hidden style={{ ...box, background: icon.tint }} />;
}

interface TerminalTileHeaderProps {
  tile: number;
  identity: TerminalIdentity;
  focused: boolean;
  zoomed: boolean;
  /** What the terminal is doing (lib/termState). Drives the badge in front of
   *  the work line. */
  state?: TermState;
  /** The lowest port a serving terminal listens on. */
  port?: number | null;
  /** What this terminal is working on. For a loud state, the agent's own
   *  words — the needs-you message or the your-turn excerpt; otherwise a held
   *  plan's title, else the shell's laundered window title. Null when it has
   *  volunteered nothing.
   *
   *  Primitives rather than objects throughout: this component is memo'd on
   *  shallow equality, and a fresh object per render would re-render every
   *  header on every OSC-title tick. */
  workText?: string | null;
  workHeld?: boolean;
  /** Pinned tiles never park themselves (TerminalTabs' parking effect). */
  pinned?: boolean;
  actions: TileActions;
  /** Reserved third slot in the action cluster — future chrome lands here
   *  rather than growing a second cluster. */
  extraControl?: React.ReactNode;
}

// One tile's 26px header — the terminal's tab, relocated into its tile. Three
// stacked focus cues, because one blue hairline in a grid of them is too quiet:
// header background (paper = active-tab paper, elevated otherwise), the 2px
// bottom border (info vs rule), and label ink+weight. The border is 2px in
// BOTH states: a 1px↔2px swap would change the tile's content box, reflow
// xterm and fire a pty_resize on every focus change across N tiles. Same
// family: the action cluster is always in flow at its natural width and only
// toggles opacity (styles.css .rl-tile-actions) — a width reveal would
// re-truncate the label under the pointer.
//
// Tooltips are native title=, never .rl-tipwrap — the header is
// overflow:hidden, which would clip the CSS tooltip (the same constraint the
// old repo-bubble strip documented).
export const TerminalTileHeader = memo(function TerminalTileHeader({
  tile,
  identity,
  focused,
  zoomed,
  state = "idle",
  port = null,
  workText = null,
  workHeld = false,
  pinned = false,
  actions,
  extraControl,
}: TerminalTileHeaderProps) {
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const { open, panelProps, toggle, close } = useClickPopover(
    chipRef,
    "left",
    "below",
    TILE_MENU_WIDTH,
  );

  // The work line: what the terminal says it is on, else the state's own
  // words ("working", ":5173"). A loud state reads in full ink — it is the
  // agent speaking to you — and a server keeps its port beside a title.
  const loud = isLoud(state);
  const words = termStateWords(state, port);
  const lineText = workText ?? words;
  const lineTitle =
    words && workText && words !== workText ? `${words} — ${workText}` : lineText;

  return (
    <div
      className="rl-tile-head flex items-center gap-1.5 px-1.5"
      data-focused={focused || undefined}
      data-open={open || undefined}
      onPointerDown={() => actions.onFocusTile(tile)}
      onDoubleClick={(e) => {
        // Zoom rides double-click on the header STRIP; a double-click on the
        // chip or the action buttons is two clicks on those, not a zoom.
        if ((e.target as HTMLElement).closest("button")) return;
        actions.onZoomTile(tile);
      }}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: `${TILE_HEADER_H}px`,
        zIndex: 5,
        overflow: "hidden",
        background: focused ? "var(--color-paper)" : "var(--color-bg-elevated)",
        borderBottom: `2px solid ${focused ? "var(--color-info)" : "var(--color-rule)"}`,
      }}
    >
      {/* The identity chip IS the tab: mark + label + ▾ in one button. */}
      <button
        type="button"
        ref={chipRef}
        onClick={() => {
          if (!open) actions.onRefreshCwds();
          toggle();
        }}
        title={[
          identity.label,
          identity.repoRoot ? `in ${identity.repoRoot}` : null,
          "terminals menu",
        ]
          .filter(Boolean)
          .join(" — ")}
        aria-haspopup="menu"
        aria-expanded={open}
        // The chip is also the drag handle: past a few pixels of travel the
        // press becomes drag-to-arrange (TerminalTabs owns the drag and
        // swallows the click that would otherwise open this menu).
        onPointerDown={(e) => {
          if (e.button === 0) actions.onDragStart(identity.id, e);
        }}
        className="flex items-center gap-1.5 min-w-0 cursor-pointer select-none"
        style={{ fontSize: "12px", height: "18px" }}
      >
        <TabIconMark icon={identity.icon} />
        <span
          className="truncate"
          style={{
            maxWidth: "180px",
            fontWeight: focused ? 600 : 500,
            color: focused ? "var(--color-ink)" : "var(--color-ink-muted)",
          }}
        >
          {identity.label}
        </span>
        <span
          aria-hidden
          style={{ color: "var(--color-ink-muted)", fontSize: "9px" }}
        >
          ▾
        </span>
      </button>
      {pinned && (
        <span
          title="Pinned — this tile never parks itself"
          className="shrink-0 flex items-center"
          style={{ color: "var(--color-ink-muted)" }}
        >
          <Pin size={10} strokeWidth={2} aria-hidden />
        </span>
      )}
      {/* What it is working on, in the space the spacer used to hold, behind
          the terminal's state badge: amber and pulsing when its agent is
          blocked on you, blue for your turn, a quiet spinner while it works,
          green for a server, HELD_RED for a held plan — an idle terminal
          keeps the old 4px muted dot. Muted ink unless the state is loud:
          the label beside it is the primary identity and this is the gloss.

          Native `title=`, never `.rl-tipwrap`: the header is `overflow:
          hidden` and would clip the CSS tooltip (see the note above). Both
          this and the label truncate inside `min-w-0` parents, so a narrow
          header in a fourteen-tile grid degrades instead of overflowing. */}
      {lineText ? (
        <span
          className="flex flex-1 items-center gap-1 min-w-0"
          title={lineTitle ?? undefined}
          data-term-state={state}
          style={{
            fontSize: "11px",
            fontWeight: loud ? 500 : undefined,
            color: workHeld
              ? HELD_RED
              : loud
                ? "var(--color-ink)"
                : "var(--color-ink-muted)",
          }}
        >
          <TermStateBadge
            state={workHeld && state === "idle" ? "held" : state}
            size={state === "idle" && !workHeld ? 4 : 6}
          />
          <span className="truncate">{lineText}</span>
          {state === "serving" && port !== null && workText && (
            <span
              className="shrink-0"
              style={{ color: "var(--color-success)", fontVariantNumeric: "tabular-nums" }}
            >
              :{port}
            </span>
          )}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {/* Always in flow at natural width; reveal is opacity-only. */}
      <div className="rl-tile-actions flex items-center gap-1 shrink-0">
        {extraControl}
        {/* Dock fullscreen used to live here, on the focused tile. It has
            moved to the terminal divider's centre pill (PaneDivider
            `toggleMode="fullscreen"`): a whole-dock control belongs on the
            dock's own edge, not inside one of its tiles — and the more tiles
            there are, the stranger the old home looked. Per-tile ZOOM is
            untouched: double-click this strip, or the menu's "⤢ Zoom this
            tile" row. */}
        <button
          type="button"
          onClick={() => actions.onTogglePin(identity.id)}
          aria-pressed={pinned}
          aria-label={pinned ? `Unpin ${identity.label}` : `Pin ${identity.label}`}
          title={
            pinned
              ? "Unpin — let this tile park itself once it goes quiet"
              : "Pin — keep this tile on the wall even when it goes quiet"
          }
          className="flex items-center justify-center rounded cursor-pointer"
          style={{
            width: "18px",
            height: "18px",
            color: pinned ? "var(--color-ink)" : "var(--color-ink-muted)",
          }}
        >
          <Pin size={11} strokeWidth={pinned ? 2.5 : 2} aria-hidden />
        </button>
        {zoomed && (
          <span
            title="Tile is zoomed — double-click the header to restore the grid"
            style={{ fontSize: "9px", color: "var(--color-ink-muted)" }}
          >
            zoomed
          </span>
        )}
        <button
          type="button"
          onClick={() => actions.onCloseTerminal(identity.id)}
          title="Close terminal"
          aria-label={`Close ${identity.label}`}
          className="flex items-center justify-center rounded cursor-pointer"
          style={{
            width: "18px",
            height: "18px",
            fontSize: "13px",
            lineHeight: 1,
            color: "var(--color-ink-muted)",
          }}
        >
          ×
        </button>
      </div>
      {open && (
        <TerminalTileMenu
          tile={tile}
          terminalId={identity.id}
          dir={identity.dir}
          zoomed={zoomed}
          actions={actions}
          panelProps={panelProps}
          onClose={close}
        />
      )}
    </div>
  );
});
