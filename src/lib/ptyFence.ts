// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The per-terminal PTY op fence. Spawn, kill and resize for one tab id are
// chained through a single promise tail so lifecycle ops can never interleave
// (a close racing a still-queued spawn used to orphan a shell). Pure module —
// no xterm, no Tauri — so the ordering contract is unit-testable.
//
// Why WRITES must ride the fence too (the dev-mode lost-keystroke bug): under
// React StrictMode a fresh terminal mounts twice, queueing [spawn₁, kill₁,
// spawn₂] here. The verified handoff's spawn signal resolves on spawn₁, and an
// UNFENCED write then races kill₁ — when it wins, the backend truthfully
// reports the write delivered into pty₁, which kill₁ destroys a beat later;
// the user watches pty₂ come up empty. A delivery that "succeeded" with no
// evidence on screen. Fenced, the write serializes behind the churn and lands
// in the surviving shell; in production (no double-mount) the fence is empty
// and this is a pass-through.

const ptyLifecycle = new Map<string, Promise<unknown>>();

/** Chain `op` behind every pending op for `id`. Fire-and-forget flavor: the
 *  returned promise never rejects (kills/resizes tolerate a dead target). */
export function enqueuePtyOp(
  id: string,
  op: () => Promise<unknown>,
): Promise<unknown> {
  const prev = ptyLifecycle.get(id) ?? Promise.resolve();
  const next = prev.then(op, op).catch(() => {});
  ptyLifecycle.set(id, next);
  // Prune the entry once this tail settles (identity-checked: a later op may
  // have chained past us) so closed terminals don't accumulate in the map.
  void next.finally(() => {
    if (ptyLifecycle.get(id) === next) ptyLifecycle.delete(id);
  });
  return next;
}

/** Chain `op` behind every pending op for `id`, PRESERVING its settlement —
 *  the caller sees the op's own result or rejection (a checked write must
 *  surface "terminal not running", never swallow it), while the fence itself
 *  absorbs the rejection and keeps accepting later ops. */
export function enqueuePtyOpChecked<T>(
  id: string,
  op: () => Promise<T>,
): Promise<T> {
  const prev = ptyLifecycle.get(id) ?? Promise.resolve();
  const run = prev.then(op, op);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  ptyLifecycle.set(id, tail);
  void tail.finally(() => {
    if (ptyLifecycle.get(id) === tail) ptyLifecycle.delete(id);
  });
  return run;
}
