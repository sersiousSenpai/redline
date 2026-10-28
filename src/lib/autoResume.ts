// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// An interrupted plan session resumes itself.
//
// When the agent behind a plan in review dies — its process killed, its PTY
// gone, its held hook dropped — the daemon reconciles the session to
// Detached and says so (`session-detached`; the PTY-exit path asks it to,
// through `report_agent_exit`, which applies the same liveness gate the
// revise watchdog does). Before this, the reviewer then had to notice the
// banner and click Restore. Now the SAME restore (`restoreAttempt`, the one
// state machine, one restore in flight at a time) starts on its own, under
// two guards:
//
// - **Backoff.** The first try is immediate, the second 10 s after the first
//   failed, the third 30 s after that. Then it stops and the notice offers
//   Retry, the way a failed manual restore does. Never a loop.
// - **Loop guard.** At most three automatic restores per session per app
//   run, counted across interruptions: a session that comes back and dies
//   again spends from the same three, so a CLI that crashes on resume cannot
//   relaunch forever. The count is in memory on purpose — a relaunch of the
//   app is the reviewer's own fresh start.
//
// What never resumes on its own:
// - a plan the reviewer is done with (approved, closed, archived) — only
//   `in_review` is interrupted work;
// - a session the reviewer stopped themselves: they closed its terminal,
//   pressed Esc / Ctrl-C / Stop in it, or ended it at the keyboard (`exit`,
//   `/exit`, Ctrl-D) before it detached (an Esc on a held plan cancels the
//   plan — that is a decision, not a crash; see `userStops`);
// - a legacy row whose harness nobody has named (the banner asks; a guess
//   would resume a Codex thread with `claude --resume`, which silently
//   starts a fresh session);
// - an app restart's orphans: the startup sweep detaches them before any
//   window listens, so nothing here fires, and a boot never spawns agents.
//
// Non-plan terminal agents — a Claude or Codex shell the reviewer started
// themselves, with no plan row — are out of scope: there is no held review
// to re-present, and resuming a conversation they may have ended on purpose
// is theirs to do. Only plan sessions reach this (`session-detached` is a
// plan-session event).
//
// Pure, clock injected, like `restoreAttempt`: what matters is order (a
// failure landing after the reviewer clicked Retry; a reattach beating the
// timer), and order is what a reducer can be pinned on.

import type { RestoreAttempt } from "./restoreAttempt";
import type { AttachState, SessionStatus } from "../types";

/** Delay before automatic attempt N+1, indexed by attempts already made. */
export const AUTO_RESUME_DELAYS_MS = [0, 10_000, 30_000] as const;
/** Automatic attempts per session per app run (the loop guard). */
export const AUTO_RESUME_LIMIT = AUTO_RESUME_DELAYS_MS.length;
/** An interrupt or an exit this recent, in the session's terminal, means the
 *  reviewer stopped it. A held hook's drop lands within a second of the Esc,
 *  but a Ctrl-C mid-revision leaves no hook to drop: only the revise
 *  watchdog notices, on its next probe — every 90 s, quantized up by the
 *  keeper's 30 s tick. So two minutes and a half. */
export const USER_STOP_WINDOW_MS = 150_000;

export interface AutoResumeEntry {
  /** Automatic attempts made this app run. Never reset (the loop guard). */
  attempts: number;
  /** When the next automatic attempt is due; null when none is scheduled. */
  dueAt: number | null;
  /** The restore in flight was started by this, not by a click. */
  inFlight: boolean;
  /** It gave up (the guards ran out, or a blocker stands in the way): the
   *  reviewer is needed. */
  stopped: boolean;
}

export type AutoResumeState = Readonly<Record<string, AutoResumeEntry>>;

const FRESH: AutoResumeEntry = { attempts: 0, dueAt: null, inFlight: false, stopped: false };

/** What the reviewer's own hands did to terminals: closed some (ever, this
 *  run — terminal ids are never reused) and interrupted some (when). */
export interface UserStops {
  closed: ReadonlySet<string>;
  interrupted: ReadonlyMap<string, number>;
}

/** Did the reviewer stop the agent in any of `terminals` themselves? */
export function stoppedByUser(
  stops: UserStops,
  terminals: readonly (string | null | undefined)[],
  at: number,
): boolean {
  return terminals.some((id) => {
    if (!id) return false;
    if (stops.closed.has(id)) return true;
    const when = stops.interrupted.get(id);
    return when !== undefined && at - when <= USER_STOP_WINDOW_MS;
  });
}

/** What is known about a session the moment its agent was lost. */
export interface InterruptFacts {
  status: SessionStatus | null;
  archived: boolean;
  /** The reviewer closed or interrupted its terminal (`stoppedByUser`). */
  userStopped: boolean;
  /** A pre-backend row with no harness picked: restoring would guess. */
  legacy: boolean;
}

/** Is this interruption one to resume on its own? */
export function shouldAutoResume(f: InterruptFacts): boolean {
  return f.status === "in_review" && !f.archived && !f.userStopped && !f.legacy;
}

