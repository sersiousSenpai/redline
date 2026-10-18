// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { TermAttention } from "../types";
import {
  attentionKinds,
  bindTerminals,
  latestAttention,
  needReason,
  sidebarActivity,
  deriveStageTarget,
  launchTitle,
  reduceLaunches,
  sidebarLaunches,
  stageTerminal,
  type FlowLaunch,
  type StageInput,
} from "./flowSessions";

const launch = (terminalId: string, over: Partial<FlowLaunch> = {}): FlowLaunch => ({
  launchId: `L-${terminalId}`,
  terminalId,
  prompt: "Read the obsidian build log and plan the next roadmap steps",
  startedAt: 100,
  projectPath: "/p/din",
  mode: "plan",
  harness: "claude",
  confirmed: false,
  ...over,
});

const base: StageInput = {
  activeId: null,
  focusedLaunch: null,
  launches: [],
  terminals: new Map(),
};

describe("deriveStageTarget", () => {
  // focusedLaunch × in launches × in a slot × activeId → kind
  const table: [string, Partial<StageInput>, string][] = [
    ["nothing selected is the New-session screen", {}, "start"],
    ["a selected plan", { activeId: "S" }, "plan"],
    ["a focused launch", { focusedLaunch: "T1", launches: [launch("T1")] }, "launch"],
    ["a focused launch outranks a stale selection", { activeId: "S", focusedLaunch: "T1", launches: [launch("T1")] }, "launch"],
    ["a focused launch only the pending slot holds yet", { focusedLaunch: "T1", pendingLaunch: { terminalId: "T1", prompt: "p", startedAt: 1 } }, "launch"],
    ["a focused run only the flight slot holds", { focusedLaunch: "T1", runFlight: { terminalId: "T1", prompt: "p", startedAt: 1 } }, "launch"],
    ["a focused launch that is gone falls back to the plan", { activeId: "S", focusedLaunch: "T9", launches: [launch("T1")] }, "plan"],
    ["a focused launch that is gone, nothing selected", { focusedLaunch: "T9" }, "start"],
  ];
  it.each(table)("%s", (_name, over, kind) => {
    expect(deriveStageTarget({ ...base, ...over }).kind).toBe(kind);
  });

  it("carries the launch's own prompt, start and folder", () => {
    expect(deriveStageTarget({ ...base, focusedLaunch: "T1", launches: [launch("T1")] })).toEqual({
      kind: "launch",
      terminalId: "T1",
      prompt: "Read the obsidian build log and plan the next roadmap steps",
      startedAt: 100,
      projectPath: "/p/din",
    });
  });

  it("finds a plan session's terminal through the map, or says it doesn't know", () => {
    const terminals = new Map([["S", "T1"]]);
    expect(deriveStageTarget({ ...base, activeId: "S", terminals })).toEqual({ kind: "plan", sessionId: "S", terminalId: "T1" });
    expect(deriveStageTarget({ ...base, activeId: "R", terminals })).toEqual({ kind: "plan", sessionId: "R", terminalId: null });
  });

  it("hands a launch off to its plan on the same terminal — one conversation", () => {
    const before = deriveStageTarget({ ...base, focusedLaunch: "T1", launches: [launch("T1")] });
    // The plan lands: App selects it, clears the focus, and the launch's
    // terminal is bound to the session the plan carries.
    const after = deriveStageTarget({ ...base, activeId: "S", terminals: new Map([["S", "T1"]]) });
    expect(after.kind).toBe("plan");
    expect(stageTerminal(after)).toBe(stageTerminal(before));
  });
});

describe("reduceLaunches", () => {
  it("records a launch first, replacing an older record on the same terminal", () => {
    const a = reduceLaunches([], { type: "launched", launch: launch("T1") });
    const b = reduceLaunches(a, { type: "launched", launch: launch("T2") });
    const c = reduceLaunches(b, { type: "launched", launch: launch("T1", { launchId: "again" }) });
    expect(c.map((l) => l.launchId)).toEqual(["again", "L-T2"]);
    expect(c[0].confirmed).toBe(false);
  });

  it("drops a launch once its plan arrives, and only that one", () => {
    const list = [launch("T1"), launch("T2")];
    expect(reduceLaunches(list, { type: "arrived", launchId: "L-T1" }).map((l) => l.terminalId)).toEqual(["T2"]);
    expect(reduceLaunches(list, { type: "arrived", launchId: "nope" })).toBe(list);
    expect(reduceLaunches(list, { type: "arrived", launchId: "" })).toBe(list);
  });

  // reported? × present? × confirmed? → kept? / confirmed after
  const table: [string, readonly string[] | null, boolean, boolean, boolean][] = [
    ["an unreported dock is ignorance", null, false, true, false],
    ["unreported, even once confirmed", null, true, true, true],
    ["present confirms it", ["T1"], false, true, true],
    ["present and confirmed stays", ["T1"], true, true, true],
    ["absent before any vouching is not news", [], false, true, false],
    ["absent after vouching: its terminal closed", [], true, false, false],
  ];
  it.each(table)("%s", (_name, live, confirmed, kept, after) => {
    const next = reduceLaunches([launch("T1", { confirmed })], { type: "terminals", live });
    expect(next.length === 1).toBe(kept);
    if (kept) expect(next[0].confirmed).toBe(after);
  });

  it("returns the same list when the dock's report changes nothing", () => {
    const list = [launch("T1", { confirmed: true })];
    expect(reduceLaunches(list, { type: "terminals", live: ["T1", "T2"] })).toBe(list);
  });
});

