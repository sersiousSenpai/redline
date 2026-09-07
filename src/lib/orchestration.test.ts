// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  agentStalled,
  capTailEvents,
  fileConflicts,
  formatElapsed,
  formatTokens,
  groupWorkByProject,
  isLiveRunState,
  isSequentialFallback,
  orderRuns,
  phaseProgress,
  resolveRunProject,
  runConflictCount,
  runElapsed,
  runOutcomeLabel,
  runStatusSentence,
  STALL_AFTER_MS,
  tileElapsed,
  tileTitle,
  workBlockedByCounts,
  workItemRank,
  workOriginLabel,
  workStatusLabel,
} from "./orchestration";
import type {
  AgentTailEvent,
  AgentTile,
  OrchestrationRow,
  RunSnapshot,
  WorkEdge,
  WorkItem,
} from "../types";

function tile(over: Partial<AgentTile>): AgentTile {
  return {
    agentId: "a0000000000000000",
    label: null,
    labelSource: "preview",
    phase: null,
    model: null,
    effort: null,
    state: "running",
    startedAt: null,
    lastActivityAt: null,
    durationMs: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCalls: 0,
    lastToolName: null,
    promptPreview: null,
    resultPreview: null,
    filesChanged: [],
    transcriptBytes: 0,
    ...over,
  };
}

function row(over: Partial<OrchestrationRow>): OrchestrationRow {
  return {
    planSessionId: "s1",
    claudeSessionId: "c1",
    transcriptPath: "/t.jsonl",
    cwd: null,
    startedAt: 0,
    runId: null,
    transcriptDir: null,
    scriptPath: null,
    mode: null,
    terminalId: null,
    runState: null,
    ...over,
  };
}

describe("isLiveRunState", () => {
  it("matches the watcher's live set exactly", () => {
    expect(isLiveRunState("orchestrating")).toBe(true);
    expect(isLiveRunState("running")).toBe(true);
    expect(isLiveRunState("in_code_review")).toBe(true);
    expect(isLiveRunState("landed")).toBe(false);
    expect(isLiveRunState("stalled")).toBe(false);
    // A stand-down is terminal — the watcher exits and rehydration skips it.
    expect(isLiveRunState("abandoned")).toBe(false);
    expect(isLiveRunState(null)).toBe(false);
  });
});

describe("runOutcomeLabel", () => {
  it("labels every lifecycle value, abandoned included", () => {
    expect(runOutcomeLabel(row({ runState: "running" }))).toBe("running");
    expect(runOutcomeLabel(row({ runState: "abandoned" }))).toBe("abandoned");
    expect(runOutcomeLabel(row({ runState: null }))).toBe("not started");
  });
});

