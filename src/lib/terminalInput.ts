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
