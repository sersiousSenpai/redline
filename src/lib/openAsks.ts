// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Which terminals an Agent pane is holding a card open for: a permission or
// an AskUserQuestion the stage is asking you instead of the TUI. A held
// question fires no `Notification` hook (the TUI shows a spinner until the
// hook releases it), so the terminal's hooks still say "working" while the
// card waits on you — the re-walk's row at WORKING and top bar at "0 need
// you". The Agent pane publishes its open cards here and the one status
// derivation (`termState.deriveTermState`, via TerminalTabs) reads them, so
// a question counts as needing you everywhere a permission does: rows, tab
// dots, the top bar's count and ⌘⇧J.
//
// A card only exists while its conversation is subscribed (the daemon arms
// one for a bound, watched terminal; `convo::open_ask`), so the pane that
// shows it is the one that publishes it — and the CLI's own dialog it was
// released to as the pane went out of sight. Unmounting withdraws nothing:
// a question does not stop waiting because its pane closed. What ends it
// is what the terminal says next (`asksRetired`, run by TerminalTabs): a
// newer transition that is not itself a need, an answer typed into the
// terminal, the PTY exiting, or its agent leaving.

type Listener = () => void;

/** terminal id → when its oldest open card was first seen (ms). */
let asking: ReadonlyMap<string, number> = new Map();
const listeners = new Set<Listener>();

function publish(next: ReadonlyMap<string, number>): void {
  asking = next;
  for (const listener of Array.from(listeners)) listener();
}

/** Say whether `terminalId` has a card open. Idempotent: a repeat costs no
 *  render anywhere. */
export function setTerminalAsking(terminalId: string, open: boolean): void {
  if (!terminalId) return;
  const has = asking.has(terminalId);
  if (open === has) return;
  const next = new Map(asking);
  if (open) next.set(terminalId, Date.now());
  else next.delete(terminalId);
  publish(next);
}

export function getAskingTerminals(): ReadonlyMap<string, number> {
  return asking;
}

export function subscribeAskingTerminals(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The open asks a terminal's newer transitions retire: `attention` is the
 *  latest hook per terminal, `gone` the terminals whose PTY or agent has
 *  left. A newer needs-you keeps it (the TUI's own card notifying, 7 s
 *  after it appears); any other newer transition is the agent past it. */
export function asksRetired(
  open: ReadonlyMap<string, number>,
  attention: ReadonlyMap<string, { at: number; kind: string }>,
  gone: (terminalId: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const [id, since] of open) {
    const entry = attention.get(id);
    if (gone(id) || (entry && entry.at > since && entry.kind !== "needs-you")) out.push(id);
  }
  return out;
}
