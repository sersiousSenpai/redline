// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// A restore in flight, as a state machine.
//
// This used to be a session id and a spinner word, which was enough while the
// reviewer watched the restore happen in a terminal Redline shoved in front of
// them. It isn't now: the resume runs in a BACKGROUND terminal, because a
// resumed session replays its earlier user turns and what is on that screen is
// Redline's own control traffic quoted back — valid history that reads as an
// accidental double-send. The detached banner became the only place the
// reviewer learns anything, so the attempt has to be able to say which terminal
// is running it and how it ended.
//
// Pure, with the clock injected — the `activeSurface.ts` / `terminalHandoff.ts`
// house pattern. Every rule that matters here is a rule about ORDER (a stale
// event arriving after the attempt moved on; a failure landing after success),
// and order is exactly what a reducer can be pinned on and a component cannot.

import type { RestorePrep } from "./restoreHarness";

export type RestorePhase =
  /** Resolving where to resume from, arming, opening the terminal. */
  | "dispatching"
  /** The command is in; the model is answering. */
  | "waiting"
  /** Over, badly, and still on screen. */
  | "failed";

export interface RestoreAttempt {
  sessionId: string;
  /** The background terminal running it — `null` until it exists. What
   *  "Show raw terminal" promotes into a tile, which is why it is carried
   *  rather than re-derived: opening a *second* terminal would resume the
   *  same conversation twice. */
  terminalId: string | null;
  startedAt: number;
  phase: RestorePhase;
  /** Why it failed, in the reviewer's words. `failed` only. */
  error?: string;
  /** What `prepare_restore` said about the transcript, so the banner can warn
   *  that this one comes back without the plan's history. */
  history?: RestorePrep["history"];
}

/** How long before an unanswered restore is declared dead.
 *
 *  Generous: the wait is a model turn against a full transcript, measured at
 *  4-6s per handshake step on a 1.7 MB one, and the reviewer can always wait
 *  longer than we can predict. */
export const RESTORE_TIMEOUT_MS = 120_000;

export type RestoreEvent =
  /** The reviewer clicked. */
  | { type: "start"; sessionId: string; at: number }
  /** The background terminal exists and the command has been handed to it. */
  | {
      type: "dispatched";
      sessionId: string;
      terminalId: string;
      history: RestorePrep["history"];
    }
  | { type: "fail"; sessionId: string; error: string }
  /** A plan arrived. `restored` is the daemon's own word for a
   *  re-presentation it rebound to a plan it was holding. */
  | { type: "plan-received"; restored: boolean }
  /** A summary refresh: what this session's `attachState` now says. */
  | { type: "attach-state"; sessionId: string; state: string | null }
  /** The deadline passed. */
  | { type: "timeout"; error: string };

/** Is `ev` about the attempt we are actually holding? Every session-scoped
 *  event is checked, because a restore of ANOTHER plan (or a stale callback
 *  from an attempt already retried) must not be able to move this one. */
const mine = (a: RestoreAttempt | null, sessionId: string): boolean =>
  !!a && a.sessionId === sessionId;

export function reduceRestore(
  state: RestoreAttempt | null,
  ev: RestoreEvent,
): RestoreAttempt | null {
  switch (ev.type) {
    case "start":
      // One at a time — the original reason, unchanged: every click resumes
      // the SAME conversation in ANOTHER terminal, and each of those lands its
      // own ExitPlanMode. On 08/26 three clicks 40 seconds apart put two
      // duplicate revisions on one plan and left three claudes racing to hold
      // it. A FAILED attempt is not in flight, so Retry comes through here.
      if (!canStartRestore(state)) return state;
      return {
        sessionId: ev.sessionId,
        terminalId: null,
        startedAt: ev.at,
        phase: "dispatching",
      };
    case "dispatched":
      if (!mine(state, ev.sessionId) || state!.phase === "failed") return state;
      return {
        ...state!,
        terminalId: ev.terminalId,
        history: ev.history,
        phase: "waiting",
      };
    case "fail":
      if (!mine(state, ev.sessionId)) return state;
      // Already failed → keep the FIRST reason. A handoff failure and its
      // watchdog can both fire; the earlier one is the one that explains.
      if (state!.phase === "failed") return state;
      return { ...state!, phase: "failed", error: ev.error };
    case "plan-received":
      // Completed off the EVENT, not off a session-id match. `restored` is set
      // only for a re-presentation the daemon rebound to a plan it was holding,
      // and there is at most one restore in flight, so the attempt closes even
      // when claude came back under a rekeyed live session id and the sentinel
      // is what tied the two together. A plan that is NOT a restore says
      // nothing about this attempt.
      if (!ev.restored || !state) return state;
      return null;
    case "attach-state":
      // The backstop for a summary refresh that beats the event: the session
      // is held again, so whatever we were waiting for has happened.
      if (!mine(state, ev.sessionId) || state!.phase === "failed") return state;
      if (!ev.state || ev.state === "detached") return state;
      return null;
    case "timeout":
      if (!state || state.phase === "failed") return state;
      return { ...state, phase: "failed", error: ev.error };
  }
}

/** May a click start a restore right now? A failed attempt is not in flight. */
export function canStartRestore(state: RestoreAttempt | null): boolean {
  return !state || state.phase === "failed";
}

/** Milliseconds left before this attempt should be declared dead, floored at
 *  zero. Measured from the CLICK, not from now: the summaries this is
 *  re-evaluated against change several times during a restore, and a timer
 *  restarted on each one would never fire. */
export function restoreDeadlineIn(
  state: RestoreAttempt,
  now: number,
): number {
  return Math.max(0, state.startedAt + RESTORE_TIMEOUT_MS - now);
}

/** What the banner for `activeId` should show. An attempt for another session
 *  is real and still running — it just isn't this pane's news. */
export function restoreView(
  state: RestoreAttempt | null,
  activeId: string | null,
): { attempt: RestoreAttempt | null; restoring: boolean; failure: RestoreAttempt | null } {
  const attempt = state && state.sessionId === activeId ? state : null;
  return {
    attempt,
    restoring: !!attempt && attempt.phase !== "failed",
    failure: attempt?.phase === "failed" ? attempt : null,
  };
}
