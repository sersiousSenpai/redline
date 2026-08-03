// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// State machine for the read-view → editor swap in the folder viewer. The
// editor only mounts *prepared* (chunk imported, text read, grammar resolved),
// so the view→edit transition is a single commit with no blank or uncolored
// frame. Pure so the race rules — stale resolves, path switches mid-prepare —
// are unit-testable without React.

export type EditSwapState<P> =
  | { mode: "view"; error: string | null }
  | { mode: "preparing"; seq: number }
  | { mode: "editing"; payload: P };

export type EditSwapEvent<P> =
  | { type: "edit"; seq: number }
  | { type: "prepared"; seq: number; payload: P }
  | { type: "prepare-failed"; seq: number; error: string }
  | { type: "path-changed" }
  | { type: "done" };

export const initialEditSwap: EditSwapState<never> = { mode: "view", error: null };

/** Advance the swap. `prepared`/`prepare-failed` land only while still
 *  preparing *that* attempt (seq match) — a resolve that arrives after the
 *  user switched files or re-entered view mode is dropped on the floor. */
export function reduceEditSwap<P>(
  s: EditSwapState<P>,
  e: EditSwapEvent<P>,
): EditSwapState<P> {
  switch (e.type) {
    case "edit":
      return s.mode === "view" ? { mode: "preparing", seq: e.seq } : s;
    case "prepared":
      return s.mode === "preparing" && s.seq === e.seq
        ? { mode: "editing", payload: e.payload }
        : s;
    case "prepare-failed":
      return s.mode === "preparing" && s.seq === e.seq
        ? { mode: "view", error: e.error }
        : s;
    case "path-changed":
      return { mode: "view", error: null };
    case "done":
      return { mode: "view", error: null };
  }
}
