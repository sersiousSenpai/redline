// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** The subset of a session summary this module cares about. */
export interface HeldSummary {
  held: boolean;
  heldTerminalId?: string | null;
  /** First heading of the plan under review — what that terminal is working
   *  on, in the user's own words. */
  planTitle?: string | null;
  projectName?: string;
}

/** Every dock terminal that is currently holding a plan.
 *
 *  The backend pins each held POST to the terminal tab whose `claude` sent it,
 *  so "is this terminal intercepted?" is a per-tab question, not a global one.
 *  Collapsing it to a single boolean about the *focused* tab (what the app used
 *  to do) painted one strip across a split dock and made approving one pane's
 *  plan erase the indicator for the other pane, which was still held.
 *
 *  Plans intercepted from a terminal outside Redline carry no id and are
 *  deliberately absent — there is no tab to mark. */
export function heldTerminalIds(summaries: readonly HeldSummary[]): Set<string> {
  const ids = new Set<string>();
  for (const s of summaries) {
    if (s.held && s.heldTerminalId) ids.add(s.heldTerminalId);
  }
  return ids;
}

/** The same linkage, carrying the *name* of what each held terminal is stopped
 *  on — for surfaces that describe a terminal rather than just mark it (the tab
 *  bar's repo popover). A held plan with no `# heading` falls back to its
 *  project name; the terminal is still working on something namable.
 *
 *  Later summaries win: if two held sessions somehow claim one terminal, the
 *  fresher list position is the better guess. */
export function heldPlanByTerminal(
  summaries: readonly HeldSummary[],
): Map<string, string> {
  const byTerminal = new Map<string, string>();
  for (const s of summaries) {
    if (!s.held || !s.heldTerminalId) continue;
    const title = (s.planTitle ?? "").trim() || (s.projectName ?? "").trim();
    if (title) byTerminal.set(s.heldTerminalId, title);
  }
  return byTerminal;
}