describe("the sidebar's launch rows", () => {
  it("are titled by the prompt and spin until the CLI says otherwise", () => {
    const kinds = new Map<string, TermAttention["kind"]>([["T2", "your-turn"], ["T3", "working"]]);
    const rows = sidebarLaunches([launch("T1"), launch("T2"), launch("T3")], kinds);
    expect(rows.map((r) => r.working)).toEqual([true, false, true]);
    expect(rows[0]).toMatchObject({ terminalId: "T1", title: "Read the obsidian build log and plan the next roadmap steps", projectPath: "/p/din", startedAt: 100 });
  });

  it("takes the CLI's own name for the session once it has one", () => {
    const rows = sidebarLaunches([launch("T1"), launch("T2")], new Map(), new Map([["T2", "Din roadmap"]]));
    expect(rows.map((r) => r.title)).toEqual(["Read the obsidian build log and plan the next roadmap steps", "Din roadmap"]);
  });

  it("titles by the first line, cut to a row", () => {
    expect(launchTitle("\n\n  First line  \nsecond")).toBe("First line");
    expect(launchTitle("x".repeat(100))).toHaveLength(80);
    expect(launchTitle("x".repeat(100)).endsWith("…")).toBe(true);
  });
});

describe("sessionId → terminalId", () => {
  it("binds from attention entries and convo-bound alike; the later report wins", () => {
    const a = bindTerminals(new Map(), [
      { sessionId: null, terminalId: "T0" },
      { sessionId: "S1", terminalId: "T1" },
    ]);
    expect([...a]).toEqual([["S1", "T1"]]);
    const b = bindTerminals(a, [{ sessionId: "S1", terminalId: "T2" }]);
    expect(b.get("S1")).toBe("T2");
  });

  it("keeps identity when nothing moves, so App re-renders only on news", () => {
    const a = bindTerminals(new Map(), [{ sessionId: "S1", terminalId: "T1" }]);
    expect(bindTerminals(a, [{ sessionId: "S1", terminalId: "T1" }])).toBe(a);
    expect(bindTerminals(a, [])).toBe(a);
  });

  it("keeps each terminal's newest transition, whatever order they land in", () => {
    const at = (terminalId: string, kind: "working" | "idle", t: number): TermAttention => ({ terminalId, sessionId: null, at: t, kind });
    const a = latestAttention(new Map(), [at("T1", "working", 5)]);
    expect(latestAttention(a, [at("T1", "idle", 4)])).toBe(a);
    const b = latestAttention(a, [at("T1", "idle", 6)]);
    expect(attentionKinds(b).get("T1")).toBe("idle");
  });
});

describe("the sidebar's spinners and needs", () => {
  const entry = (terminalId: string, over: Partial<TermAttention> & { kind: TermAttention["kind"] }): TermAttention =>
    ({ terminalId, sessionId: null, at: 1, ...over }) as TermAttention;

  it("names why a CLI waits on you", () => {
    expect(needReason(entry("T", { kind: "needs-you", reason: "permission_prompt", message: "Claude needs your permission to use Bash" }))).toBe("Permission");
    expect(needReason(entry("T", { kind: "needs-you", reason: "permission_prompt", message: "Claude has a question for you" }))).toBe("Question");
    expect(needReason(entry("T", { kind: "needs-you", reason: "elicitation_dialog", message: null }))).toBe("Question");
    expect(needReason(entry("T", { kind: "working" }))).toBeNull();
  });

  it("keys plans by session and launches by terminal; an unheard launch is starting", () => {
    const terminals = new Map([["S1", "T1"], ["S2", "T2"]]);
    const attention = new Map<string, TermAttention>([
      ["T1", entry("T1", { kind: "working" })],
      ["T2", entry("T2", { kind: "needs-you", reason: "permission_prompt", message: "permission to use Edit" })],
    ]);
    const { working, needs } = sidebarActivity(terminals, attention, [launch("T9")]);
    expect([...working].sort()).toEqual(["launch:T9", "plan:S1"]);
    expect(needs).toEqual({ "plan:S2": "Permission" });
  });
});
