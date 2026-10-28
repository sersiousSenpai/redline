// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  AUTO_RESUME_DELAYS_MS,
  AUTO_RESUME_LIMIT,
  DEFER_MS,
  USER_STOP_WINDOW_MS,
  autoNotice,
  nextDue,
  reduceAutoResume,
  restoreOutcome,
  resumePill,
  mergeStable,
  resumePills,
  resumePillText,
  samePill,
  shouldAutoResume,
  stillInterrupted,
  stoppedByUser,
  type AutoResumeEvent,
  type AutoResumeState,
  type InterruptFacts,
  type ResumePill,
} from "./autoResume";
import type { RestoreAttempt } from "./restoreAttempt";

const T0 = 1_700_000_000_000;
const S = "s1";

const facts = (over: Partial<InterruptFacts> = {}): InterruptFacts => ({
  status: "in_review",
  archived: false,
  userStopped: false,
  legacy: false,
  ...over,
});
const interrupted = (at = T0, over: Partial<InterruptFacts> = {}, sessionId = S): AutoResumeEvent => ({
  type: "interrupted",
  sessionId,
  at,
  facts: facts(over),
});
const run = (...events: AutoResumeEvent[]): AutoResumeState =>
  events.reduce<AutoResumeState>(reduceAutoResume, {});
const attempt = (phase: RestoreAttempt["phase"], sessionId = S): RestoreAttempt => ({
  sessionId,
  terminalId: phase === "dispatching" ? null : "t2",
  startedAt: T0,
  phase,
  ...(phase === "failed" ? { error: "boom" } : {}),
});

describe("what triggers an automatic resume", () => {
  it("a plan in review whose agent was lost, and nothing else", () => {
    expect(shouldAutoResume(facts())).toBe(true);
    // Approved or closed: the reviewer is done with it.
    expect(shouldAutoResume(facts({ status: "approved" }))).toBe(false);
    expect(shouldAutoResume(facts({ status: "aborted" }))).toBe(false);
    // A row we don't know.
    expect(shouldAutoResume(facts({ status: null }))).toBe(false);
    expect(shouldAutoResume(facts({ archived: true }))).toBe(false);
    // The reviewer stopped it themselves.
    expect(shouldAutoResume(facts({ userStopped: true }))).toBe(false);
    // A legacy row nobody named a harness for: a guess could resume a Codex
    // thread with `claude --resume`, which silently starts a fresh session.
    expect(shouldAutoResume(facts({ legacy: true }))).toBe(false);
  });

  it("an interruption that doesn't qualify records nothing", () => {
    expect(run(interrupted(T0, { status: "approved" }))).toEqual({});
    expect(run(interrupted(T0, { userStopped: true }))).toEqual({});
  });

  it("a closed terminal is the reviewer's doing, for the rest of the run", () => {
    const stops = { closed: new Set(["t1"]), interrupted: new Map<string, number>() };
    expect(stoppedByUser(stops, ["t1"], T0 + 3_600_000)).toBe(true);
    expect(stoppedByUser(stops, ["t9", null, undefined], T0)).toBe(false);
  });

  it("an Esc / Ctrl-C / Stop counts only just before the detach", () => {
    // An Esc on a held plan cancels it: the detach that follows is a decision.
    const stops = { closed: new Set<string>(), interrupted: new Map([["t1", T0]]) };
    expect(stoppedByUser(stops, ["t1"], T0 + 500)).toBe(true);
    expect(stoppedByUser(stops, ["t1"], T0 + USER_STOP_WINDOW_MS)).toBe(true);
    // Long after: a crash, not the interrupt.
    expect(stoppedByUser(stops, ["t1"], T0 + USER_STOP_WINDOW_MS + 1)).toBe(false);
    // Either the bound terminal or the held one may name it.
    expect(stoppedByUser(stops, [null, "t1"], T0 + 100)).toBe(true);
  });

  it("wants resuming only while still detached, in review, on a live row", () => {
    expect(stillInterrupted({ status: "in_review", attachState: "detached" })).toBe(true);
    expect(stillInterrupted({ status: "in_review", attachState: "held" })).toBe(false);
    expect(stillInterrupted({ status: "in_review", attachState: "idle" })).toBe(false);
    expect(stillInterrupted({ status: "approved", attachState: "detached" })).toBe(false);
    expect(stillInterrupted({ status: "in_review", attachState: "detached", archivedAt: 5 })).toBe(false);
    expect(stillInterrupted(undefined)).toBe(false);
  });
});

