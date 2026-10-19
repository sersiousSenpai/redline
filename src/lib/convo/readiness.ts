// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The composer's side of the PTY: whether a send can be typed into the CLI
//! now, what to say when it can't, and the local queue that holds sends
//! until it can. Pure — `SessionComposer` drives the flush.
//!
//! The host decides readiness (bound + bracketed paste on + no native dialog
//! + nothing half-typed in the raw TUI) and says so with `readiness` events;
//! `pty_submit` says it again per send. Until the host has spoken, a bound
//! terminal counts as ready: the send itself is the check, and a blocked one
//! lands in the queue rather than being lost.
//!
//! The queue only ever holds what could NOT be typed. While a reply runs the
//! CLI takes type-ahead itself (its own `queued` lines), so a ready composer
//! sends at once — unless older sends are still waiting, which go first.

import type { ConvoBlocker } from "./types";
import type { ReadinessFact } from "./reducer";

export type ComposerBlocker = ConvoBlocker | "no_terminal";

export interface ComposerReadiness {
  ready: boolean;
  blocker: ComposerBlocker | null;
  /** One line under the composer while it can't type; null when it can. */
  message: string | null;
  /** The terminal is where it gets cleared: offer "Open Terminal". */
  terminalFix: boolean;
}

export function composerReadiness(input: {
  terminalId: string | null;
  /** The mirror has seen a `bound` event. */
  bound: boolean;
  /** The host's last word on it (`readiness`), if any. */
  host: ReadinessFact | null;
  harness: "claude" | "codex";
}): ComposerReadiness {
  if (!input.terminalId) return blocked("no_terminal", input.harness);
  if (input.host) return input.host.ready ? READY : blocked(input.host.blocker ?? "unbound", input.harness);
  return input.bound ? READY : blocked("unbound", input.harness);
}

const READY: ComposerReadiness = { ready: true, blocker: null, message: null, terminalFix: false };

function blocked(blocker: ComposerBlocker, harness: "claude" | "codex"): ComposerReadiness {
  return { ready: false, blocker, message: blockerMessage(blocker, harness), terminalFix: blocker === "native_dialog" || blocker === "dirty_input" };
}

/** What the composer says while it holds sends back. */
export function blockerMessage(blocker: ComposerBlocker, harness: "claude" | "codex"): string {
  const cli = harness === "codex" ? "Codex" : "Claude";
  switch (blocker) {
    case "no_terminal":
      return "Not running in a terminal: restore the session to send. Messages wait here.";
    case "unbound":
      return `Waiting for ${cli} to start. Messages wait here.`;
    case "no_paste_mode":
      return `Waiting for ${cli}'s prompt. Messages wait here.`;
    case "native_dialog":
      return `${cli} is asking something in the terminal. Answer it there; messages wait here.`;
    case "dirty_input":
      return "There's unsent text in the terminal. Sending now would add to it, so messages wait here until it's cleared.";
  }
}

// ── The local queue ───────────────────────────────────────────────────────

export interface QueuedSend {
  id: string;
  text: string;
  at: number;
}

/** Send now, or join the queue: a composer that can't type queues, and so
 *  does one with older sends still waiting, so nothing overtakes them. */
export function routeSend(readiness: Pick<ComposerReadiness, "ready">, queue: readonly QueuedSend[]): "send" | "queue" {
  return readiness.ready && queue.length === 0 ? "send" : "queue";
}

export function enqueueSend(queue: readonly QueuedSend[], send: QueuedSend): QueuedSend[] {
  return queue.some((item) => item.id === send.id) ? [...queue] : [...queue, send];
}

/** × in the tray: out of the queue, its text back for the composer. */
export function unqueueSend(queue: readonly QueuedSend[], id: string): { queue: QueuedSend[]; text: string | null } {
  const item = queue.find((q) => q.id === id);
  return { queue: queue.filter((q) => q.id !== id), text: item?.text ?? null };
}

/** "↑ Next": to the front. */
export function promoteSend(queue: readonly QueuedSend[], id: string): QueuedSend[] {
  const item = queue.find((q) => q.id === id);
  return item ? [item, ...queue.filter((q) => q.id !== id)] : [...queue];
}

/** The send to type next, or null: one at a time, in order, only while
 *  ready. `held`: the PTY refused the last try, and the host hasn't said
 *  anything new about readiness since — the queue waits rather than
 *  retrying into the same wall. */
export function nextFlush(
  queue: readonly QueuedSend[],
  readiness: Pick<ComposerReadiness, "ready">,
  state: { inFlight: boolean; held: boolean },
): QueuedSend | null {
  if (!readiness.ready || state.inFlight || state.held || queue.length === 0) return null;
  return queue[0];
}

/** How long a refused queue waits for the host to speak before it tries
 *  again anyway: a host that never sends `readiness` must not strand it. */
export const HELD_RETRY_MS = 4_000;
