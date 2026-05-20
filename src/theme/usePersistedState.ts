// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";

// Generic localStorage-backed state. Degrades to in-memory state if
// localStorage is unavailable (private mode / quota). Stored as JSON.
export function usePersistedState<T>(
  key: string,
  initial: T,
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

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore — state still works in-memory */
    }
  }, [key, value]);

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
