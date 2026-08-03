// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  heldPlanByTerminal,
  heldTerminalIds,
  type HeldSummary,
} from "./heldTerminals";

const s = (
  held: boolean,
  heldTerminalId: string | null = null,
): HeldSummary => ({ held, heldTerminalId });

describe("heldTerminalIds", () => {
  it("is empty when nothing is held", () => {
    expect(heldTerminalIds([s(false, "t1"), s(false)]).size).toBe(0);
  });

  it("collects one id per held session", () => {
    const ids = heldTerminalIds([s(true, "t1"), s(true, "t2"), s(false, "t3")]);
    expect(ids).toEqual(new Set(["t1", "t2"]));
  });

  it("keeps each pane's strip alive when the other's plan is approved", () => {
    // Split dock: a plan held from each pane. Approving pane A's session drops
    // its summary's `held`; pane B must keep its own strip.
    const before = [s(true, "paneA"), s(true, "paneB")];
    expect(heldTerminalIds(before)).toEqual(new Set(["paneA", "paneB"]));

    const afterApprovingA = [s(false, null), s(true, "paneB")];
    expect(heldTerminalIds(afterApprovingA)).toEqual(new Set(["paneB"]));

    const afterApprovingBoth = [s(false, null), s(false, null)];
    expect(heldTerminalIds(afterApprovingBoth).size).toBe(0);
  });

  it("ignores holds from terminals outside the dock", () => {
    // A plan intercepted from an external terminal has no tab to mark.
    expect(heldTerminalIds([s(true, null), s(true)]).size).toBe(0);
  });

  it("dedupes two sessions held from the same terminal", () => {
    expect(heldTerminalIds([s(true, "t1"), s(true, "t1")])).toEqual(
      new Set(["t1"]),
    );
  });
});

describe("heldPlanByTerminal", () => {
  const held = (
    heldTerminalId: string | null,
    planTitle?: string | null,
    projectName?: string,
  ): HeldSummary => ({ held: true, heldTerminalId, planTitle, projectName });

  it("names what each held terminal is stopped on", () => {
    const map = heldPlanByTerminal([
      held("t1", "Repo bubbles in the tab bar"),
      held("t2", "Windows port"),
    ]);
    expect(map.get("t1")).toBe("Repo bubbles in the tab bar");
    expect(map.get("t2")).toBe("Windows port");
  });

  it("falls back to the project name for a plan with no heading", () => {
    const map = heldPlanByTerminal([held("t1", null, "redline")]);
    expect(map.get("t1")).toBe("redline");
    expect(heldPlanByTerminal([held("t2", "   ", "redline")]).get("t2")).toBe(
      "redline",
    );
  });

  it("skips sessions that aren't held, or hold from outside the dock", () => {
    const map = heldPlanByTerminal([
      { held: false, heldTerminalId: "t1", planTitle: "Not held" },
      held(null, "External terminal"),
    ]);
    expect(map.size).toBe(0);
  });

  it("omits a terminal it can name nothing for", () => {
    expect(heldPlanByTerminal([held("t1", null, "")]).size).toBe(0);
  });

  it("lets the later summary win for one terminal", () => {
    const map = heldPlanByTerminal([held("t1", "Older"), held("t1", "Newer")]);
    expect(map.get("t1")).toBe("Newer");
  });
});
