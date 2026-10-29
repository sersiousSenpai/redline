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

// D43 (user screenshot): the footer's "Approve & build" split button looked
// squished: its ▾ glued on as a second button, no gap, a clipped corner.
describe("the split action (D43)", () => {
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };
  it("is one filled pill: the pill owns the fill and the radius, the halves are transparent over it", () => {
    expect(block(".rl-plan-split")).toMatch(/background: var\(--color-ink\)/);
    expect(block(".rl-plan-split")).toMatch(/border-radius: var\(--rl-split-r\)/);
    expect(block('.rl-plan-foot[data-pose="pane"] .rl-plan-split')).toMatch(/--rl-split-r: var\(--rl-radius-row\)/);
    expect(block(".rl-plan-foot .rl-plan-split > .rl-plan-btn--primary")).toMatch(/background: transparent/);
  });
  it("keeps the ▾ inside it, 28 px, behind a hairline, its corners the pill's own", () => {
    const more = block(".rl-plan-foot .rl-plan-split > .rl-plan-split-more");
    expect(more).toMatch(/width: 28px/);
    expect(more).toMatch(/border-radius: 0 var\(--rl-split-r\) var\(--rl-split-r\) 0/);
    expect(block(".rl-plan-split-more::before")).toMatch(/width: 1px/);
    // No second outlined segment glued on.
    expect(css).not.toMatch(/\.rl-plan-split-more \{[^}]*border-left:/);
  });
});
