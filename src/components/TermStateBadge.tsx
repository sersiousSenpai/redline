// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { CSSProperties } from "react";

import { TERM_STATE_LABEL, type TermState } from "../lib/termState";
import { paneStatusOf } from "../workbench/status";
import { Spinner } from "./Spinner";

/** Each state's ink, in the one status vocabulary (workbench/status): amber
 *  for whatever needs you (a question, your turn, a held plan), muted ink for
 *  everything else. One table, so the tile header and the menu row can never
 *  paint the same state two ways. No red: the palette has none. */
export const TERM_STATE_COLOR: Record<TermState, string> = {
  "needs-you": "var(--color-warning)",
  "your-turn": "var(--color-warning)",
  held: "var(--color-warning)",
  working: "var(--color-ink-muted)",
  running: "var(--color-ink-muted)",
  serving: "var(--color-ink-muted)",
  idle: "var(--color-ink-muted)",
  exited: "var(--color-ink-muted)",
};

/** A terminal's state as a glyph, in the one vocabulary the tab dots and the
 *  sidebar's terminal rows speak: needs you is an amber dot whose OPACITY
 *  pulses (an HTML element, perf rule 6), working is the shared Spinner,
 *  idle is nothing at all, exited a muted ring. Decorative (`aria-hidden`):
 *  every surface that shows one also says the state in words. The pulse
 *  lives in styles.css (`.rl-term-badge--needs`) and stops under reduced
 *  motion. */
export function TermStateBadge({
  state,
  size = 6,
}: {
  state: TermState;
  size?: number;
}) {
  const status = paneStatusOf(state);
  if (status === "idle") return null;
  if (status === "working") return <Spinner size={size + 2} style={{ color: "var(--color-ink-muted)" }} />;
  const box: CSSProperties = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: "50%",
    flexShrink: 0,
    boxSizing: "border-box",
  };
  if (status === "exited") {
    return <span aria-hidden className="rl-term-badge" data-status="exited" style={{ ...box, border: "1px solid var(--color-ink-muted)" }} />;
  }
  return <span aria-hidden className="rl-term-badge rl-term-badge--needs" data-status="needs" style={{ ...box, background: "var(--color-warning)" }} />;
}

/** "needs you", "your turn", ":5173" — the words a chip shows for a state.
 *  A server is named by its port, which is the thing you'd type into a
 *  browser; idle says nothing at all. */
export function termStateWords(state: TermState, port: number | null): string | null {
  if (state === "serving" && port !== null) return `:${port}`;
  if (state === "idle") return null;
  return TERM_STATE_LABEL[state];
}