/** Does a session still want resuming? Only while it is in review, on a row
 *  that exists, and still detached — a reattach (a manual restore, the late
 *  plan the watchdog gave up on) or a decision ends it. */
export function stillInterrupted(
  s: { status: SessionStatus; attachState: AttachState; archivedAt?: number | null } | undefined,
): boolean {
  return !!s && s.status === "in_review" && !s.archivedAt && s.attachState === "detached";
}

export type AutoResumeEvent =
  /** The daemon detached it. */
  | { type: "interrupted"; sessionId: string; at: number; facts: InterruptFacts }
  /** The timer fired and an automatic attempt is being started. Counted
   *  here, before the restore runs, so its outcome is known to be ours. */
  | { type: "started"; sessionId: string }
  /** The attempt could not start yet (another restore holds the one slot,
   *  or a click got there first): uncount it and look again shortly. */
  | { type: "deferred"; sessionId: string; at: number }
  /** The attempt could not start at all: a blocker the reviewer must fix. */
  | { type: "blocked"; sessionId: string }
  /** The reviewer started a restore themselves. Theirs, not counted. */
  | { type: "manual"; sessionId: string }
  | { type: "failed"; sessionId: string; at: number }
  /** Restored, or no longer needs it (reattached, decided, archived). */
  | { type: "settled"; sessionId: string }
  /** The reviewer said stop (dismissed the notice, copied the command to
   *  run it themselves). */
  | { type: "cancel"; sessionId: string };

/** The deferral's pause: long enough for a click's restore to show up. */
export const DEFER_MS = 2_000;

function put(
  state: AutoResumeState,
  sessionId: string,
  entry: AutoResumeEntry,
): AutoResumeState {
  const prev = state[sessionId];
  if (
    prev &&
    prev.attempts === entry.attempts &&
    prev.dueAt === entry.dueAt &&
    prev.inFlight === entry.inFlight &&
    prev.stopped === entry.stopped
  )
    return state;
  return { ...state, [sessionId]: entry };
}

export function reduceAutoResume(
  state: AutoResumeState,
  ev: AutoResumeEvent,
): AutoResumeState {
  const e = state[ev.sessionId];
  switch (ev.type) {
    case "interrupted": {
      if (!shouldAutoResume(ev.facts)) return state;
      const cur = e ?? FRESH;
      // Already on it: a detach and the PTY's exit both report one death.
      if (cur.inFlight || cur.dueAt !== null) return state;
      // The loop guard: three this run, then the reviewer decides.
      if (cur.attempts >= AUTO_RESUME_LIMIT) return put(state, ev.sessionId, { ...cur, stopped: true });
      return put(state, ev.sessionId, {
        ...cur,
        dueAt: ev.at + AUTO_RESUME_DELAYS_MS[cur.attempts],
        stopped: false,
      });
    }
    case "started":
      if (!e || e.dueAt === null || e.inFlight) return state;
      return put(state, ev.sessionId, { ...e, attempts: e.attempts + 1, dueAt: null, inFlight: true });
    case "deferred":
      if (!e || !e.inFlight) return state;
      return put(state, ev.sessionId, { ...e, attempts: e.attempts - 1, inFlight: false, dueAt: ev.at + DEFER_MS });
    case "blocked":
      if (!e) return state;
      return put(state, ev.sessionId, { ...e, inFlight: false, dueAt: null, stopped: true });
    case "manual":
      if (!e) return state;
      return put(state, ev.sessionId, { ...e, inFlight: false, dueAt: null, stopped: false });
    case "failed": {
      // Only our own attempt's failure schedules the next: a failed click
      // stays the reviewer's (its notice already offers Retry).
      if (!e || !e.inFlight) return state;
      if (e.attempts >= AUTO_RESUME_LIMIT)
        return put(state, ev.sessionId, { ...e, inFlight: false, stopped: true });
      return put(state, ev.sessionId, {
        ...e,
        inFlight: false,
        dueAt: ev.at + AUTO_RESUME_DELAYS_MS[e.attempts],
      });
    }
    case "settled":
      if (!e) return state;
      return put(state, ev.sessionId, { ...e, inFlight: false, dueAt: null, stopped: false });
    case "cancel":
      if (!e) return state;
      // An attempt already running finishes as the reviewer's would: its
      // failure no longer schedules another.
      return put(state, ev.sessionId, { ...e, inFlight: false, dueAt: null, stopped: false });
  }
}

/** The earliest automatic attempt due, and how long until it is. */
export function nextDue(
  state: AutoResumeState,
  now: number,
): { sessionId: string; inMs: number } | null {
  let best: { sessionId: string; dueAt: number } | null = null;
  for (const [sessionId, e] of Object.entries(state)) {
    if (e.dueAt === null || e.inFlight) continue;
    if (!best || e.dueAt < best.dueAt) best = { sessionId, dueAt: e.dueAt };
  }
  return best ? { sessionId: best.sessionId, inMs: Math.max(0, best.dueAt - now) } : null;
}

