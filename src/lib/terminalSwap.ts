// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A wall swap's per-tile work, kept off the frame that paints the swap.
//
// Swapping which terminals a wall shows is a React commit of a few ms: the
// tab list never changes, so no xterm is built and no PTY reattached. What
// cost the time (spike W0.3, 14 tiles: ~775 ms keydown → paint) was each
// tile's reaction to the swap, all landing in that one frame: a column fit
// per tile whose width changed (xterm rewraps its whole scrollback, ~48 ms
// at 5000 lines) and every shown tile's drain + fit + repaint in a single
// requestAnimationFrame. This module is where that work waits and then runs:
//
// - `beginTerminalSwap()` opens a settle window that closes on the first
//   frame painted after the commit (a double rAF). Work deferred while it is
//   open waits for it to close, so the new wall paints first.
// - `deferTerminalWork(key, task)` queues work keyed by what it is for
//   ("fit:<id>", "show:<id>"): queueing the same key again replaces the
//   task, so a tile fits once per swap however many resizes it saw.
// - The queue drains across frames: each frame runs at least one task and
//   then keeps going only while a small budget lasts, so fourteen cheap tiles
//   finish in a frame and seven expensive reflows take seven.

/** Work per frame before the queue yields to the next one. The first task of
 *  a frame always runs, so an expensive one still makes progress. */
export const TERMINAL_WORK_BUDGET_MS = 6;

const queue = new Map<string, () => void>();
let frame = 0;
let settling = false;
let swapToken = 0;

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

function run(): void {
  frame = 0;
  if (settling) return; // the swap's paint restarts the drain
  const started = now();
  let ran = 0;
  for (const [key, task] of queue) {
    if (ran > 0 && now() - started >= TERMINAL_WORK_BUDGET_MS) break;
    queue.delete(key);
    ran += 1;
    try {
      task();
    } catch (err) {
      console.error("[redline] deferred terminal work failed:", err);
    }
  }
  if (queue.size > 0) schedule();
}

function schedule(): void {
  if (!frame && !settling) frame = requestAnimationFrame(run);
}

/** A wall is about to swap: hold deferred terminal work until the frame
 *  that shows the new wall has painted, then call `onPainted` (the
 *  `wb:terminal-swap` end) and start draining. A second swap before that
 *  paint supersedes the first; only the latest `onPainted` runs. */
export function beginTerminalSwap(onPainted?: () => void): void {
  const token = ++swapToken;
  settling = true;
  if (frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (token !== swapToken) return;
      settling = false;
      onPainted?.();
      run();
    });
  });
}

/** Whether a swap's settle window is open: a resize seen now belongs to the
 *  swap and should be deferred rather than reflowed on the spot. */
export function terminalSwapSettling(): boolean {
  return settling;
}

/** Queue `task` under `key` (replacing any task already queued under it);
 *  it runs on a later frame, after any open swap has painted. */
export function deferTerminalWork(key: string, task: () => void): void {
  queue.delete(key);
  queue.set(key, task);
  schedule();
}

/** Drop the task queued under `key`, if any. */
export function cancelTerminalWork(key: string): void {
  queue.delete(key);
}

/** How many tasks are waiting — tests and diagnostics. */
export function pendingTerminalWork(): number {
  return queue.size;
}

/** Reset — tests only. */
export function __resetTerminalSwapForTest(): void {
  queue.clear();
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  settling = false;
  swapToken += 1;
}
