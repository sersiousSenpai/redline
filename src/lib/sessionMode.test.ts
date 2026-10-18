// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { launchTitle, modeColors, sessionMode, sessionTitle, type SessionModeInput } from "./sessionMode";

const v = (...ns: number[]) => ns.map((versionNumber) => ({ versionNumber, restored: false }));
const plan = (over: Partial<SessionModeInput> = {}): SessionModeInput => ({
  target: "plan",
  status: "in_review",
  held: false,
  revising: false,
  revisions: v(1),
  runState: null,
  cliMode: null,
  ...over,
});

describe("sessionMode: the truth table", () => {
  it("the New-session screen wears no chip", () => {
    expect(sessionMode({ target: "start" })).toBeNull();
    // Whatever else is lying around.
    expect(sessionMode({ target: "start", status: "approved", held: true, cliMode: "plan" })).toBeNull();
  });

  it("a chat is Chat", () => {
    expect(sessionMode({ target: "chat" })).toEqual({ kind: "chat", label: "Chat" });
  });

  it("a launch is Plan mode until the CLI says it left plan mode", () => {
    expect(sessionMode({ target: "launch" })).toEqual({ kind: "plan", label: "Plan mode" });
    expect(sessionMode({ target: "launch", cliMode: "plan" })?.label).toBe("Plan mode");
    expect(sessionMode({ target: "launch", cliMode: "default" })).toEqual({ kind: "chat", label: "Chat" });
    expect(sessionMode({ target: "launch", cliMode: "acceptEdits" })?.kind).toBe("chat");
  });

  it("a plan held for your review is Redlining", () => {
    expect(sessionMode(plan({ held: true }))).toEqual({ kind: "redline", label: "Redlining" });
    // Held outranks a CLI that still reports plan mode: the plan is back.
    expect(sessionMode(plan({ held: true, cliMode: "plan" }))?.kind).toBe("redline");
  });

  it("a plan being revised is Plan mode again", () => {
    expect(sessionMode(plan({ revising: true }))).toEqual({ kind: "plan", label: "Plan mode" });
    expect(sessionMode(plan({ cliMode: "plan" }))?.kind).toBe("plan");
  });

  it("a plan in review that nothing holds is still yours to redline", () => {
    expect(sessionMode(plan())?.label).toBe("Redlining");
    expect(sessionMode(plan({ cliMode: "default" }))?.label).toBe("Redlining");
  });

  it("an aborted plan names no mode", () => {
    expect(sessionMode(plan({ status: "aborted" }))).toBeNull();
  });

  it("an approved plan is in the build family, numbered by the approved version", () => {
    for (const runState of ["building", "orchestrating", "running", "in_code_review", "stalled"]) {
      expect(sessionMode(plan({ status: "approved", runState, revisions: v(1, 2, 3, 4) }))).toEqual({
        kind: "build",
        label: "Building v4",
        version: 4,
      });
    }
    expect(sessionMode(plan({ status: "approved", runState: "landed", revisions: v(1, 2) }))?.label).toBe("Built v2");
    expect(sessionMode(plan({ status: "approved", runState: null, revisions: v(1, 2, 3) }))?.label).toBe("Approved v3");
    // Approval wins over a hold or a revision flag left behind.
    expect(sessionMode(plan({ status: "approved", runState: "building", held: true, revising: true }))?.kind).toBe("build");
  });

  it("a restore does not count as a version", () => {
    const revisions = [
      { versionNumber: 1, restored: false },
      { versionNumber: 2, restored: false },
      { versionNumber: 3, restored: true },
    ];
    expect(sessionMode(plan({ status: "approved", runState: "building", revisions }))?.label).toBe("Building v2");
  });

  it("an approved plan with no revisions on hand still reads v1", () => {
    expect(sessionMode(plan({ status: "approved", runState: "building", revisions: [] }))?.label).toBe("Building v1");
  });
});

describe("modeColors", () => {
  it("maps each mode to its own token pair, and chat to the neutral chip", () => {
    expect(modeColors("plan")).toEqual({ fg: "var(--color-mode-plan-fg)", bg: "var(--color-mode-plan-bg)" });
    expect(modeColors("redline").fg).toBe("var(--color-mode-redline-fg)");
    expect(modeColors("build").bg).toBe("var(--color-mode-build-bg)");
    expect(modeColors("chat")).toEqual({ fg: "var(--color-ink-3)", bg: "var(--color-fill-2)" });
  });
});

describe("titles", () => {
  it("names a session the way the sidebar does", () => {
    const base = { sessionId: "s1", projectName: "din", projectPath: "/p/din" };
    expect(sessionTitle({ ...base, planTitle: "Din roadmap", titleOverride: "Mine" })).toBe("Mine");
    expect(sessionTitle({ ...base, planTitle: "Din roadmap" })).toBe("Din roadmap");
    expect(sessionTitle(base)).toBe("din");
    expect(sessionTitle({ sessionId: "s1" })).toBe("s1");
  });

  it("titles a launch by its prompt's first line", () => {
    expect(launchTitle("  Read the build log\nand plan  ")).toBe("Read the build log");
    expect(launchTitle("")).toBe("New session");
    const long = "x".repeat(120);
    expect(launchTitle(long)).toHaveLength(80);
    expect(launchTitle(long).endsWith("…")).toBe(true);
  });
});