describe("the backoff: now, 10 s, 30 s, then stop", () => {
  it("is exactly three tries at 0, 10 and 30 seconds", () => {
    expect(AUTO_RESUME_DELAYS_MS).toEqual([0, 10_000, 30_000]);
    expect(AUTO_RESUME_LIMIT).toBe(3);
  });

  it("the first try is due at once", () => {
    const st = run(interrupted());
    expect(st[S]).toEqual({ attempts: 0, dueAt: T0, inFlight: false, stopped: false });
    expect(nextDue(st, T0)).toEqual({ sessionId: S, inMs: 0 });
  });

  it("each failure schedules the next, further out, and the third stops", () => {
    let st = run(interrupted(), { type: "started", sessionId: S });
    expect(st[S]).toMatchObject({ attempts: 1, inFlight: true, dueAt: null });
    expect(nextDue(st, T0)).toBeNull(); // nothing due while one runs

    st = reduceAutoResume(st, { type: "failed", sessionId: S, at: T0 + 1_000 });
    expect(st[S]).toMatchObject({ attempts: 1, inFlight: false, dueAt: T0 + 11_000 });
    expect(nextDue(st, T0 + 1_000)).toEqual({ sessionId: S, inMs: 10_000 });

    st = reduceAutoResume(st, { type: "started", sessionId: S });
    st = reduceAutoResume(st, { type: "failed", sessionId: S, at: T0 + 20_000 });
    expect(st[S]).toMatchObject({ attempts: 2, dueAt: T0 + 50_000 });

    st = reduceAutoResume(st, { type: "started", sessionId: S });
    st = reduceAutoResume(st, { type: "failed", sessionId: S, at: T0 + 60_000 });
    // Out of tries: nothing scheduled, the reviewer is needed. Never a loop.
    expect(st[S]).toEqual({ attempts: 3, dueAt: null, inFlight: false, stopped: true });
    expect(nextDue(st, T0 + 60_000)).toBeNull();
  });

  it("a click's failure schedules nothing: Retry is already on screen", () => {
    const st = run(interrupted(), { type: "manual", sessionId: S }, { type: "failed", sessionId: S, at: T0 + 5 });
    expect(st[S]).toMatchObject({ attempts: 0, dueAt: null, inFlight: false, stopped: false });
  });

  it("a detach and the PTY's exit for one death schedule one attempt", () => {
    const once = run(interrupted(T0));
    expect(reduceAutoResume(once, interrupted(T0 + 300))).toBe(once);
    const running = run(interrupted(T0), { type: "started", sessionId: S });
    expect(reduceAutoResume(running, interrupted(T0 + 300))).toBe(running);
  });

  it("a busy slot defers the attempt without spending it", () => {
    let st = run(interrupted(), { type: "started", sessionId: S });
    st = reduceAutoResume(st, { type: "deferred", sessionId: S, at: T0 + 100 });
    expect(st[S]).toMatchObject({ attempts: 0, inFlight: false, dueAt: T0 + 100 + DEFER_MS });
  });

  it("a blocker stops it at once: retrying cannot fix a missing CLI", () => {
    const st = run(interrupted(), { type: "started", sessionId: S }, { type: "blocked", sessionId: S });
    expect(st[S]).toMatchObject({ attempts: 1, inFlight: false, dueAt: null, stopped: true });
  });
});

