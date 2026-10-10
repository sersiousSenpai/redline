// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useMemo, useRef } from "react";
import { keepEqual } from "../lib/keepEqual";

// Props that keep their identity across unrelated renders. A memoized child
// (`React.memo`) only skips a render when every prop compares equal by
// reference, and the shell re-renders constantly — a focus flip, a layout
// tweak, ~60×/s during a divider drag. One inline closure or one freshly
// derived Set and the memo is dead weight.

/** Identity-stable wrappers around the latest handlers, for a memoized child.
 *
 *  Each wrapper calls through a ref that always holds the newest render's
 *  handler, so the wrappers never change and never go stale. The keys are
 *  read once: pass the same keys every render, and keep a handler whose
 *  ABSENCE means something (an optional "show this button" callback) out of
 *  here. */
export function useStableHandlers<
  T extends Record<string, (...args: never[]) => unknown>,
>(handlers: T): T {
  const ref = useRef(handlers);
  ref.current = handlers;
  return useMemo(() => {
    const stable: Record<string, unknown> = {};
    for (const key of Object.keys(ref.current)) {
      stable[key] = (...args: never[]) => ref.current[key](...args);
    }
    return stable as T;
  }, []);
}

/** `value`, or the previous render's value when the two are equal
 *  (`keepEqual`) — for a prop derived afresh on every change of a wider
 *  input, like the held-terminal set re-derived from every summaries read. */
export function useStableValue<T>(value: T): T {
  const ref = useRef(value);
  ref.current = keepEqual(ref.current, value);
  return ref.current;
}
