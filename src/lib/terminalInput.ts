// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** xterm's public onData combines real input with automatic parser replies.
 *  Its core's user-input event fires synchronously immediately before onData
 *  for keys, paste and IME, but never for DSR/DA replies. Keep this one guarded
 *  compatibility seam here, covered against the installed xterm package. */
export function terminalInputOrigin(term: unknown, onUserInput: () => void) {
  const source = (term as {
    _core?: { coreService?: { onUserInput?: (fn: () => void) => { dispose(): void } } };
  })?._core?.coreService;
  let userInput = false;
  const subscription = typeof source?.onUserInput === "function"
    ? source.onUserInput(() => {
      userInput = true;
      onUserInput();
    })
    : null;
  return {
    /** Public DOM/key fallback if a future xterm release moves the seam.
     *  The current supported package uses its precise origin event. */
    noteGesture() {
      onUserInput();
      if (!subscription) {
        userInput = true;
        queueMicrotask(() => { userInput = false; });
      }
    },
    takeUserInput() {
      const result = userInput;
      userInput = false;
      return result;
    },
    dispose() { subscription?.dispose(); },
  };
}

/** Esc or Ctrl-C on its own — an interrupt. An agent stopped that way fires
 *  no hook at all, so the host has to notice it from the keystroke. (Arrow
 *  keys and Alt-chords also start with ESC, but never arrive as a bare one.) */
export function isInterruptInput(data: string): boolean {
  return data === "\x1b" || data === "\x03";
}

/** Input that answers what an agent asked: text typed or pasted, Enter, a
 *  number picking an option. Not an escape sequence — an arrow moving the
 *  highlight through a question's options, a mouse report from a click into
 *  the tile, a focus report — which leaves the question asked: counted as an
 *  answer, it put a terminal whose agent still waited on you back to
 *  "working" (and, persisted with the acks, kept it there across a reload). */
export function isAnswerInput(data: string): boolean {
  return data.length > 0 && !data.startsWith("\x1b");
}

/** The second guarded seam: xterm's renderer pauses itself while its
 *  IntersectionObserver calls the screen hidden, and only that observer
 *  resumes it. A wall shown again can drain and refit before the observer
 *  has reported, and a pause it never reports out of leaves the tile stale
 *  until something scrolls it. Called on a terminal whose host has a real
 *  size, this resumes a paused renderer the way the observer would (a full
 *  refresh included). A no-op when not paused, and if a future xterm moves
 *  the seam. */
export function resumeRendering(term: unknown): void {
  const render = (term as {
    _core?: { _renderService?: { _isPaused?: boolean; _handleIntersectionChange?: (entry: { isIntersecting: boolean; intersectionRatio: number }) => void } };
  })?._core?._renderService;
  if (render?._isPaused !== true || typeof render._handleIntersectionChange !== "function") return;
  render._handleIntersectionChange({ isIntersecting: true, intersectionRatio: 1 });
}
