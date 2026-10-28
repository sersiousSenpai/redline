// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "../types";
import { reduceRestore, type RestoreAttempt } from "./restoreAttempt";
import { createAutoResume, type AutoResumeDeps, type AutoStart } from "./autoResumeController";
import { noteTerminalClosed, noteTerminalInterrupted } from "./userStops";

// The controller against the real restore reducer and a fake clock: the
// guards as the reviewer would live them — a death, a resume, a failure, the
// wait, the give-up.

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: "s1",
  projectName: "p",
  projectPath: "/p",
  latestVersion: 1,
  revisions: [],
  createdAt: 0,
  updatedAt: 0,
  status: "in_review",
  pendingCount: 0,
  awaitingReview: false,
  held: false,
  attachState: "detached",
  backend: "claude-code",
  ...over,
});

let deps: { current: AutoResumeDeps };
let starts: string[];
let result: AutoStart;
const restore = (ev: Parameters<typeof reduceRestore>[1]) => {
  deps.current = { ...deps.current, restoreAttempt: reduceRestore(deps.current.restoreAttempt, ev) };
};

beforeEach(() => {
  vi.useFakeTimers();
  starts = [];
  result = "started";
  deps = {
    current: {
      summaries: [summary()],
      restoreAttempt: null,
      sessionTerminals: new Map([["s1", "t1"]]),
      isLegacy: () => false,
      start: async (sessionId) => {
        starts.push(sessionId);
        if (result === "started") restore({ type: "start", sessionId, at: Date.now() });
        return result;
      },
    },
  };
});
afterEach(() => vi.useRealTimers());

/** Let the start's promise settle and the controller see the new attempt. */
const settle = async (ctl: ReturnType<typeof createAutoResume>) => {
  await vi.advanceTimersByTimeAsync(0);
  ctl.sync();
};
const failNow = (ctl: ReturnType<typeof createAutoResume>) => {
  restore({ type: "fail", sessionId: "s1", error: "boom" });
  ctl.sync();
};

describe("the automatic resume, end to end", () => {
  it("starts at once, then after 10 s, then 30 s, then stops", async () => {
    const ctl = createAutoResume(deps);
    ctl.sync();
    ctl.detached("s1");
    await settle(ctl);
    expect(starts).toEqual(["s1"]);

    failNow(ctl);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle(ctl);
    expect(starts).toHaveLength(2);

    failNow(ctl);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await settle(ctl);
    expect(starts).toHaveLength(3);

    failNow(ctl);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(starts).toHaveLength(3); // never a loop
  });

  it("a session that comes back stops the wait; dying again spends from the same three", async () => {
    const ctl = createAutoResume(deps);
    ctl.sync();
    ctl.detached("s1");
    await settle(ctl);
    // The plan came back.
    restore({ type: "plan-received", restored: true });
    deps.current = { ...deps.current, summaries: [summary({ attachState: "held" })] };
    ctl.sync();
    // …and died again: the second try waits 10 s, not 0.
    deps.current = { ...deps.current, summaries: [summary()] };
    ctl.detached("s1");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(starts).toHaveLength(2);
  });

  it("never for a plan the reviewer approved, or a terminal they closed or interrupted", async () => {
    deps.current = { ...deps.current, summaries: [summary({ status: "approved" })] };
    const ctl = createAutoResume(deps);
    ctl.sync();
    ctl.detached("s1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts).toEqual([]);

    deps.current = { ...deps.current, summaries: [summary({ sessionId: "s2" })], sessionTerminals: new Map([["s2", "t-closed"]]) };
    noteTerminalClosed("t-closed");
    ctl.detached("s2");
    deps.current = { ...deps.current, summaries: [summary({ sessionId: "s3" })], sessionTerminals: new Map([["s3", "t-esc"]]) };
    noteTerminalInterrupted("t-esc", Date.now());
    ctl.detached("s3");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts).toEqual([]);
  });

  it("waits while another restore holds the one slot, then goes", async () => {
    deps.current = {
      ...deps.current,
      restoreAttempt: { sessionId: "other", terminalId: null, startedAt: 0, phase: "dispatching" } satisfies RestoreAttempt,
    };
    const ctl = createAutoResume(deps);
    ctl.sync();
    ctl.detached("s1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(starts).toEqual([]);
    restore({ type: "plan-received", restored: true });
    ctl.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual(["s1"]);
  });

  it("a click while it waits takes over: no automatic attempt behind it", async () => {
    const ctl = createAutoResume(deps);
    ctl.sync();
    ctl.detached("s1");
    await settle(ctl);
    failNow(ctl);
    // The reviewer clicks Retry now.
    restore({ type: "start", sessionId: "s1", at: Date.now() });
    ctl.sync();
    restore({ type: "fail", sessionId: "s1", error: "again" });
    ctl.sync();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts).toHaveLength(1);
  });

  it("a blocker stops it after one look", async () => {
    result = "blocked";
    const ctl = createAutoResume(deps);
    ctl.sync();
    ctl.detached("s1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts).toEqual(["s1"]);
  });
});
