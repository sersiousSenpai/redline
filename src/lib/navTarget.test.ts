// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  innerTabs,
  isKnownTab,
  navTargets,
  sameTarget,
  SURFACE_INNER_TABS,
} from "./navTarget";

describe("innerTabs", () => {
  it("gives the memory and runs surfaces their tabs", () => {
    expect(innerTabs("memory").map((t) => t.id)).toEqual([
      "ask",
      "timeline",
      "catalog",
      "map",
      "health",
    ]);
    expect(innerTabs("runs").map((t) => t.id)).toEqual([
      "live",
      "history",
      "work",
    ]);
  });

  it("a surface with no tabs is reached whole", () => {
    for (const s of ["document", "browser", "drafter", "review", "servers"]) {
      expect(innerTabs(s)).toEqual([]);
    }
  });

  it("an unknown surface is empty, not an error", () => {
    expect(innerTabs("some-future-pack-surface")).toEqual([]);
  });

  it("the memory tabs are the five the surface actually has, Ask first", () => {
    // Ask is a tab of the memory surface, not a dock conversation: its thread
    // is a singleton, so it gets exactly one mount and this is where it is.
    expect(SURFACE_INNER_TABS.memory.some((t) => t.id === "ask")).toBe(true);
    expect(SURFACE_INNER_TABS.memory[0].id).toBe("ask");
    expect(SURFACE_INNER_TABS.memory).toHaveLength(5);
  });
});

describe("isKnownTab", () => {
  it("accepts a tab the surface has", () => {
    expect(isKnownTab("memory", "catalog")).toBe(true);
    expect(isKnownTab("runs", "work")).toBe(true);
  });

  it("rejects a tab from another surface, an unknown one, and nothing", () => {
    expect(isKnownTab("memory", "work")).toBe(false);
    expect(isKnownTab("memory", "no-such-tab")).toBe(false);
    expect(isKnownTab("memory", undefined)).toBe(false);
    expect(isKnownTab("review", "timeline")).toBe(false);
  });
});

describe("navTargets", () => {
  it("lists a surface then its tabs, in order", () => {
    expect(navTargets(["review", "runs"])).toEqual([
      { surface: "review" },
      { surface: "runs" },
      { surface: "runs", tab: "live" },
      { surface: "runs", tab: "history" },
      { surface: "runs", tab: "work" },
    ]);
  });

  it("is empty for no surfaces", () => {
    expect(navTargets([])).toEqual([]);
  });
});

describe("sameTarget", () => {
  it("a surface and that surface's tab are different places", () => {
    expect(sameTarget({ surface: "memory" }, { surface: "memory" })).toBe(true);
    expect(
      sameTarget({ surface: "memory" }, { surface: "memory", tab: "map" }),
    ).toBe(false);
    expect(
      sameTarget(
        { surface: "memory", tab: "map" },
        { surface: "memory", tab: "map" },
      ),
    ).toBe(true);
  });
});