describe("the loop guard: three per session per app run", () => {
  it("a session that comes back and dies again spends from the same three", () => {
    let st = run(interrupted(), { type: "started", sessionId: S }, { type: "settled", sessionId: S });
    expect(st[S]).toMatchObject({ attempts: 1, dueAt: null, inFlight: false });
    // Dies again: the count carries, so does the backoff.
    st = reduceAutoResume(st, interrupted(T0 + 100_000));
    expect(st[S]!.dueAt).toBe(T0 + 100_000 + AUTO_RESUME_DELAYS_MS[1]);
    st = reduceAutoResume(st, { type: "started", sessionId: S });
    st = reduceAutoResume(st, { type: "settled", sessionId: S });
    st = reduceAutoResume(st, interrupted(T0 + 200_000));
    st = reduceAutoResume(st, { type: "started", sessionId: S });
    st = reduceAutoResume(st, { type: "settled", sessionId: S });
    expect(st[S]!.attempts).toBe(3);
    // The fourth death: no attempt, the reviewer decides.
    st = reduceAutoResume(st, interrupted(T0 + 300_000));
    expect(st[S]).toEqual({ attempts: 3, dueAt: null, inFlight: false, stopped: true });
  });

  it("counts each session on its own", () => {
    const st = run(interrupted(T0, {}, "a"), { type: "started", sessionId: "a" }, interrupted(T0 + 5, {}, "b"));
    expect(st.a!.attempts).toBe(1);
    expect(st.b).toMatchObject({ attempts: 0, dueAt: T0 + 5 });
    expect(nextDue(st, T0 + 5)).toEqual({ sessionId: "b", inMs: 0 });
  });

  it("the reviewer taking over cancels what is scheduled", () => {
    let st = run(interrupted(), { type: "started", sessionId: S }, { type: "failed", sessionId: S, at: T0 });
    st = reduceAutoResume(st, { type: "cancel", sessionId: S });
    expect(st[S]).toMatchObject({ dueAt: null, inFlight: false, stopped: false });
    // …and a click is theirs, not counted.
    st = run(interrupted(), { type: "manual", sessionId: S });
    expect(st[S]).toMatchObject({ attempts: 0, dueAt: null });
  });

  it("a timer firing for a session nobody scheduled does nothing", () => {
    const st = run({ type: "started", sessionId: S });
    expect(st).toEqual({});
  });
});

describe("reading the restore machine's steps", () => {
  it("a start, from nothing or from a failure (Retry)", () => {
    expect(restoreOutcome(null, attempt("dispatching"))).toEqual({ sessionId: S, kind: "started" });
    expect(restoreOutcome(attempt("failed"), attempt("dispatching"))).toEqual({ sessionId: S, kind: "started" });
    expect(restoreOutcome(attempt("failed", "other"), attempt("dispatching"))).toEqual({ sessionId: S, kind: "started" });
  });

  it("an end: back to nothing is success, to failed is failure", () => {
    expect(restoreOutcome(attempt("waiting"), null)).toEqual({ sessionId: S, kind: "succeeded" });
    expect(restoreOutcome(attempt("dispatching"), null)).toEqual({ sessionId: S, kind: "succeeded" });
    expect(restoreOutcome(attempt("waiting"), attempt("failed"))).toEqual({ sessionId: S, kind: "failed" });
  });

  it("a step within one attempt, or no step, is nothing", () => {
    const a = attempt("waiting");
    expect(restoreOutcome(a, a)).toBeNull();
    expect(restoreOutcome(attempt("dispatching"), attempt("waiting"))).toBeNull();
    expect(restoreOutcome(null, null)).toBeNull();
  });
});

