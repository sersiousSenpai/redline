// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// plan.css owns the plan chrome's selectors, asserted at the source. The
// notice rows and the ⋯ menu's rows once lived in the Flow stage's stylesheet
// and were lost with it: a detached plan's Restore / Retry / Copy resume read
// as bare text. Every class PlanNotices and PlanPanelHeader draw is defined
// here, so deleting another stylesheet cannot unstyle them again.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/components/plan/plan.css", "utf8");
const classes = (file: string, family: RegExp) => {
  const src = readFileSync(file, "utf8");
  return [...new Set([...src.matchAll(family)].map((m) => m[0]))];
};
const defines = (cls: string) => new RegExp(`\\.${cls}(?![\\w-])[^{]*\\{`).test(css);

describe("plan.css", () => {
  it("defines the notice family and the ⋯ menu family", () => {
    expect(defines("rl-plan-notices")).toBe(true);
    expect(defines("rl-plan-notice")).toBe(true);
    expect(defines("rl-plan-menu")).toBe(true);
    expect(defines("rl-plan-menu-item")).toBe(true);
  });

  it.each([
    ["src/components/plan/PlanNotices.tsx", /rl-plan-notice[\w-]*/g],
    ["src/components/plan/NoticeStrip.tsx", /rl-plan-notice[\w-]*/g],
    ["src/components/plan/PlanPanelHeader.tsx", /rl-plan-menu[\w-]*/g],
  ] as const)("every %s class in its family has a rule", (file, family) => {
    const used = classes(file, family);
    expect(used.length).toBeGreaterThan(0);
    // The panel class only names the shared popover for queries; its box
    // comes from popover.tsx's inline placement.
    expect(used.filter((cls) => cls !== "rl-plan-menu-panel" && !defines(cls))).toEqual([]);
  });

  it("the notices and the menu use Redline tokens only: no literal colours", () => {
    const start = css.indexOf("/* ── The plan's notices");
    expect(start).toBeGreaterThan(-1);
    expect(css.slice(start)).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});
