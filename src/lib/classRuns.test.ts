// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  outcomeLabel,
  outcomeTone,
  refusalReason,
  runHeadline,
  subjectLabel,
  undoState,
  type RunRow,
} from "./classRuns";

const base: RunRow = {
  id: 7,
  startedAt: 1_000,
  finishedAt: 2_200,
  status: "done",
  seqFrom: 1,
  seqTo: 40,
  summary: "filed 3, created 1",
  durationMs: 1200,
  items: 12,
  ops: 4,
  model: "claude-cli",
  outcome: "done",
  canaryBefore: null,
  canaryAfter: null,
  error: null,
  mode: "organize",
  llmCalls: 1,
  promptBytes: 8_000,
  tokensIn: null,
  tokensOut: null,
  wallMs: 1234,
  canaryJson: null,
};

describe("the run timeline's derivations", () => {
  it("an applied organize run with ops can be undone", () => {
    expect(undoState(base)).toEqual({ can: true });
  });

  it("an undone run, a running one, an undo run and an empty run cannot", () => {
    expect(undoState({ ...base, outcome: "reverted" }).why).toBe("already undone");
    expect(undoState({ ...base, outcome: "reverted_by_canary" }).why).toBe("already undone");
    expect(undoState({ ...base, outcome: null, status: "running" }).why).toBe("still running");
    expect(undoState({ ...base, mode: "revert" }).can).toBe(false);
    expect(undoState({ ...base, ops: 0 }).why).toBe("nothing to undo");
  });

  it("the horizon, when known, closes older runs by number", () => {
    expect(undoState(base, 7).why).toContain("horizon");
    expect(undoState(base, 6)).toEqual({ can: true });
    expect(undoState(base, null)).toEqual({ can: true });
  });

  it("the headline reads mode · ops · outcome · time", () => {
    expect(runHeadline(base)).toBe("Organize · 4 ops · applied · 1.2 s");
    expect(runHeadline({ ...base, ops: 1, wallMs: 40, outcome: "reverted" })).toBe("Organize · 1 op · undone · 40 ms");
    expect(runHeadline({ ...base, mode: null, ops: null, wallMs: null, durationMs: null })).toBe("Run · applied");
  });

  it("outcome tones: error warns, undone and running are muted, applied is ok", () => {
    expect(outcomeTone(base)).toBe("ok");
    expect(outcomeTone({ ...base, outcome: "error" })).toBe("warn");
    expect(outcomeTone({ ...base, outcome: "reverted" })).toBe("muted");
    expect(outcomeTone({ ...base, outcome: null, status: "running" })).toBe("muted");
    expect(outcomeLabel({ ...base, outcome: "reverted_by_canary" })).toBe("undone by the canary");
  });

  it("subjects render by kind", () => {
    expect(subjectLabel("seq:12")).toBe("#12");
    expect(subjectLabel("node:a:b")).toBe("class a:b");
    expect(subjectLabel("link:3")).toBe("link 3");
    expect(subjectLabel("weird")).toBe("weird");
  });

  it("a refusal shows the store's reason, not the error tag", () => {
    expect(refusalReason("rejected: revert run #9 first — it touched what run #7 touched")).toBe(
      "revert run #9 first — it touched what run #7 touched",
    );
    expect(refusalReason(new Error("store: database is locked"))).toBe("database is locked");
    expect(refusalReason("")).toBe("the store refused the undo");
  });
});
