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

/** How long a heard detach waits for a summary that has caught up with it. */
export const HEARD_WAIT_MS = 3_000;

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

  // A `session-detached` is a FACT: the daemon persisted Detached before it
  // emitted. The summaries on hand when it arrives are older than it — App
  // only starts their refresh — and still say `held` (or `idle`, mid-
  // revision). So a heard detach is judged against the first summary that
  // has caught up: one saying `detached`; or, once HEARD_WAIT_MS has passed,
  // whatever a refresh since the event says (a reattach that fast is real);
  // or, when no refresh has landed at all, the event itself.
  const heard = new Map<string, { at: number; summaries: readonly SessionSummary[] }>();
  /** Detaches taken on the event's word: no refresh had landed. Until one
   *  does, the summary's stale attach state is not evidence. */
  const onEventsWord = new Set<string>();
  let summariesSeen = deps.current.summaries;

  /** Is the session still interrupted, by the best evidence there is? */
  const interruptedNow = (sessionId: string): boolean => {
    const s = find(sessionId);
    if (stillInterrupted(s)) return true;
    return onEventsWord.has(sessionId) && !!s && s.status === "in_review" && !s.archivedAt;
  };

  const judge = (sessionId: string, deadline: boolean) => {
    const h = heard.get(sessionId);
    if (!h) return;
    const s = find(sessionId);
    const refreshed = deps.current.summaries !== h.summaries;
    if (s?.attachState !== "detached") {
      if (!deadline) return; // wait for the refresh to catch up
      if (refreshed) {
        heard.delete(sessionId); // a refresh since the event says it is back
        return;
      }
      onEventsWord.add(sessionId);
    }
    heard.delete(sessionId);
    const { sessionTerminals, isLegacy } = deps.current;
    dispatch({
      type: "interrupted",
      sessionId,
      at: Date.now(),
      facts: {
        status: s?.status ?? null,
        archived: !!s?.archivedAt,
        // Judged at the moment the detach happened, not when we caught up.
        userStopped: stoppedByUser(userStops(), [sessionTerminals.get(sessionId), s?.heldTerminalId], h.at),
        legacy: s ? isLegacy(s) : false,
      },
    });
  };

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
    if (!interruptedNow(sessionId)) {
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
    // A refresh landed: the summaries are the evidence again.
    if (deps.current.summaries !== summariesSeen) {
      summariesSeen = deps.current.summaries;
      onEventsWord.clear();
      for (const sessionId of [...heard.keys()]) judge(sessionId, false);
    }
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
      if (!interruptedNow(sessionId)) dispatch({ type: "settled", sessionId });
    }
    if (stepped) {
      // A click's restore has a pill too, and the slot may have freed.
      publish();
      schedule();
    }
  };

  return {
    detached(sessionId) {
      if (!heard.has(sessionId)) heard.set(sessionId, { at: Date.now(), summaries: deps.current.summaries });
      judge(sessionId, false);
      window.setTimeout(() => judge(sessionId, true), HEARD_WAIT_MS);
    },
    sync,
    cancel(sessionId) {
      dispatch({ type: "cancel", sessionId });
    },
  };
}
