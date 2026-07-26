// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";

// Generic localStorage-backed state. Degrades to in-memory state if
// localStorage is unavailable (private mode / quota). Stored as JSON.
// `opts.debounceMs` batches the localStorage write behind a trailing debounce
// for high-frequency values (a divider drag commits per frame); absent, every
// value change writes synchronously exactly as before. A pending debounced
// write is flushed on unmount so the last value never drops.
export function usePersistedState<T>(
  key: string,
  initial: T,
  opts?: { debounceMs?: number },
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) return JSON.parse(raw) as T;
    } catch {
      /* fall through to initial */
    }
    return initial;
  });

  const valueRef = useRef(value);
  valueRef.current = value;

  const debounceMs = opts?.debounceMs;
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!debounceMs) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* ignore — state still works in-memory */
      }
      return;
    }
    pendingRef.current = true;
    const t = setTimeout(() => {
      pendingRef.current = false;
      try {
        localStorage.setItem(key, JSON.stringify(valueRef.current));
      } catch {
        /* ignore — state still works in-memory */
      }
    }, debounceMs);
    return () => clearTimeout(t);
  }, [key, value, debounceMs]);

  // Unmount flush: a debounced write still in flight lands before teardown.
  useEffect(() => {
    return () => {
      if (!pendingRef.current) return;
      pendingRef.current = false;
      try {
        localStorage.setItem(key, JSON.stringify(valueRef.current));
      } catch {
        /* ignore */
      }
    };
  }, [key]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) =>
        typeof next === "function"
          ? (next as (p: T) => T)(prev)
          : next,
      );
    },
    [],
  );

  return [value, set];
}
