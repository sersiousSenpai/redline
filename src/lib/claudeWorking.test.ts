// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { isClaudeWorking } from "./claudeWorking";

const base = {
  awaitingNextPlan: false,
  held: true,
  detached: false,
  sessionStatus: "in_review" as const,
  submittedCount: 0,
  pendingCount: 0,
};

describe("isClaudeWorking", () => {
  it("is off while the reviewer drafts comments on a held plan", () => {
    expect(isClaudeWorking({ ...base, pendingCount: 2 })).toBe(false);
  });

  it("turns on at submit via the explicit lock, before statuses refresh", () => {
    expect(isClaudeWorking({ ...base, awaitingNextPlan: true })).toBe(true);
  });

  it("stays on across the revision window (submitted, not held)", () => {
    expect(
      isClaudeWorking({ ...base, held: false, submittedCount: 3 }),
    ).toBe(true);
  });

  it("turns off the moment the revised plan arrives (held again), even if some comments are stuck at submitted", () => {
    // Resolution mismatch / parse error leaves comments at "submitted" after
    // the plan is back — the warning banner owns that, not the indicator.
    expect(
      isClaudeWorking({ ...base, held: true, submittedCount: 3 }),
    ).toBe(false);
  });

  it("is off when the session detached — Claude is gone, the detach banner owns it", () => {
    expect(
      isClaudeWorking({
        ...base,
        held: false,
        detached: true,
        submittedCount: 3,
      }),
    ).toBe(false);
  });

  it("is off after approval regardless of leftover submitted comments", () => {
    expect(
      isClaudeWorking({
        ...base,
        held: false,
        sessionStatus: "approved",
        submittedCount: 1,
      }),
    ).toBe(false);
  });

  it("is off with no session loaded", () => {
    expect(
      isClaudeWorking({
        ...base,
        held: false,
        sessionStatus: undefined,
        submittedCount: 1,
      }),
    ).toBe(false);
  });

  it("is off when new drafts exist alongside submitted comments (ball is back with the reviewer)", () => {
    expect(
      isClaudeWorking({
        ...base,
        held: false,
        submittedCount: 2,
        pendingCount: 1,
      }),
    ).toBe(false);
  });
});
