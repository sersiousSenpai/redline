// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// One place for "commit at most once per animation frame".
//
// Pointer events fire well above the display refresh rate (120Hz+ trackpads)
// and every commit costs a render or a forced layout, so each drag path in the
// app had grown its own hand-rolled copy of the same four lines. They are all
// this function.

export interface Coalesced<T extends unknown[]> {
  (...args: T): void;
  /** Drop a pending frame without running it. */
  cancel(): void;
  /** Run a pending frame right now (e.g. on pointerup, so the rest position is
   *  exact rather than one frame stale). No-op when nothing is pending. */
  flush(): void;
}

/** Wrap `fn` so calls within one frame collapse into a single trailing call
 *  with the LATEST arguments. The freshest value always wins — intermediate
 *  ones would only be overdrawn anyway. */
export function rafCoalesce<T extends unknown[]>(
  fn: (...args: T) => void,
): Coalesced<T> {
  let rafId = 0;
  let latest: T | null = null;

  const run = () => {
    rafId = 0;
    const args = latest;
    latest = null;
    if (args) fn(...args);
  };

  const call = ((...args: T) => {
    latest = args;
    if (!rafId) rafId = requestAnimationFrame(run);
  }) as Coalesced<T>;

  call.cancel = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    latest = null;
  };

  call.flush = () => {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    run();
  };

  return call;
}
