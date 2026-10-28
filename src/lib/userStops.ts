// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The reviewer's own hands on a terminal, for `autoResume`: a session whose
// agent the reviewer stopped detaches like a crashed one, and must not come
// back on its own. A stop is any of:
// - closing its terminal (remembered for the run: ids are never reused);
// - Esc, Ctrl-C or the Agent pane's Stop (an Esc on a held plan cancels it);
// - ending it at the keyboard: `exit`, `/exit`, `quit`, `logout` and Enter,
//   or Ctrl-D — plan agents run inside an interactive shell, so this is how
//   a PTY usually exits;
// - the PTY exiting just after the reviewer typed into it.
// An interrupt or an exit is remembered for `USER_STOP_WINDOW_MS` (in
// `autoResume`), long enough to cover the revise watchdog's 90 s probe and
// its 30 s tick: a Ctrl-C mid-revision is only noticed by that probe.
//
// Module state, written where those gestures happen (TerminalTabs' close,
// interrupt and input; the Agent pane's Stop) and read when a detach or a
// PTY exit arrives.

import type { UserStops } from "./autoResume";

const closed = new Set<string>();
const interrupted = new Map<string, number>();
const lastInput = new Map<string, number>();
const lines = new Map<string, string>();

/** A PTY exiting this soon after the reviewer typed into it is their doing. */
export const RECENT_INPUT_MS = 10_000;

/** A line that ends the session it is typed into, in the CLI or the shell. */
const EXIT_LINE = /^\s*\/?(exit|quit|logout)\s*$/;

/** Fold one chunk of typed input into the line being typed: the new line,
 *  and whether the chunk ended the session (an exit line's Enter, or ^D).
 *  Escape sequences (arrows, focus and mouse reports) are not text. */
export function foldInput(line: string, data: string): { line: string; stop: boolean } {
  if (data.startsWith("\x1b")) return { line, stop: false };
  let stop = false;
  for (const ch of data) {
    if (ch === "\x04") stop = true;
    else if (ch === "\r" || ch === "\n") {
      if (EXIT_LINE.test(line)) stop = true;
      line = "";
    } else if (ch === "\x7f" || ch === "\b") line = line.slice(0, -1);
    else if (ch === "\x03" || ch === "\x15") line = "";
    else if (ch >= " ") line += ch;
  }
  return { line: line.slice(-64), stop };
}

export function noteTerminalClosed(terminalId: string): void {
  closed.add(terminalId);
}

export function noteTerminalInterrupted(terminalId: string, at = Date.now()): void {
  interrupted.set(terminalId, at);
}

/** Every keystroke the reviewer sends a terminal. */
export function noteTerminalInput(terminalId: string, data: string, at = Date.now()): void {
  lastInput.set(terminalId, at);
  const { line, stop } = foldInput(lines.get(terminalId) ?? "", data);
  lines.set(terminalId, line);
  if (stop) interrupted.set(terminalId, at);
}

/** The PTY exited. True when that was the reviewer's doing — it was closed,
 *  ended at the keyboard, or exited just after they typed into it — which
 *  is then remembered like any other stop. */
export function noteTerminalExited(terminalId: string, at = Date.now()): boolean {
  if (closed.has(terminalId)) return true;
  const typed = lastInput.get(terminalId);
  if (typed !== undefined && at - typed <= RECENT_INPUT_MS) {
    interrupted.set(terminalId, at);
    return true;
  }
  const stop = interrupted.get(terminalId);
  return stop !== undefined && at - stop <= RECENT_INPUT_MS;
}

export function userStops(): UserStops {
  return { closed, interrupted };
}
