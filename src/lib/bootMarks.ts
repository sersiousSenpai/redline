// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Frontend boot milestones — the shell half of the vocabulary whose native
// half lives in `src-tauri/src/boot_trace.rs`. Both are documented together in
// docs/perf-budget.md ("Boot budget").
//
// The whole module is `performance.mark` / `performance.measure` and nothing
// else: no state, no listeners, no storage, nothing to tear down. Every entry
// point is guarded and infallible — a jsdom test environment, an old WebView,
// or a `performance` object without the User Timing API must degrade to a
// no-op, never to a boot-time exception. Marks are *free* in a release build
// (the browser keeps a small ring buffer we never read unless asked), which is
// the point: instrumentation that only exists in a debug build is
// instrumentation nobody collects.
//
// Milestone names are a closed union so a rename is a type error rather than a
// silently-orphaned measurement.

export type BootMark =
  /** The entry module (`main.tsx`) started evaluating. The zero point. */
  | "rl:entry"
  /** React's first commit landed — a themed shell exists in the DOM. */
  | "rl:first-commit"
  /** The core bootstrap IPC (`bootstrap_state`) resolved. */
  | "rl:core-bootstrap"
  /** `show_main_window` was invoked… */
  | "rl:reveal-call"
  /** …and its IPC round-trip resolved. */
  | "rl:reveal-done"
  /** The first surface the user can actually act on is rendered. */
  | "rl:actionable"
  /** A held plan session finished loading (only fires when one exists). */
  | "rl:session-ready"
  /** The terminal dock is mounted with a live PTY. */
  | "rl:terminal-ready"
  /** The decorative doors-open run finished. Never gates anything. */
  | "rl:boot-settled"
  /** Post-reveal integration health (hooks, skills, binaries) resolved. */
  | "rl:integration-ready";

/** The zero point every `measure` below is relative to. */
const ORIGIN: BootMark = "rl:entry";

function perf(): Performance | null {
  return typeof performance !== "undefined" &&
    typeof performance.mark === "function"
    ? performance
    : null;
}

/** Marks fired so far this page, so `once` stays cheap and idempotent without
 *  round-tripping through `getEntriesByName`. */
const fired = new Set<BootMark>();

/** Record `name` at now. Safe to call anywhere, any number of times. */
export function mark(name: BootMark): void {
  const p = perf();
  if (!p) return;
  try {
    p.mark(name);
    // Every mark after the origin also gets a measure FROM the origin, which
    // is the number anyone actually reads in the devtools timeline — a bare
    // mark only tells you where, not how long.
    if (name !== ORIGIN && fired.has(ORIGIN)) {
      p.measure(`${name} (from entry)`, ORIGIN, name);
    }
  } catch {
    // A duplicate/absent start mark is the only realistic throw here, and it
    // is never worth a boot-time exception.
  }
  fired.add(name);
}

/** Record `name` only the first time. The right call for milestones reached
 *  from a React effect, which StrictMode double-invokes in development and a
 *  re-render can reach again. */
export function markOnce(name: BootMark): void {
  if (fired.has(name)) return;
  mark(name);
}

/** Milliseconds from the entry mark to `name`, or `null` if either is missing.
 *  Read by tests and by anyone poking at the timeline from the console. */
export function sinceEntry(name: BootMark): number | null {
  const p = perf();
  if (!p || typeof p.getEntriesByName !== "function") return null;
  const start = p.getEntriesByName(ORIGIN, "mark")[0];
  const end = p.getEntriesByName(name, "mark")[0];
  if (!start || !end) return null;
  return end.startTime - start.startTime;
}

/** The whole boot timeline as a plain object, newest measurement wins. Handy
 *  from the devtools console: `copy(bootTimeline())`. */
export function bootTimeline(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of fired) {
    const ms = sinceEntry(name);
    if (ms !== null) out[name] = Math.round(ms * 10) / 10;
  }
  return out;
}

/** Reset — tests only. The browser's own buffer is left alone; only this
 *  module's idempotence set is cleared. */
export function resetBootMarksForTest(): void {
  fired.clear();
}
