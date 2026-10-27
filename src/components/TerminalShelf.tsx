// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo } from "react";

import { isLoud, TERM_STATE_LABEL, type TermState } from "../lib/termState";
import { TermStateBadge, termStateWords } from "./TermStateBadge";

/** The shelf's height. It sits in flow above the grid, so the grid gives up
 *  exactly this much while any terminal is off the wall. */
export const SHELF_H = 24;

/** One untiled terminal as the shelf shows it. Primitives only, so the
 *  memoized shelf compares cheaply. */
export interface ShelfChip {
  id: string;
  label: string;
  state: TermState;
  /** The agent's words for a loud state, else what the terminal is on. */
  text: string | null;
  /** The lowest port a serving terminal listens on. */
  port: number | null;
}

interface TerminalShelfProps {
  chips: readonly ShelfChip[];
  /** Click: put this terminal on the wall by the one placement rule. */
  onPlace: (id: string) => void;
  /** Press: may become a drag onto a specific tile (TerminalTabs owns it). */
  onDragStart: (id: string, e: React.PointerEvent<HTMLElement>) => void;
}

// Every terminal the wall isn't showing, one chip each — the replacement for
// the focused header's "●3" pip, which said how many were hidden but not which,
// what they were doing, or how to get one back. Nothing here is hidden behind
// a menu: a chip says the terminal's state, name, words and port, a click puts
// it on the wall, and a drag drops it onto the tile you choose.
//
// The tab-bar traps apply (see the old repo-bubble strip): this row is short
// and `overflow: hidden` on the cross axis, so tooltips are native `title=`,
// never `.rl-tipwrap`, and the only floating piece — the drag ghost — is
// `position: fixed` off a measured point (TerminalTabs). Chips that don't fit
// scroll sideways under the wheel; the order puts what matters first.
export const TerminalShelf = memo(function TerminalShelf({
  chips,
  onPlace,
  onDragStart,
}: TerminalShelfProps) {
  if (chips.length === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Terminals off the wall"
      className="rl-shelf-strip flex items-center gap-1 px-1.5"
      onWheel={(e) => {
        // A vertical wheel scrolls the row sideways — the only direction it
        // has to go.
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.currentTarget.scrollLeft += e.deltaY;
        }
      }}
      style={{
        height: `${SHELF_H}px`,
        flexShrink: 0,
        overflowX: "auto",
        overflowY: "hidden",
        background: "var(--color-bg-elevated)",
        borderBottom: "1px solid var(--color-rule)",
      }}
    >
      {chips.map((chip) => {
        const words = termStateWords(chip.state, chip.port);
        const text = chip.text ?? words;
        return (
          <button
            key={chip.id}
            type="button"
            className="rl-shelf-chip"
            data-shelf-id={chip.id}
            data-term-state={chip.state}
            aria-label={`Show ${chip.label}${words ? ` — ${words}` : ""}`}
            title={[
              chip.label,
              TERM_STATE_LABEL[chip.state],
              chip.text,
              "click to put it on the wall, or drag it onto a tile",
            ]
              .filter(Boolean)
              .join(" — ")}
            onPointerDown={(e) => {
              if (e.button === 0) onDragStart(chip.id, e);
            }}
            onClick={() => onPlace(chip.id)}
          >
            <TermStateBadge state={chip.state} />
            <span
              className="truncate"
              style={{ fontWeight: 600, flexShrink: 0, maxWidth: "110px" }}
            >
              {chip.label}
            </span>
            {text && (
              <span
                className="truncate"
                style={{
                  color: isLoud(chip.state)
                    ? "var(--color-ink)"
                    : "var(--color-ink-muted)",
                }}
              >
                {text}
              </span>
            )}
            {chip.state === "serving" && chip.port !== null && chip.text && (
              <span
                style={{
                  color: "var(--color-success)",
                  fontVariantNumeric: "tabular-nums",
                  flexShrink: 0,
                }}
              >
                :{chip.port}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
});
