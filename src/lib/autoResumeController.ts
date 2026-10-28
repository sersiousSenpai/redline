// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The automatic resume's running part: the state, the one timer, and the
// restore machine read step by step. Loaded on the first death or the first
// restore (`useAutoResume` is all the boot path carries), so a session that
// never loses its agent never pays for it. The rules are `autoResume`'s.

import type { SessionSummary } from "../types";
import type { RestoreAttempt } from "./restoreAttempt";
import {
  autoNotice,
  mergeStable,
  nextDue,
  reduceAutoResume,
  restoreOutcome,
  resumePills,
  sameNotice,
  samePill,
  stillInterrupted,
  stoppedByUser,
  type AutoNotice,
  type AutoResumeEvent,
  type AutoResumeState,
} from "./autoResume";
import { userStops } from "./userStops";
import { setResume } from "../components/ResumePill";
import type { ResumePill } from "./autoResume";

export type AutoStart = "started" | "busy" | "blocked";

export interface AutoResumeDeps {
  summaries: readonly SessionSummary[];
  restoreAttempt: RestoreAttempt | null;
  /** session → the terminal its CLI runs in. */
  sessionTerminals: ReadonlyMap<string, string>;
  /** A legacy row nobody has named a harness for. */
  isLegacy: (s: SessionSummary) => boolean;
  /** Start a restore of `sessionId`, as a click would. */
  start: (sessionId: string) => Promise<AutoStart>;
}

export interface AutoResumeController {
  /** The daemon detached a plan session. */
  detached(sessionId: string): void;
  /** App re-rendered with new deps: the restore machine may have stepped,
   *  the summaries may say a wait is over. */
  sync(): void;
  cancel(sessionId: string): void;
}

export function createAutoResume(deps: { readonly current: AutoResumeDeps }): AutoResumeController {
  let state: AutoResumeState = {};
  // From nothing: the first `sync` reads whatever attempt is already on.
  let prevAttempt: RestoreAttempt | null = null;
  let timer: number | null = null;

  const find = (sessionId: string) => deps.current.summaries.find((x) => x.sessionId === sessionId);

  let pills: ReadonlyMap<string, ResumePill> = new Map();
  let notices: ReadonlyMap<string, AutoNotice> = new Map();
  const publish = () => {
    const nextNotices = new Map<string, AutoNotice>();
    for (const [id, e] of Object.entries(state)) {
      const n = autoNotice(e);
      if (n) nextNotices.set(id, n);
    }
    const p = mergeStable(pills, resumePills(state, deps.current.restoreAttempt), samePill);
    const n = mergeStable(notices, nextNotices, sameNotice);
    if (p === pills && n === notices) return;
    pills = p;
    notices = n;
    setResume(pills, notices);
  };

  const dispatch = (ev: AutoResumeEvent) => {
    const next = reduceAutoResume(state, ev);
    if (next === state) return;
    state = next;
    publish();
    schedule();
  };

  // One timer, for the earliest attempt due, and none while another restore
  // holds the one slot (`sync` reschedules when it lets go).
  const schedule = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    const a = deps.current.restoreAttempt;
    if (a && a.phase !== "failed") return;
    const due = nextDue(state, Date.now());
    if (!due) return;
    timer = window.setTimeout(() => {
      timer = null;
      fire(due.sessionId);
    }, due.inMs);
  };

  const fire = (sessionId: string) => {
    if (!stillInterrupted(find(sessionId))) {
      dispatch({ type: "settled", sessionId });
      return;
    }
    // Counted before the restore runs, so its steps are known to be ours.
    dispatch({ type: "started", sessionId });
    void deps.current
      .start(sessionId)
      .catch((): AutoStart => "blocked")
      .then((r) => {
        if (r === "busy") dispatch({ type: "deferred", sessionId, at: Date.now() });
        else if (r === "blocked") dispatch({ type: "blocked", sessionId });
      });
  };

  const sync = () => {
    const attempt = deps.current.restoreAttempt;
    const out = restoreOutcome(prevAttempt, attempt);
    const stepped = attempt !== prevAttempt;
    prevAttempt = attempt;
    if (out) {
      const mine = state[out.sessionId]?.inFlight ?? false;
      if (out.kind === "started" && !mine) dispatch({ type: "manual", sessionId: out.sessionId });
      else if (out.kind === "failed") dispatch({ type: "failed", sessionId: out.sessionId, at: Date.now() });
      else if (out.kind === "succeeded") dispatch({ type: "settled", sessionId: out.sessionId });
    }
    // A reattach or a decision ends a wait, whoever caused it.
    for (const [sessionId, e] of Object.entries(state)) {
      if (e.inFlight || (e.dueAt === null && !e.stopped)) continue;
      if (!stillInterrupted(find(sessionId))) dispatch({ type: "settled", sessionId });
    }
    if (stepped) {
      // A click's restore has a pill too, and the slot may have freed.
      publish();
      schedule();
    }
  };

  return {
    detached(sessionId) {
      const { sessionTerminals, isLegacy } = deps.current;
      const s = find(sessionId);
      const at = Date.now();
      dispatch({
        type: "interrupted",
        sessionId,
        at,
        facts: {
          status: s?.status ?? null,
          archived: !!s?.archivedAt,
          userStopped: stoppedByUser(userStops(), [sessionTerminals.get(sessionId), s?.heldTerminalId], at),
          legacy: s ? isLegacy(s) : false,
        },
      });
    },
    sync,
    cancel(sessionId) {
      dispatch({ type: "cancel", sessionId });
    },
  };
}
