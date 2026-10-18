// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it } from "vitest";

import {
  getFlowState,
  planPoseOf,
  resetFlowStateForTests,
  type PanelTab,
  type PlanPose,
} from "../shell/flowState";
import {
  buildProgress,
  closePlan,
  effectivePose,
  movePose,
  noteRevision,
  openPlan,
  planColumnVars,
  poseOnRevision,
  resetFlowPoseForTests,
  tabOnPose,
  toggleFull,
} from "./flowPose";

describe("effectivePose: what the stage paints", () => {
  // stored × hasPlan × narrow → painted
  const table: [PlanPose, boolean, boolean, PlanPose][] = [
    ["closed", false, false, "closed"],
    ["split", false, false, "closed"],
    ["full", false, true, "closed"],
    ["closed", true, false, "closed"],
    ["closed", true, true, "closed"],
    ["split", true, false, "split"],
    ["split", true, true, "full"],
    ["full", true, false, "full"],
    ["full", true, true, "full"],
  ];
  it.each(table)("stored %s, plan %s, narrow %s → %s", (stored, hasPlan, narrow, painted) => {
    expect(effectivePose({ stored, hasPlan, narrow })).toBe(painted);
  });
});

describe("poseOnRevision: a new revision opens the plan once", () => {
  // stored × revision × moved → result
  const table: [PlanPose, number, number | null, { pose: PlanPose; moved: number } | null][] = [
    ["closed", 1, null, { pose: "split", moved: 1 }],
    ["split", 1, null, { pose: "split", moved: 1 }],
    ["full", 1, null, { pose: "full", moved: 1 }],
    ["closed", 1, 1, null],
    ["closed", 2, 1, { pose: "split", moved: 2 }],
    ["closed", 1, 3, null],
    ["full", 4, 3, { pose: "full", moved: 4 }],
  ];
  it.each(table)("stored %s, revision %s, last moved %s", (stored, revision, moved, result) => {
    expect(poseOnRevision({ stored, revision, moved })).toEqual(result);
  });
});

describe("tabOnPose: entering full opens Feedback when marks wait", () => {
  // from × to × unresolved × tab → tab
  const table: [PlanPose, PlanPose, number, PanelTab, PanelTab][] = [
    ["split", "full", 2, "chat", "feedback"],
    ["closed", "full", 1, "chat", "feedback"],
    ["split", "full", 0, "feedback", "chat"],
    ["closed", "full", 0, "chat", "chat"],
    ["full", "full", 3, "chat", "chat"],
    ["full", "split", 3, "chat", "chat"],
    ["split", "closed", 3, "feedback", "feedback"],
  ];
  it.each(table)("%s → %s with %s marks, tab %s → %s", (from, to, unresolved, tab, next) => {
    expect(tabOnPose({ from, to, unresolved, tab })).toBe(next);
  });
});

describe("the writers go through flowState", () => {
  beforeEach(() => {
    resetFlowStateForTests();
    resetFlowPoseForTests();
  });

  it("a revision opens a closed plan beside the chat, and closing sticks until the next one", () => {
    noteRevision("S", 1);
    expect(planPoseOf("S")).toBe("split");
    closePlan("S");
    noteRevision("S", 1);
    expect(planPoseOf("S")).toBe("closed");
    noteRevision("S", 2);
    expect(planPoseOf("S")).toBe("split");
  });

  it("opening on a narrow stage goes straight to full; Full screen toggles", () => {
    openPlan("S", 0, true);
    expect(planPoseOf("S")).toBe("full");
    toggleFull("S", 0);
    expect(planPoseOf("S")).toBe("split");
    toggleFull("S", 2);
    expect(planPoseOf("S")).toBe("full");
    expect(getFlowState().panelTab).toBe("feedback");
  });

  it("entering full with nothing waiting shows the conversation's tab", () => {
    movePose("S", "split", 0);
    movePose("S", "full", 0);
    expect(getFlowState().panelTab).toBe("chat");
    expect(planPoseOf("S")).toBe("full");
  });

  it("each session keeps its own pose", () => {
    openPlan("A", 0, false);
    expect(planPoseOf("A")).toBe("split");
    expect(planPoseOf("B")).toBe("closed");
  });
});

describe("planColumnVars", () => {
  const vars = (...a: Parameters<typeof planColumnVars>) => planColumnVars(...a) as Record<string, string>;

  it("is the board's column at the default measure", () => {
    expect(vars("split", false, 820)).toEqual({ "--rl-plan-max": "680px", "--rl-plan-pt": "34px", "--rl-plan-px": "56px", "--rl-plan-mx": "0px" });
    // 5a's 720px text column, with a 24px gutter either side.
    expect(vars("full", false, 820)).toEqual({ "--rl-plan-max": "768px", "--rl-plan-pt": "40px", "--rl-plan-px": "24px", "--rl-plan-mx": "auto" });
    expect(vars("full", true, 820)["--rl-plan-px"]).toBe("64px");
  });

  it("widens by the dragged measure, and wide fills the panel", () => {
    expect(vars("full", false, 900)["--rl-plan-max"]).toBe("848px");
    expect(vars("split", false, 900)["--rl-plan-max"]).toBe("760px");
    expect(vars("full", true, 820)["--rl-plan-max"]).toBe("none");
    expect(vars("split", true, 820)["--rl-plan-max"]).toBe("none");
    expect(vars("split", false, Number.NaN)["--rl-plan-max"]).toBe("680px");
  });
});

describe("buildProgress", () => {
  const run = (plannedAgents: number | null, done: number, running: number) => ({ totals: { plannedAgents, done, running } });
  it.each([
    ["5a: two done, one under way, of eleven", run(11, 2, 1), { step: 3, of: 11 }],
    ["between steps it counts what finished", run(11, 3, 0), { step: 3, of: 11 }],
    ["parallel agents are still one step under way", run(11, 2, 3), { step: 3, of: 11 }],
    ["never past the planned count", run(4, 4, 1), { step: 4, of: 4 }],
    ["nothing started yet", run(11, 0, 0), null],
    ["no upper bound to count against", run(null, 2, 1), null],
  ])("%s", (_, input, want) => {
    expect(buildProgress(input)).toEqual(want);
  });
  it("no run, no count", () => expect(buildProgress(null)).toBeNull());
});
