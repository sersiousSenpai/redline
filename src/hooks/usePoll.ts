// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, type DependencyList } from "react";
import { keepEqual } from "../lib/keepEqual";

export interface PollOptions<T> {
  /** Stop ticking while the window is hidden, and tick the moment it is
   *  shown again: nobody is looking, so there is nothing to keep honest, and
   *  what they see on return is fresh. */
  pauseWhenHidden?: boolean;
  /** Receives each tick's result. */
  onResult?: (value: T) => void;
  /** Drop a result equal (`keepEqual`) to the last one `onResult` received,
   *  so an unchanged read costs no render. The memory resets when `deps`
   *  change; send every other refresh through the returned function so the
   *  poll stays the state's one writer. */
  skipIfUnchanged?: boolean;
  /** Tick as the poll (re)starts rather than one period later. Default true. */
  leading?: boolean;
}

/** One poll, run the same way everywhere.
 *
 *  `fn` runs every `ms` (null stops the clock) and always as its latest
 *  render's closure, so a re-render never restarts the clock; `deps` do.
 *  Ticks never overlap: one that lands while the last is still out is
 *  dropped, so a slow subprocess never stacks a second behind it.
 *
 *  Returns a function that ticks now. Asked while a tick is out, it ticks
 *  again once that one lands, so a refresh never settles on a read that
 *  started before it. */
export function usePoll<T>(
  fn: () => T | Promise<T>,
  ms: number | null,
  {
    pauseWhenHidden = false,
    onResult,
    skipIfUnchanged = false,
    leading = true,
  }: PollOptions<T> = {},
  deps: DependencyList = [],
): () => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const nowRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let busy = false;
    let again = false;
    let last: { value: T } | null = null;
    const tick = async (queue: boolean) => {
      if (!alive) return;
      if (busy) {
        if (queue) again = true;
        return;
      }
      busy = true;
      try {
        const value = await fnRef.current();
        const unchanged =
          skipIfUnchanged && last && keepEqual(last.value, value) === last.value;
        if (alive && !unchanged) {
          last = { value };
          onResultRef.current?.(value);
        }
      } catch {
        // A failed tick keeps the last result; the next one tries again.
      }
      busy = false;
      if (again) {
        again = false;
        void tick(false);
      }
    };
    nowRef.current = () => void tick(true);

    const hidden = () =>
      pauseWhenHidden && document.visibilityState === "hidden";
    let timer: number | undefined;
    const arm = () => {
      window.clearInterval(timer);
      timer =
        ms === null || hidden()
          ? undefined
          : window.setInterval(() => void tick(false), ms);
    };
    const onVisibility = () => {
      if (ms !== null && !hidden()) void tick(false);
      arm();
    };
    if (leading && ms !== null && !hidden()) void tick(false);
    arm();
    if (pauseWhenHidden) {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // `deps` are the caller's restart keys, spread in as a dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, pauseWhenHidden, skipIfUnchanged, leading, ...deps]);

  return useCallback(() => nowRef.current(), []);
}
