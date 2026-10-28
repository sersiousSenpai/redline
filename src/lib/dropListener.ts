// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Ending a Tauri event subscription without the "listeners[eventId].handlerId"
// rejection. `listen()` resolves as soon as the daemon has queued the script
// that registers the listener in this webview — before that script has run.
// An unlisten in that gap (a component that mounts and unmounts in quick
// succession: a tab or session switch, a StrictMode double effect) finds no
// entry, throws inside the plugin's `_unlisten`, and never reaches the
// `plugin:event|unlisten` invoke after it — an unhandled rejection in the
// console, and a listener the daemon keeps firing. Trying again a frame later
// finds the entry and finishes the job.

type Unlisten = () => unknown;

/** Run `unlisten` until it goes through (a few short retries), never
 *  leaving a rejection behind. Safe to hand anything that ends a
 *  subscription; a second call of the same function is harmless. */
export function dropListener(unlisten: Unlisten): void {
  let tries = 0;
  const retry = () => {
    if (++tries < 5) setTimeout(attempt, 16 * tries);
  };
  // The first try is synchronous, as a plain call would be: whatever the
  // function stops doing at once, it stops on this tick.
  const attempt = () => {
    try {
      const done = unlisten();
      if (done && typeof (done as Promise<unknown>).then === "function") (done as Promise<unknown>).then(undefined, retry);
    } catch {
      retry();
    }
  };
  attempt();
}
