// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  canStartRestore,
  reduceRestore,
  restoreDeadlineIn,
  restoreView,
  RESTORE_TIMEOUT_MS,
  type RestoreAttempt,
  type RestoreEvent,
} from "./restoreAttempt";

const T0 = 1_700_000_000_000;

/** Run a sequence from nothing, the way App does. */
const run = (...events: RestoreEvent[]): RestoreAttempt | null =>
  events.reduce<RestoreAttempt | null>(reduceRestore, null);

const started = (sessionId = "s1"): RestoreEvent => ({
  type: "start",
  sessionId,
  at: T0,
});
const dispatched = (
  sessionId = "s1",
  terminalId = "term-1",
): RestoreEvent => ({
  type: "dispatched",
  sessionId,
  terminalId,
  history: "available",
});

describe("one click, one restore", () => {
  it("starts an attempt in `dispatching`, with no terminal yet", () => {
    const a = run(started())!;
    expect(a.sessionId).toBe("s1");
    expect(a.phase).toBe("dispatching");
    expect(a.terminalId).toBeNull();
    expect(a.startedAt).toBe(T0);
  });

  it("ignores every click while one is in flight", () => {
    // Not a cosmetic guard. Each click resumes the SAME conversation in
    // ANOTHER terminal and each lands its own ExitPlanMode: on 08/26 three
    // clicks 40s apart put two duplicate revisions on one plan and left three
    // claudes racing to hold it.
    const a = run(
      started(),
      { type: "start", sessionId: "s1", at: T0 + 5_000 },
      dispatched(),
      { type: "start", sessionId: "s1", at: T0 + 9_000 },
    )!;
    // Still the first click.
    expect(a.startedAt).toBe(T0);
    expect(a.terminalId).toBe("term-1");
    expect(canStartRestore(a)).toBe(false);
  });

  it("refuses a click for a DIFFERENT plan while one is running", () => {
    // Two live restores means two resumed sessions racing to hold two plans.
    const a = run(started("s1"), { type: "start", sessionId: "s2", at: T0 + 1 })!;
    expect(a.sessionId).toBe("s1");
  });

  it("lets a failed attempt be retried", () => {
    const failed = run(started(), {
      type: "fail",
      sessionId: "s1",
      error: "nope",
    })!;
    expect(canStartRestore(failed)).toBe(true);
    const retried = reduceRestore(failed, {
      type: "start",
      sessionId: "s1",
      at: T0 + 60_000,
    })!;
    expect(retried.phase).toBe("dispatching");
    expect(retried.startedAt).toBe(T0 + 60_000); // a fresh deadline
    expect(retried.error).toBeUndefined();
  });
});

describe("the terminal it runs in", () => {
  it("records the terminal so `Show raw terminal` can promote that one", () => {
    // Carried, never re-derived: opening a second terminal would resume the
    // same conversation twice, which is the failure the one-at-a-time guard
    // exists to prevent.
    const a = run(started(), dispatched("s1", "term-7"))!;
    expect(a.terminalId).toBe("term-7");
    expect(a.phase).toBe("waiting");
    expect(a.history).toBe("available");
  });

  it("ignores a dispatch belonging to another attempt", () => {
    const a = run(started("s1"), dispatched("s2", "term-9"))!;
    expect(a.terminalId).toBeNull();
    expect(a.phase).toBe("dispatching");
  });

  it("never un-fails an attempt that already died", () => {
    const a = run(
      started(),
      { type: "fail", sessionId: "s1", error: "spawn timed out" },
      dispatched(),
    )!;
    expect(a.phase).toBe("failed");
    expect(a.error).toBe("spawn timed out");
  });
});

describe("completion", () => {
  it("closes on a restored plan even when the live session id was rekeyed", () => {
    // `claude --resume` can come back under a new id; the sentinel carries the
    // HELD plan's id and the daemon rebinds on that. The event's `restored`
    // flag is the only witness either way — matching on session id here would
    // strand the banner on a restore that actually landed.
    const a = run(started("s1"), dispatched(), {
      type: "plan-received",
      restored: true,
    });
    expect(a).toBeNull();
  });

  it("is not closed by an ordinary plan arriving", () => {
    const a = run(started(), dispatched(), {
      type: "plan-received",
      restored: false,
    })!;
    expect(a.phase).toBe("waiting");
  });

  it("closes on the summary backstop when the session is held again", () => {
    const a = run(started(), dispatched(), {
      type: "attach-state",
      sessionId: "s1",
      state: "held",
    });
    expect(a).toBeNull();
  });

  it("keeps waiting while the session is still detached or unknown", () => {
    for (const state of ["detached", null]) {
      const a = run(started(), dispatched(), {
        type: "attach-state",
        sessionId: "s1",
        state,
      })!;
      expect(a.phase).toBe("waiting");
    }
  });
});

describe("failure stays on screen and stays actionable", () => {
  it("expires into a visible failure, not back into the plain banner", () => {
    // Silently reverting is indistinguishable from never having clicked, which
    // is how one quietly-dead restore became three live claudes.
    const a = run(started(), dispatched(), {
      type: "timeout",
      error: "hasn't answered in two minutes",
    })!;
    expect(a.phase).toBe("failed");
    expect(a.error).toContain("two minutes");
    // …and still names its terminal, so the reviewer can go look.
    expect(a.terminalId).toBe("term-1");
  });

  it("keeps the FIRST reason when the watchdog follows a real failure", () => {
    const a = run(
      started(),
      { type: "fail", sessionId: "s1", error: "write refused" },
      { type: "timeout", error: "hasn't answered in two minutes" },
    )!;
    expect(a.error).toBe("write refused");
  });

  it("a stale failure from a retried attempt cannot re-kill it", () => {
    // The handoff's `.then` can resolve long after its attempt was abandoned.
    const retried = run(
      started(),
      { type: "fail", sessionId: "s1", error: "first" },
      { type: "start", sessionId: "s1", at: T0 + 60_000 },
      dispatched("s1", "term-2"),
    )!;
    expect(retried.phase).toBe("waiting");
  });

  it("times out relative to the click, not to the last re-render", () => {
    // `summaries` changes several times during a restore; a deadline measured
    // from "now" would restart on each one and never fire.
    const a = run(started(), dispatched())!;
    expect(restoreDeadlineIn(a, T0)).toBe(RESTORE_TIMEOUT_MS);
    expect(restoreDeadlineIn(a, T0 + 100_000)).toBe(RESTORE_TIMEOUT_MS - 100_000);
    expect(restoreDeadlineIn(a, T0 + RESTORE_TIMEOUT_MS + 5_000)).toBe(0);
  });
});

describe("what the active pane shows", () => {
  it("shows a restore only in the banner of the plan being restored", () => {
    const a = run(started("s1"), dispatched())!;
    expect(restoreView(a, "s1").restoring).toBe(true);
    const elsewhere = restoreView(a, "s2");
    expect(elsewhere.restoring).toBe(false);
    expect(elsewhere.attempt).toBeNull();
    expect(elsewhere.failure).toBeNull();
  });

  it("separates in-flight from failed", () => {
    const failed = run(started(), {
      type: "fail",
      sessionId: "s1",
      error: "x",
    })!;
    const v = restoreView(failed, "s1");
    expect(v.restoring).toBe(false);
    expect(v.failure?.error).toBe("x");
  });

  it("shows nothing when there is no attempt", () => {
    const v = restoreView(null, "s1");
    expect(v.restoring).toBe(false);
    expect(v.failure).toBeNull();
  });
});
