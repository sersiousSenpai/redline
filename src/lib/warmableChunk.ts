// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/**
 * A lazy chunk that can be fetched ahead of its first render.
 *
 * `load` is the `React.lazy` loader; `warm()` starts the fetch early, from
 * whatever gesture predicts the first render (the comment composer opening
 * predicts the first comment card).
 *
 * A bare `import()` is not enough to warm a lazy component: `React.lazy` still
 * suspends its first render — a module promise settles a microtask late even
 * when the chunk is cached — and React then holds a suspended boundary's
 * reveal back by ~300 ms. So once the module is in hand, `load` gives React a
 * synchronous thenable instead, and the first render commits in the same
 * frame as the update that caused it.
 */
export function warmableChunk<T>(fetch: () => Promise<T>): {
  load: () => Promise<T>;
  warm: () => void;
} {
  let ready: { value: T } | null = null;
  let inflight: Promise<T> | null = null;
  const start = () =>
    (inflight ??= fetch().then(
      (value) => {
        ready = { value };
        return value;
      },
      (err: unknown) => {
        // A failed fetch must not be cached: the next render retries it.
        inflight = null;
        throw err;
      },
    ));
  return {
    load: () => {
      const loaded = ready;
      if (!loaded) return start();
      // React only calls `then`; it never awaits or chains the result.
      return {
        then: (resolve: (value: T) => unknown) => resolve(loaded.value),
      } as unknown as Promise<T>;
    },
    warm: () => {
      start().catch(() => {});
    },
  };
}
