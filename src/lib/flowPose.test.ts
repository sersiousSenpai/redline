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
  closePlan,
  effectivePose,
  movePose,
  noteRevision,
  openPlan,
  planColumnStyle,
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

describe("planColumnStyle", () => {
  it("is the board's column at the default measure", () => {
    expect(planColumnStyle("split", false, 820)).toMatchObject({ maxWidth: "680px", padding: "34px 56px 48px", marginLeft: 0 });
    expect(planColumnStyle("full", false, 820)).toMatchObject({ maxWidth: "720px", marginLeft: "auto", marginRight: "auto" });
  });

  it("widens by the dragged measure, and wide fills the panel", () => {
    expect(planColumnStyle("full", false, 900).maxWidth).toBe("800px");
    expect(planColumnStyle("split", false, 900).maxWidth).toBe("760px");
    expect(planColumnStyle("full", true, 820).maxWidth).toBe("none");
    expect(planColumnStyle("split", true, 820).maxWidth).toBe("none");
  });
});