/** What one step of the restore state machine meant: an attempt began, or
 *  one ended. Read off consecutive records, because the machine holds one
 *  attempt at a time and every transition of interest is a change of it. */
export function restoreOutcome(
  prev: RestoreAttempt | null,
  next: RestoreAttempt | null,
): { sessionId: string; kind: "started" | "failed" | "succeeded" } | null {
  if (prev === next) return null;
  const prevLive = !!prev && prev.phase !== "failed";
  if (prevLive) {
    if (!next) return { sessionId: prev!.sessionId, kind: "succeeded" };
    if (next.sessionId === prev!.sessionId && next.phase === "failed")
      return { sessionId: prev!.sessionId, kind: "failed" };
    return null;
  }
  // From nothing, or from a failure (Retry), to a new attempt.
  if (next && next.phase === "dispatching")
    return { sessionId: next.sessionId, kind: "started" };
  return null;
}

// ── The one status vocabulary ────────────────────────────────────────────

/** A session's resume, as a row, a tab dot and the Agent pane's header say
 *  it: `working` (the shared Spinner) while a restore runs or is about to,
 *  `needs` (the amber pulse) once it failed and is waiting on the reviewer.
 *  Nothing when there is nothing to say. Never red. */
export interface ResumePill {
  tone: "working" | "needs";
  label: string;
  /** "attempt 2 of 3" for an automatic one; absent for a click's. */
  attempt?: number;
  of?: number;
}

export function resumePill(
  entry: AutoResumeEntry | undefined,
  attempt: RestoreAttempt | null,
  sessionId: string,
): ResumePill | null {
  const mine = attempt && attempt.sessionId === sessionId ? attempt : null;
  const auto = entry && (entry.inFlight || entry.dueAt !== null);
  if ((mine && mine.phase !== "failed") || auto) {
    const n = entry ? (entry.inFlight ? entry.attempts : entry.dueAt !== null ? entry.attempts + 1 : 0) : 0;
    return n > 0
      ? { tone: "working", label: "Resuming…", attempt: n, of: AUTO_RESUME_LIMIT }
      : { tone: "working", label: "Resuming…" };
  }
  if (entry?.stopped || mine?.phase === "failed") return { tone: "needs", label: "Couldn't resume" };
  return null;
}

/** Same words, same tone. */
export function samePill(a: ResumePill | null | undefined, b: ResumePill | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.tone === b.tone && a.label === b.label && a.attempt === b.attempt && a.of === b.of;
}

/** The pill as words, for a title or a screen reader (the pill spells the
 *  same thing inline, to keep this module off the boot path). */
export function resumePillText(p: ResumePill): string {
  return p.attempt ? `${p.label} attempt ${p.attempt} of ${p.of}` : p.label;
}

/** `next`, keeping `prev`'s object for every entry `same` says is
 *  unchanged; `prev` itself when nothing changed at all — so a republish
 *  that moves nothing re-renders nothing. */
export function mergeStable<T>(
  prev: ReadonlyMap<string, T>,
  next: ReadonlyMap<string, T>,
  same: (a: T, b: T) => boolean,
): ReadonlyMap<string, T> {
  let changed = next.size !== prev.size;
  const out = new Map<string, T>();
  for (const [id, v] of next) {
    const old = prev.get(id);
    if (old !== undefined && same(old, v)) out.set(id, old);
    else {
      out.set(id, v);
      changed = true;
    }
  }
  return changed ? out : prev;
}

export const sameNotice = (a: AutoNotice, b: AutoNotice): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Every session's pill. */
export function resumePills(
  state: AutoResumeState,
  attempt: RestoreAttempt | null,
): ReadonlyMap<string, ResumePill> {
  const out = new Map<string, ResumePill>();
  const ids = new Set(Object.keys(state));
  if (attempt) ids.add(attempt.sessionId);
  for (const id of ids) {
    const p = resumePill(state[id], attempt, id);
    if (p) out.set(id, p);
  }
  return out;
}

/** What the Detached notice says about an automatic resume, or null when
 *  none is running for this session (a click's restore keeps its own
 *  "Reopening this plan…", and a give-up its failure with Retry). */
export type AutoNotice =
  | { phase: "resuming"; attempt: number; of: number }
  | { phase: "scheduled"; attempt: number; of: number; inSeconds: number }
  | { phase: "stopped"; attempts: number };

export function autoNotice(entry: AutoResumeEntry | undefined): AutoNotice | null {
  if (!entry) return null;
  if (entry.inFlight) return { phase: "resuming", attempt: entry.attempts, of: AUTO_RESUME_LIMIT };
  if (entry.dueAt !== null) {
    const delay = AUTO_RESUME_DELAYS_MS[entry.attempts] ?? 0;
    return delay > 0
      ? { phase: "scheduled", attempt: entry.attempts + 1, of: AUTO_RESUME_LIMIT, inSeconds: delay / 1000 }
      : { phase: "resuming", attempt: entry.attempts + 1, of: AUTO_RESUME_LIMIT };
  }
  if (entry.stopped && entry.attempts > 0) return { phase: "stopped", attempts: entry.attempts };
  return null;
}