describe("formatTokens", () => {
  it("scales through k and M", () => {
    expect(formatTokens(431)).toBe("431");
    expect(formatTokens(887_191)).toBe("887k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(12_345_678)).toBe("12M");
    expect(formatTokens(0)).toBe("0");
  });
});

describe("formatElapsed", () => {
  it("picks the unit by magnitude", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(2_900_819)).toBe("48m 20s");
    expect(formatElapsed(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m");
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("orderRuns", () => {
  it("puts live runs first, newest launch first within each group", () => {
    const rows = [
      row({ planSessionId: "old-done", startedAt: 10, runState: "landed" }),
      row({ planSessionId: "new-done", startedAt: 30, runState: "landed" }),
      row({ planSessionId: "live", startedAt: 20, runState: "running" }),
    ];
    expect(orderRuns(rows).map((r) => r.planSessionId)).toEqual([
      "live",
      "new-done",
      "old-done",
    ]);
  });
});

describe("runStatusSentence", () => {
  it("covers empty, quiet, and live shapes", () => {
    expect(runStatusSentence([], null)).toBe("No orchestrated runs yet");
    expect(
      runStatusSentence([row({ runState: "landed" })], null),
    ).toBe("No live runs · 1 in history");
    expect(
      runStatusSentence([row({ runState: "running" })], 12),
    ).toBe("1 run live · 12 agents working");
    expect(
      runStatusSentence(
        [row({ runState: "running" }), row({ runState: "in_code_review" })],
        1,
      ),
    ).toBe("2 runs live · 1 agent working");
  });
});

describe("capTailEvents", () => {
  it("keeps the newest events within the char budget", () => {
    const events: AgentTailEvent[] = [
      { kind: "text", text: "x".repeat(40) },
      { kind: "toolUse", name: "Bash", summary: "y".repeat(20) },
      { kind: "toolResult", summary: "z".repeat(30) },
    ];
    expect(capTailEvents(events, 1000)).toHaveLength(3);
    // Budget 60: the last two fit (24 + 30), the first would overflow.
    const capped = capTailEvents(events, 60);
    expect(capped).toHaveLength(2);
    expect(capped[0].kind).toBe("toolUse");
    expect(capTailEvents(events, 5)).toHaveLength(0);
    expect(capTailEvents([], 100)).toHaveLength(0);
  });
});

describe("agentStalled", () => {
  it("flags a silent running agent, never a finished one", () => {
    const now = 1_000_000_000;
    const quiet = tile({ state: "running", lastActivityAt: now - STALL_AFTER_MS - 1 });
    const busy = tile({ state: "running", lastActivityAt: now - 5_000 });
    const done = tile({ state: "done", lastActivityAt: now - STALL_AFTER_MS - 1 });
    expect(agentStalled(quiet, now)).toBe(true);
    expect(agentStalled(busy, now)).toBe(false);
    expect(agentStalled(done, now)).toBe(false);
    expect(agentStalled(tile({ state: "running" }), now)).toBe(false);
  });
});

describe("fileConflicts", () => {
  it("reports files claimed by two or more agents", () => {
    const agents = [
      tile({ agentId: "a1111111111111111", filesChanged: ["src/a.ts", "src/b.ts"] }),
      tile({ agentId: "a2222222222222222", filesChanged: ["src/b.ts"] }),
      tile({ agentId: "a3333333333333333", filesChanged: [] }),
    ];
    const conflicts = fileConflicts(agents);
    expect(conflicts.size).toBe(1);
    expect(conflicts.get("src/b.ts")).toEqual([
      "a1111111111111111",
      "a2222222222222222",
    ]);
    // The same agent listing a file twice is not a conflict.
    const solo = fileConflicts([
      tile({ agentId: "a1111111111111111", filesChanged: ["x", "x"] }),
    ]);
    expect(solo.size).toBe(0);
  });
});

describe("phaseProgress", () => {
  it("rolls tiles up under their phase titles", () => {
    const phases = [
      { title: "Build", detail: null },
      { title: "Verify", detail: "checks" },
    ];
    const agents = [
      tile({ agentId: "a1111111111111111", phase: "Build", state: "done" }),
      tile({ agentId: "a2222222222222222", phase: "Build", state: "running" }),
      tile({ agentId: "a3333333333333333", phase: "Verify", state: "failed" }),
      tile({ agentId: "a4444444444444444", phase: "Verify", state: "cached" }),
      tile({ agentId: "a5555555555555555", phase: null, state: "running" }),
    ];
    const progress = phaseProgress(phases, agents);
    expect(progress).toEqual([
      { title: "Build", detail: null, total: 2, done: 1, running: 1, failed: 0 },
      { title: "Verify", detail: "checks", total: 2, done: 1, running: 0, failed: 1 },
    ]);
  });
});

function workItem(over: Partial<WorkItem>): WorkItem {
  return {
    id: "rl-0000",
    title: "an item",
    body: null,
    status: "open",
    priority: 2,
    kind: "task",
    assignee: null,
    claimedAt: null,
    leaseExpiresAt: null,
    closedAt: null,
    closeReason: null,
    deferUntil: null,
    originKind: null,
    originId: null,
    projectPath: null,
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function blocksEdge(fromId: string, toId: string): WorkEdge {
  return { fromId, toId, type: "blocks", createdBy: null, createdAt: 0 };
}

describe("workBlockedByCounts", () => {
  it("counts only blocks edges whose blocker is still present", () => {
    const items = [
      workItem({ id: "rl-a" }),
      workItem({ id: "rl-b" }),
      workItem({ id: "rl-c" }),
    ];
    const edges: WorkEdge[] = [
      blocksEdge("rl-a", "rl-c"),
      blocksEdge("rl-b", "rl-c"),
      // A dangling blocker (row closed/gone → absent from the rollup) never
      // blocks — the FE mirror of the ready CTE's rule 4.
      blocksEdge("rl-ghost", "rl-c"),
      // Non-blocks edges are structure, not blockage.
      { fromId: "rl-a", toId: "rl-b", type: "relates-to", createdBy: null, createdAt: 0 },
    ];
    const counts = workBlockedByCounts(items, edges);
    expect(counts.get("rl-c")).toBe(2);
    expect(counts.get("rl-b")).toBeUndefined();
  });
});

describe("workItemRank / workStatusLabel", () => {
  it("bands ready → open-not-ready → claimed → held", () => {
    const ready = new Set(["rl-r"]);
    expect(workItemRank(workItem({ id: "rl-r" }), ready)).toBe(0);
    expect(workItemRank(workItem({ id: "rl-x" }), ready)).toBe(1);
    expect(workItemRank(workItem({ id: "rl-x", status: "claimed" }), ready)).toBe(2);
    expect(workItemRank(workItem({ id: "rl-x", status: "held" }), ready)).toBe(3);
  });

  it("labels the whole vocabulary the tab renders", () => {
    const ready = new Set(["rl-r"]);
    expect(workStatusLabel(workItem({ id: "rl-r" }), ready, 0)).toBe("ready");
    expect(workStatusLabel(workItem({ id: "rl-x" }), ready, 2)).toBe("blocked");
    // Open, not ready, no blockers = deferred (its own timer or an ancestor's).
    expect(workStatusLabel(workItem({ id: "rl-x" }), ready, 0)).toBe("deferred");
    expect(workStatusLabel(workItem({ id: "rl-x", status: "claimed" }), ready, 0)).toBe("claimed");
    expect(workStatusLabel(workItem({ id: "rl-x", status: "held" }), ready, 0)).toBe("held");
  });
});

describe("workOriginLabel", () => {
  it("shows the breadcrumb, shortened, and never fabricates one", () => {
    expect(workOriginLabel(workItem({}))).toBe("—");
    expect(workOriginLabel(workItem({ originKind: "intake" }))).toBe("intake");
    expect(
      workOriginLabel(workItem({ originKind: "drafter", originId: "1a2b3c4d5e6f" })),
    ).toBe("drafter · 1a2b3c4d");
    expect(
      workOriginLabel(workItem({ originKind: "drafter", originId: "short" })),
    ).toBe("drafter · short");
  });
});

describe("groupWorkByProject", () => {
  it("groups by the project facet, ready depth first, no-project last on ties", () => {
    const items = [
      workItem({ id: "rl-n1", projectPath: null }),
      workItem({ id: "rl-a1", projectPath: "/repo/a" }),
      workItem({ id: "rl-b1", projectPath: "/repo/b" }),
      workItem({ id: "rl-b2", projectPath: "/repo/b" }),
    ];
    const groups = groupWorkByProject(items, new Set(["rl-b1", "rl-b2", "rl-a1"]));
    expect(groups.map((g) => g.project)).toEqual(["/repo/b", "/repo/a", null]);
    expect(groups[0].readyCount).toBe(2);
    expect(groups[2].readyCount).toBe(0);
  });

  it("orders a group ready → blocked/deferred → claimed → held, stable within a band", () => {
    const items = [
      workItem({ id: "rl-held", status: "held", projectPath: "/p" }),
      workItem({ id: "rl-blocked", projectPath: "/p" }),
      workItem({ id: "rl-claimed", status: "claimed", projectPath: "/p" }),
      workItem({ id: "rl-r2", projectPath: "/p" }),
      workItem({ id: "rl-r1", projectPath: "/p" }),
    ];
    const [group] = groupWorkByProject(items, new Set(["rl-r2", "rl-r1"]));
    expect(group.items.map((i) => i.id)).toEqual([
      // The DB's urgent-first order within the ready band is preserved.
      "rl-r2",
      "rl-r1",
      "rl-blocked",
      "rl-claimed",
      "rl-held",
    ]);
  });
});

describe("tile display helpers", () => {
  it("titles fall back label → preview → id", () => {
    expect(tileTitle(tile({ label: "build:x", promptPreview: "p" }))).toBe("build:x");
    expect(tileTitle(tile({ promptPreview: "the prompt" }))).toBe("the prompt");
    expect(tileTitle(tile({ agentId: "a13046496e0682a9d" }))).toBe("a1304649");
  });

  it("elapsed counts up while running, freezes on the recorded duration", () => {
    const now = 500_000;
    expect(tileElapsed(tile({ state: "running", startedAt: now - 42_000 }), now)).toBe("42s");
    expect(tileElapsed(tile({ state: "done", durationMs: 61_000 }), now)).toBe("1m 1s");
    expect(tileElapsed(tile({ state: "done" }), now)).toBeNull();
  });

  it("run elapsed prefers the manifest duration", () => {
    const base: RunSnapshot = {
      planSessionId: "s1",
      claudeSessionId: "c1",
      runState: "running",
      startedAt: 0,
      updatedAt: 0,
      seq: 0,
      mode: "workflow",
      runId: null,
      workflowName: null,
      workflowDescription: null,
      phases: [],
      scriptPath: null,
      transcriptDir: null,
      totals: {
        plannedAgents: null,
        running: 0,
        done: 0,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        toolCalls: 0,
        filesChanged: [],
      },
      agents: [],
      manifest: null,
      reportFiled: false,
      dirsMissing: false,
      notes: [],
    };
    expect(runElapsed(base, 90_000)).toBe("1m 30s");
    expect(
      runElapsed(
        {
          ...base,
          manifest: {
            status: "completed",
            durationMs: 2_900_819,
            summary: null,
            agentCount: null,
            totalTokens: null,
            totalToolCalls: null,
          },
        },
        90_000,
      ),
    ).toBe("48m 20s");
  });
});

describe("resolveRunProject", () => {
  const summaries = [
    { sessionId: "s1", projectPath: "/Users/me/redline" },
    { sessionId: "s2", projectPath: "/Users/me/other" },
  ];

  it("prefers the loaded session over the summary list", () => {
    expect(
      resolveRunProject(
        "s1",
        { sessionId: "s1", projectPath: "/Users/me/live" },
        summaries,
      ),
    ).toBe("/Users/me/live");
  });

  it("ignores a loaded session for a different id", () => {
    expect(
      resolveRunProject(
        "s2",
        { sessionId: "s1", projectPath: "/Users/me/live" },
        summaries,
      ),
    ).toBe("/Users/me/other");
  });

  it("falls back to the summary when no session is loaded", () => {
    expect(resolveRunProject("s1", null, summaries)).toBe("/Users/me/redline");
  });

  it("refuses when the session is absent from both", () => {
    // The regression: this used to yield null and get passed straight to
    // buildOrchestrateLaunchCommand, which emits no `cd` — an acceptEdits
    // orchestrator spawning in $HOME.
    expect(resolveRunProject("gone", null, summaries)).toBeNull();
  });

  it("treats a blank path as no path at all", () => {
    expect(
      resolveRunProject("s3", { sessionId: "s3", projectPath: "   " }, [
        { sessionId: "s3", projectPath: "" },
      ]),
    ).toBeNull();
  });
});

describe("runConflictCount / isSequentialFallback", () => {
  const agent = (id: string, files: string[]) =>
    tile({ agentId: id, filesChanged: files });

  it("counts files claimed by two or more agents", () => {
    expect(
      runConflictCount([
        agent("a", ["src/App.tsx", "src/lib/x.ts"]),
        agent("b", ["src/App.tsx"]),
        agent("c", ["src/lib/x.ts", "README.md"]),
      ]),
    ).toBe(2);
  });

  it("is zero when every agent owns its own files", () => {
    expect(
      runConflictCount([agent("a", ["one.ts"]), agent("b", ["two.ts"])]),
    ).toBe(0);
    expect(runConflictCount([])).toBe(0);
  });

  it("does not count one agent touching the same file twice", () => {
    expect(runConflictCount([agent("a", ["dup.ts", "dup.ts"])])).toBe(0);
  });

  it("marks only the sequential fallback", () => {
    expect(isSequentialFallback("sequential")).toBe(true);
    expect(isSequentialFallback("workflow")).toBe(false);
    expect(isSequentialFallback("pending")).toBe(false);
    expect(isSequentialFallback(null)).toBe(false);
    expect(isSequentialFallback(undefined)).toBe(false);
  });
});
