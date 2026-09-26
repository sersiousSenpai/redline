// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The per-terminal PTY op fence. Spawn, attach, detach, kill and resize for one
// tab id are chained through a single promise tail so lifecycle ops never interleave
// (a close racing a still-queued spawn used to orphan a shell). Pure module —
// no xterm, no Tauri — so the ordering contract is unit-testable.
//
// Verified handoff writes use this fence too, so they follow any pending
// connection work. Previously StrictMode teardown killed and respawned the
// shell, letting an unfenced write land in the doomed process. Views now
// detach and reattach instead; explicit closes still kill, and ordering the
// handoff after queued lifecycle work remains necessary.

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
