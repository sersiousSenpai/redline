// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { CSSProperties } from "react";

import { HELD_RED } from "../lib/terminalMenu";
import { TERM_STATE_LABEL, type TermState } from "../lib/termState";

/** Each state's colour — one table, so the tile header, the shelf chip and the
 *  menu row can never paint the same state two ways. Amber for blocked on
 *  you, blue for your turn, green for a server, the intercept red for a held
 *  plan; everything else stays in muted ink. */
export const TERM_STATE_COLOR: Record<TermState, string> = {
  "needs-you": "var(--color-warning)",
  "your-turn": "var(--color-info)",
  working: "var(--color-ink-muted)",
  running: "var(--color-ink)",
  serving: "var(--color-success)",
  held: HELD_RED,
  idle: "var(--color-ink-muted)",
  exited: "var(--color-ink-muted)",
};

/** A terminal's state as a glyph: a dot in the state's colour, a pulsing one
 *  for needs-you, a quiet spinner for working, a hollow ring once the process
 *  has exited. Purely decorative (`aria-hidden`) — every surface that shows
 *  one also says the state in words, in text or a title. The animations live
 *  in styles.css (`.rl-term-badge`) and stop under reduced motion. */
export function TermStateBadge({
  state,
  size = 6,
}: {
  state: TermState;
  size?: number;
}) {
  const color = TERM_STATE_COLOR[state];
  const box: CSSProperties = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: "50%",
    flexShrink: 0,
    boxSizing: "border-box",
  };
  if (state === "working") {
    return (
      <span
        aria-hidden
        className="rl-term-badge rl-term-badge--spin"
        style={{ ...box, border: `1.5px solid ${color}`, borderTopColor: "transparent" }}
      />
    );
  }
  if (state === "exited") {
    return (
      <span aria-hidden className="rl-term-badge" style={{ ...box, border: `1px solid ${color}` }} />
    );
  }
  return (
    <span
      aria-hidden
      className={`rl-term-badge${state === "needs-you" ? " rl-term-badge--pulse" : ""}`}
      style={{ ...box, background: color }}
    />
  );
}

/** "needs you", "your turn", ":5173" — the words a chip shows for a state.
 *  A server is named by its port, which is the thing you'd type into a
 *  browser; idle says nothing at all. */
export function termStateWords(state: TermState, port: number | null): string | null {
  if (state === "serving" && port !== null) return `:${port}`;
  if (state === "idle") return null;
  return TERM_STATE_LABEL[state];
}
