// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { estimateLabel, extendedLimit, formatMinutes, limitsLabel, teamScaleOf, usageAgainstLimit, TEAM_BUILD_ITEMS, type Preflight, type ScaledView } from "./scaledBuild";

const preflight = (over: Partial<Preflight> = {}): Preflight => ({
  name: "build", description: null, phases: [], callSites: 4, dynamic: false, models: [],
  estimate: { agents: 4, agentsExact: true, tokens: 1_200_000, minutes: 41 }, warnings: [], script: "", ...over,
});
const view = (over: Partial<ScaledView> = {}): ScaledView => ({
  runId: "sb-1", planSessionId: "p", startedAt: 0, preflight: null, phase: { kind: "running" },
  config: { scale: "auto", maxAgents: 8, tokenBudget: 5_000_000, timeBudgetMins: 240, leadModel: "sonnet", workerModel: null, scoutModel: "haiku", effort: null, verify: true, steer: null },
  limits: { agents: 8, tokens: 5_000_000, minutes: 240 }, usage: { agents: 8, tokens: 5_100_000, minutes: 250 }, ...over,
});

describe("scaled build copy", () => {
  it("labels the estimate, with a per-item fan-out said honestly", () => {
    expect(estimateLabel(preflight())).toBe("~4 agents · ~1.2M tokens · ~41 min");
    expect(estimateLabel(preflight({ dynamic: true, estimate: { agents: 8, agentsExact: false, tokens: 2_000_000, minutes: 17 } })))
      .toBe("4+ agents (some run per item) · ~2M tokens · ~17 min");
    expect(limitsLabel(view().limits)).toBe("8 agents · 5M tokens · 4 h");
    expect(formatMinutes(90)).toBe("1 h 30 min");
  });

  it("previews Extend with the same rule as RunCtl::extend", () => {
    // Half again, with floors, never below current use.
    expect(extendedLimit(view(), "agents")).toBe("12 agents");
    expect(extendedLimit(view({ limits: { agents: 2, tokens: 5_000_000, minutes: 240 } }), "agents")).toBe("4 agents");
    expect(extendedLimit(view(), "tokens")).toBe("7.6M tokens");
    expect(extendedLimit(view(), "time")).toBe("6 h 10 min");
    expect(usageAgainstLimit(view(), "agents")).toContain("8 of 8 agents started");
    expect(usageAgainstLimit(view(), "tokens")).toBe("5.1M of 5M tokens used");
  });

  it("maps menu ids to scales", () => {
    expect(TEAM_BUILD_ITEMS.map((i) => teamScaleOf(i.id))).toEqual(["auto", "custom"]);
    expect(teamScaleOf("same")).toBeNull();
  });
});
