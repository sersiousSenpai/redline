// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The workbench's interaction timings, as `performance.mark` /
// `performance.measure` pairs — the shell half of what `docs/perf-budget.md`
// calls the Performance targets (tab switch, session switch, ⌘T to caret,
// terminal swap). Like `lib/bootMarks.ts`: nothing but marks, guarded and
// infallible, free in a release build. This file is on the boot path, so it
// stays this small.

export type WorkbenchMeasure =
  /** Switching tabs: the click to the new tab's first paint. */
  | "wb:tab-switch"
  /** Selecting a session: the click to the stage showing it. */
  | "wb:session-switch"
  /** ⌘T: the key to the caret resting in the door's box. */
  | "wb:new-tab-caret"
  /** Re-pointing a tile or swapping a wall: the pick to the swap landing. */
  | "wb:terminal-swap";

const pending = new Map<WorkbenchMeasure, number>();
const last = new Map<WorkbenchMeasure, number>();

function perf(): Performance | null {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance : null;
}

/** Start timing `name`. A second begin before the end restarts it. */
export function beginMeasure(name: WorkbenchMeasure): void {
  const p = perf();
  if (!p) return;
  pending.set(name, p.now());
  try {
    p.mark?.(`${name}:start`);
  } catch {
    /* no User Timing API: the Map still times it */
  }
}

/** Finish timing `name` and record the measure. Returns the milliseconds,
 *  or null when nothing was begun (a no-op, never a throw). */
export function endMeasure(name: WorkbenchMeasure): number | null {
  const p = perf();
  const start = pending.get(name);
  if (!p || start === undefined) return null;
  pending.delete(name);
  const ms = p.now() - start;
  last.set(name, ms);
  try {
    p.mark?.(`${name}:end`);
    p.measure?.(name, `${name}:start`, `${name}:end`);
  } catch {
    /* a missing start mark is the only realistic throw */
  }
  return ms;
}

/** Forget a begun measure (the switch was abandoned). */
export function cancelMeasure(name: WorkbenchMeasure): void {
  pending.delete(name);
}

/** The most recent duration for `name`, in milliseconds, or null. */
export function lastMeasure(name: WorkbenchMeasure): number | null {
  return last.get(name) ?? null;
}

/** Reset — tests only. */
export function resetMeasuresForTest(): void {
  pending.clear();
  last.clear();
}
