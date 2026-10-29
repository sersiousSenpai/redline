// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// What a quit says (PTY helper plan §5). ⌘Q is Redline's own menu item
// (quit.rs): the page decides whether there is anything to ask. With
// terminals running and the question not turned off, it asks once: they
// keep running after Redline quits (Quit), or end with it (Quit and Stop
// Terminals). A plan held for review is always said, whatever "Don't ask
// again" says: its hook connection dies with Redline and its terminal asks
// in the terminal instead (docs/protocol-verification.md, experiment (o):
// the CLI falls back to its own approval prompt and builds nothing
// unanswered).

import type { LivePty } from "./terminalWorkspace";

export interface QuitSettings {
  helperActive: boolean;
  keepOnQuit: boolean;
  askOnQuit: boolean;
}

export interface QuitAsk {
  /** How many terminals keep running after the quit. */
  keeping: number;
  /** How many end with it (closed with "Also after Redline quits" off). */
  ending: number;
  /** The plans waiting for review, by name. */
  held: string[];
}

/** Null: quit at once, nothing to say. */
export function quitAsk(settings: QuitSettings, list: readonly LivePty[], held: readonly string[]): QuitAsk | null {
  if (!settings.helperActive || !settings.keepOnQuit) return null;
  const live = list.filter((p) => p.kept && p.alive);
  const keeping = live.filter((p) => p.persist !== false).length;
  const ending = live.length - keeping;
  const ask = settings.askOnQuit && keeping > 0;
  if (!ask && held.length === 0) return null;
  return { keeping, ending, held: [...held] };
}

export function quitTitle(a: QuitAsk): string {
  if (a.keeping === 0) return a.held.length === 1 ? "A plan is waiting for your review" : `${a.held.length} plans are waiting for your review`;
  return a.keeping === 1 ? "A terminal keeps running after Redline quits" : `${a.keeping} terminals keep running after Redline quits`;
}

export function heldLine(name: string): string {
  return `${name} is waiting for your review. If you quit, its terminal asks in the terminal instead.`;
}
