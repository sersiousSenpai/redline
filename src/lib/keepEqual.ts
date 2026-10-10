// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** `next`, holding on to `prev` wherever the two are equal.
 *
 *  Every IPC read and every observer callback hands back freshly built
 *  objects, so state set from one re-renders everything that reads it even
 *  when nothing changed, and every memoized child sees new props. This
 *  compares by value instead: when the whole of `next` equals `prev` it
 *  returns `prev` itself, so the `set` is a no-op React bails out of; when
 *  only part changed it returns a copy of `next` whose unchanged parts are
 *  still `prev`'s, so a session row, a revision or a comment that didn't
 *  change keeps its identity and its memo.
 *
 *  For JSON-shaped data (what `invoke` returns) plus Sets and Maps, whose
 *  members compare by identity. Arrays pair up by index; a caller whose list
 *  can reorder pairs its rows by id first. */
export function keepEqual<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (!prev || !next || typeof prev !== "object" || typeof next !== "object") {
    return next;
  }
  if (prev instanceof Set) {
    return next instanceof Set &&
      prev.size === next.size &&
      [...next].every((v) => prev.has(v))
      ? prev
      : next;
  }
  if (prev instanceof Map) {
    return next instanceof Map &&
      prev.size === next.size &&
      [...next].every(([k, v]) => prev.has(k) && Object.is(prev.get(k), v))
      ? prev
      : next;
  }
  const isArray = Array.isArray(prev);
  if (
    isArray !== Array.isArray(next) ||
    (!isArray &&
      (Object.getPrototypeOf(prev) !== Object.prototype ||
        Object.getPrototypeOf(next) !== Object.prototype))
  ) {
    return next;
  }
  const from = prev as Record<string, unknown>;
  const to = next as Record<string, unknown>;
  const keys = Object.keys(to);
  let same = keys.length === Object.keys(from).length;
  const out = (isArray ? [] : {}) as Record<string, unknown>;
  for (const k of keys) {
    const kept = keepEqual(from[k], to[k]);
    if (kept !== from[k] || !Object.prototype.hasOwnProperty.call(from, k)) {
      same = false;
    }
    out[k] = kept;
  }
  return (same ? prev : out) as T;
}

/** `keepEqual` for a list whose rows can move: each row of `next` is kept
 *  against the row of `prev` with the same key, wherever it sat. */
export function keepEqualRows<T>(
  prev: T[],
  next: T[],
  key: (row: T) => string,
): T[] {
  const byKey = new Map(prev.map((row) => [key(row), row]));
  let same = prev.length === next.length;
  const rows = next.map((row, i) => {
    const kept = keepEqual(byKey.get(key(row)) ?? row, row);
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? prev : rows;
}
