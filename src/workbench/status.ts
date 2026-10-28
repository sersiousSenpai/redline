// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// One status vocabulary for tabs, sidebar rows and tiles (the plan's
// Aesthetics): "needs you" is an amber opacity pulse on an HTML element,
// "working" is the shared `Spinner`, idle is nothing, exited is muted. Spelt
// once so the tab strip and the sidebar's nested terminal rows agree, and so
// a terminal's eight-way `TermState` folds to it in one place.

import type { TermState } from "../lib/termState";

export type PaneStatus = "needs" | "working" | "idle" | "exited";

/** A terminal's state in the shared vocabulary. Needs you is an agent
 *  blocked on you — a permission, a question, a dialog, a plan held for
 *  your review; a finished turn (your-turn) is not: the build is done and
 *  waits on nobody, so its row, its dot, the top bar's count and ⌘⇧J all
 *  let it go (the last walk's finished rows at NEEDS YOU under a "0 need
 *  you"). Running and serving are work. */
export function paneStatusOf(state: TermState | null | undefined): PaneStatus {
  switch (state) {
    case "needs-you":
    case "held":
      return "needs";
    case "working":
    case "running":
    case "serving":
      return "working";
    case "exited":
      return "exited";
    default:
      return "idle";
  }
}

/** The worst status of several: needs you outranks working, which outranks
 *  idle; exited never hides a live one. */
export function worstStatus(states: readonly PaneStatus[]): PaneStatus {
  if (states.includes("needs")) return "needs";
  if (states.includes("working")) return "working";
  if (states.length && states.every((s) => s === "exited")) return "exited";
  return "idle";
}

/** A wall's status, for its tab's dot: the worst of its tiles' (`states` is
 *  what TerminalTabs reports). An empty wall, or one not yet reported, says
 *  nothing. */
export function wallStatus(tiles: readonly string[], states: ReadonlyMap<string, { state: TermState }>): PaneStatus | undefined {
  const known = tiles.flatMap((id) => {
    const s = states.get(id);
    return s ? [paneStatusOf(s.state)] : [];
  });
  if (known.length === 0) return undefined;
  const worst = worstStatus(known);
  return worst === "idle" ? undefined : worst;
}

/** What a terminal's row or dot reads when the wall has not reported it
 *  yet: the CLI's own hooks (`term-attention`, seeded from the daemon's
 *  snapshot on every boot and reload) and the plans held on it. */
export interface TerminalStatusSources {
  /** The wall's derivation (`TerminalTabs.onStatesChange`): acks, the 10 s
   *  foreground check and the agent-at-its-prompt rule all applied. Wins. */
  states: ReadonlyMap<string, { state: TermState }>;
  /** The hooks' latest kind per terminal, until the wall has reported. */
  attention?: ReadonlyMap<string, string>;
  /** Terminals a held plan sits on: the agent is blocked on your review,
   *  whatever its last hook said (`working`, since its prompt). */
  held?: ReadonlySet<string>;
  /** The live PTY ids, once known; a terminal missing from them exited. */
  live?: readonly string[] | null;
}

/** One terminal's status, read the same way by the tab dots, the sidebar's
 *  rows and the footer: the wall's own derivation when it has one, else the
 *  hooks with a held plan read as needing you — never "working" for an agent
 *  sitting at its prompt over a plan you have not reviewed. */
export function terminalStatus(id: string, src: TerminalStatusSources): PaneStatus {
  if (src.live && !src.live.includes(id)) return "exited";
  const known = src.states.get(id);
  if (known) return paneStatusOf(known.state);
  if (src.held?.has(id)) return "needs";
  const kind = src.attention?.get(id);
  if (kind === "needs-you") return "needs";
  if (kind === "working") return "working";
  return "idle";
}

/** THE needs-you set: the terminals among `ids` whose status is "needs",
 *  each read by `terminalStatus` — the one value a row, a tab dot, the top
 *  bar's "N need you" and ⌘⇧J all read. A terminal gone from the live list
 *  is never in it. */
export function needsYouTerminals(ids: Iterable<string>, src: TerminalStatusSources): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (terminalStatus(id, src) === "needs") out.push(id);
  }
  return out;
}
