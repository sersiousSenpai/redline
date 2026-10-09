// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// When a loud terminal reaches you OUTSIDE the wall: a macOS notification per
// transition into needs-you or your-turn while you're away, and the Dock
// badge counting what still needs you. The frontend owns both because "seen"
// lives here (lib/termState) — the daemon only knows what the hooks said.
// Pure; `useAttentionAlerts` owns the timers and the plugin.

import { TERM_STATE_LABEL } from "./termState";

/** A terminal in a loud state, as an alert names it. */
export interface LoudTerminal {
  id: string;
  state: "needs-you" | "your-turn";
  /** The transition's `at` — one notification per terminal per transition. */
  at: number;
  /** "redline 2" — the needs-you message is the same generic sentence for
   *  every terminal (measured), so the label is what tells them apart. */
  label: string;
  text: string | null;
}

/** A your-turn waits this long before it notifies: its excerpt can land in a
 *  second event, and a user's own blocking Stop hook makes a brief your-turn
 *  the agent then continues past (both measured, experiment (l)). A needs-you
 *  has already waited ~7 s in the CLI before its hook fired, so it goes now. */
export const YOUR_TURN_NOTIFY_DELAY_MS = 2500;

export function transitionKey(t: Pick<LoudTerminal, "id" | "at">): string {
  return `${t.id}@${t.at}`;
}

/** The loud transitions not handled yet, in order. A transition is handled
 *  the first time it is seen, whether or not it notified: you were here when
 *  it happened, and leaving later doesn't make it news. */
export function newTransitions(
  loud: readonly LoudTerminal[],
  handled: ReadonlySet<string>,
): LoudTerminal[] {
  return loud.filter((t) => !handled.has(transitionKey(t)));
}

/** Drop the handled transitions that are no longer loud, in place. One that
 *  stopped being loud (read, answered, replaced, closed) never comes back
 *  with the same `at`, so only the loud ones can still be news — and the set
 *  stays the size of the wall rather than growing for the whole session. */
export function forgetQuieted(
  handled: Set<string>,
  loud: readonly LoudTerminal[],
): void {
  const live = new Set(loud.map(transitionKey));
  for (const key of handled) if (!live.has(key)) handled.delete(key);
}

/** "redline 2 · needs you" over the agent's own words. */
export function notificationFor(t: LoudTerminal): { title: string; body: string } {
  return {
    title: `${t.label} · ${TERM_STATE_LABEL[t.state]}`,
    body:
      t.text ??
      (t.state === "needs-you"
        ? "Its agent is waiting on you."
        : "Its agent finished its turn."),
  };
}
