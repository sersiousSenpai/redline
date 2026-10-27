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

/** A terminal's state in the shared vocabulary. A held plan and a your-turn
 *  are both the agent waiting on you; running and serving are work. */
export function paneStatusOf(state: TermState | null | undefined): PaneStatus {
  switch (state) {
    case "needs-you":
    case "your-turn":
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