describe("the pill, in the one status vocabulary", () => {
  it("working (the Spinner) while an automatic resume runs, with its count", () => {
    const st = run(interrupted(), { type: "started", sessionId: S });
    const p = resumePill(st[S], attempt("waiting"), S)!;
    expect(p).toEqual({ tone: "working", label: "Resuming…", attempt: 1, of: 3 });
    expect(resumePillText(p)).toBe("Resuming… attempt 1 of 3");
  });

  it("working while it waits out the backoff, naming the next try", () => {
    const st = run(interrupted(), { type: "started", sessionId: S }, { type: "failed", sessionId: S, at: T0 });
    expect(resumePill(st[S], attempt("failed"), S)).toEqual({ tone: "working", label: "Resuming…", attempt: 2, of: 3 });
  });

  it("working, without a count, for a click's restore", () => {
    expect(resumePill(undefined, attempt("dispatching"), S)).toEqual({ tone: "working", label: "Resuming…" });
  });

  it("needs you (amber) once it failed with nothing scheduled", () => {
    const gaveUp = { attempts: 3, dueAt: null, inFlight: false, stopped: true };
    expect(resumePill(gaveUp, null, S)).toEqual({ tone: "needs", label: "Couldn't resume" });
    expect(resumePill(undefined, attempt("failed"), S)).toEqual({ tone: "needs", label: "Couldn't resume" });
  });

  it("nothing for a session with nothing to say, or another session's attempt", () => {
    expect(resumePill(undefined, null, S)).toBeNull();
    expect(resumePill(undefined, attempt("waiting", "other"), S)).toBeNull();
    expect(resumePill({ attempts: 1, dueAt: null, inFlight: false, stopped: false }, null, S)).toBeNull();
  });

  it("every session's pill at once, for the rows and the tab dots", () => {
    const st = run(interrupted(T0, {}, "a"), interrupted(T0, {}, "b"), { type: "cancel", sessionId: "b" });
    const pills = resumePills(st, attempt("failed", "c"));
    expect([...pills.keys()].sort()).toEqual(["a", "c"]);
    expect(pills.get("a")!.tone).toBe("working");
    expect(pills.get("c")!.tone).toBe("needs");
  });

  it("compares by value, so an unchanged pill keeps its identity", () => {
    expect(samePill({ tone: "working", label: "Resuming…", attempt: 1, of: 3 }, { tone: "working", label: "Resuming…", attempt: 1, of: 3 })).toBe(true);
    expect(samePill({ tone: "working", label: "Resuming…", attempt: 1, of: 3 }, { tone: "working", label: "Resuming…", attempt: 2, of: 3 })).toBe(false);
    expect(samePill(null, undefined)).toBe(false);
    expect(samePill(null, null)).toBe(true);
    const a: ResumePill = { tone: "working", label: "Resuming…" };
    const prev = new Map<string, ResumePill>([["s", a]]);
    expect(mergeStable(prev, new Map([["s", { ...a }]]), samePill)).toBe(prev);
    const moved = mergeStable(prev, new Map<string, ResumePill>([["s", a], ["t", { tone: "needs", label: "Couldn't resume" }]]), samePill);
    expect(moved).not.toBe(prev);
    expect(moved.get("s")).toBe(a);
  });
});

describe("what the Detached notice says", () => {
  it("resuming, attempt N of 3, while one runs or the first is due now", () => {
    expect(autoNotice(run(interrupted())[S])).toEqual({ phase: "resuming", attempt: 1, of: 3 });
    expect(autoNotice(run(interrupted(), { type: "started", sessionId: S })[S])).toEqual({ phase: "resuming", attempt: 1, of: 3 });
  });

  it("scheduled, with the wait, between tries", () => {
    const st = run(interrupted(), { type: "started", sessionId: S }, { type: "failed", sessionId: S, at: T0 });
    expect(autoNotice(st[S])).toEqual({ phase: "scheduled", attempt: 2, of: 3, inSeconds: 10 });
  });

  it("stopped once the tries ran out; nothing when the reviewer took over", () => {
    expect(autoNotice({ attempts: 3, dueAt: null, inFlight: false, stopped: true })).toEqual({ phase: "stopped", attempts: 3 });
    expect(autoNotice({ attempts: 1, dueAt: null, inFlight: false, stopped: false })).toBeNull();
    expect(autoNotice(undefined)).toBeNull();
  });
});
