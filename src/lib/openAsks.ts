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
// shows it is the one that publishes it; unmounting withdraws it.

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
