// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The reviewer's own hands on a terminal, for `autoResume`: a session whose
// agent the reviewer stopped (closed its terminal; Esc, Ctrl-C or Stop in it)
// detaches like a crashed one, and must not come back on its own.
//
// Module state, written where those gestures happen (TerminalTabs' close and
// interrupt, the Agent pane's Stop) and read when a detach arrives. Terminal
// ids are never reused within a run, so a close is remembered for the run.

import type { UserStops } from "./autoResume";

const closed = new Set<string>();
const interrupted = new Map<string, number>();

export function noteTerminalClosed(terminalId: string): void {
  closed.add(terminalId);
}

export function noteTerminalInterrupted(terminalId: string, at = Date.now()): void {
  interrupted.set(terminalId, at);
}

export function userStops(): UserStops {
  return { closed, interrupted };
}
