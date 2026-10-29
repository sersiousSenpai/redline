// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// D38: sidebar | stage | rail meet on 1px rules — no gutter, no inset card,
// no rounded column, no floating chevron — and each column has a hard stop:
// one that cannot keep it folds instead of squishing. D40 gives each pane
// kind its own stop, which sets the stage's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DIVIDER_W, DOOR_MIN_W, SEAM_W, SHELL_EDGE, SHELL_GUTTER, STAGE_MIN_W, computePaneLayout, docMinFor } from "../lib/paneLayout";
import { PANE_MIN_W } from "./model";
import { RAIL_FOLD_BELOW, SIDEBAR_FOLD_BELOW, railFoldsAt, responsivePose, sidebarFoldsAt, NO_NARROW_OPEN } from "./poses";
import { RAIL_MIN_W, SIDEBAR_MIN_W, clampSidebarWidth } from "./rail";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
/** A stylesheet without its comments, so prose can't satisfy a pin. */
const css = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "");
/** The body of the first rule whose selector is exactly `selector`. */
const rule = (sheet: string, selector: string) => {
  const at = sheet.search(new RegExp(`(^|\\n|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`));
  if (at < 0) return null;
  const open = sheet.indexOf("{", at);
  return sheet.slice(open + 1, sheet.indexOf("}", open));
};

describe("no gaps (D38)", () => {
  it("the columns meet on one rule: no gutter, no edge ring", () => {
    expect(SHELL_GUTTER).toBe(0);
    expect(SHELL_EDGE).toBe(0);
    expect(SEAM_W).toBe(1);
    expect(DIVIDER_W).toBe(1);
  });

  it("a column is square and flat: no radius, no border, no shadow, no inset", () => {
    const styles = css("src/styles.css");
    const plate = rule(styles, ".rl-plate")!;
    expect(plate).not.toBeNull();
    expect(plate).not.toMatch(/border-radius|border\s*:|box-shadow|margin|padding/);
    // No corner glow on a column (the theme rings are never generated).
    expect(styles).not.toMatch(/\n\.rl-plate::after\s*\{/);
    expect(styles).not.toMatch(/\.rl-plate:not\(\[data-rl-curtain\]\)::before\s*\{\s*content/);
    // The curtained columns are square too.
    for (const sel of [".rl-sidebar-clip[data-rl-curtain] .rl-sidebar-aside", ".rl-pane-clip[data-rl-curtain] .rl-pane-aside"]) {
      expect(rule(styles, sel)).not.toMatch(/border-radius|border\s*:/);
    }
    // The seam is the rule token, and a split's seam is one rule too.
    expect(rule(styles, ".rl-divider-bar")).toMatch(/background:\s*var\(--color-rule\)/);
    expect(read("src/workbench/WorkbenchStage.tsx")).toMatch(/const DIVIDER = 1;/);
    // <main> has no hull ring.
    expect(read("src/App.tsx")).not.toMatch(/padding:\s*`\$\{SHELL_EDGE\}px`/);
  });

  it("the stage strip and the rail strip share the 34 px baseline", () => {
    expect(rule(css("src/workbench/workbench.css"), ".rl-wb-strip")).toMatch(/height:\s*34px/);
    expect(rule(css("src/workbench/rail.css"), ".rl-rail-strip")).toMatch(/height:\s*34px/);
  });
});

describe("no collapse pills (D38)", () => {
  it("no chevron or caret pill on any seam, edge strip or latch", () => {
    const divider = read("src/components/PaneDivider.tsx");
    expect(divider).not.toMatch(/<button/);
    expect(divider).not.toMatch(/[‹›]|rounded-full|hideChevron|collapsedCaretNudge/);
    const app = read("src/App.tsx");
    expect(app).not.toMatch(/hideChevron|latchActive|reopenDocFrom|rl-collapse-chevron/);
    const rail = read("src/workbench/RightRail.tsx");
    expect(rail).not.toMatch(/PanelRightOpen|PanelLeftOpen|PanelRightClose|Hide the rail|Show the rail|Show the sidebar/);
    for (const sheet of ["src/styles.css", "src/workbench/rail.css", "src/workbench/workbench.css"]) {
      expect(css(sheet)).not.toMatch(/collapse-chevron|collapse-pill|rl-latch/);
    }
  });

  it("a column-top ⋯ is never a button at rest", () => {
    expect(css("src/workbench/workbench.css")).toMatch(/\.rl-wb-pane-menu:not\(\[aria-expanded="true"\]\)\s*\{\s*opacity:\s*0;/);
    expect(css("src/components/plan/plan.css")).toMatch(/\.rl-plan-menu > \.rl-plan-head-btn:not\(\[aria-expanded="true"\]\)\s*\{\s*opacity:\s*0;/);
  });
});

describe("hard stops (D38, D40)", () => {
  it("pins the three minimums; the stage's follows the pane on it", () => {
    expect(SIDEBAR_MIN_W).toBe(200);
    expect(RAIL_MIN_W).toBe(280);
    expect(STAGE_MIN_W).toBe(480);
    expect(docMinFor(1440)).toBe(STAGE_MIN_W);
    expect(docMinFor(1440, DOOR_MIN_W)).toBe(560);
    expect(clampSidebarWidth(150)).toBe(200);
    // The stylesheets hold the same numbers: content never reflows below them.
    const styles = css("src/styles.css");
    expect(rule(styles, ".rl-sidebar-aside")).toMatch(new RegExp(`min-width:\\s*${SIDEBAR_MIN_W}px`));
    expect(rule(styles, ".rl-pane-aside:not(.absolute)")).toMatch(new RegExp(`min-width:\\s*${RAIL_MIN_W}px`));
    const rail = css("src/workbench/rail.css");
    expect(rule(rail, ".rl-rail")).toMatch(new RegExp(`min-width:\\s*${RAIL_MIN_W}px`));
    expect(rule(rail, ".rl-rail .rl-fb-card")).toMatch(/min-width:\s*252px/);
  });

  it("D18's breakpoints stay: each column keeps its minimum just above its breakpoint", () => {
    expect(railFoldsAt(RAIL_FOLD_BELOW)).toBe(false);
    expect(railFoldsAt(RAIL_FOLD_BELOW - 1)).toBe(true);
    expect(sidebarFoldsAt(SIDEBAR_FOLD_BELOW)).toBe(false);
    expect(sidebarFoldsAt(SIDEBAR_FOLD_BELOW - 1)).toBe(true);
    expect(SIDEBAR_MIN_W + RAIL_MIN_W + 2 * DIVIDER_W + STAGE_MIN_W).toBeLessThanOrEqual(RAIL_FOLD_BELOW);
    // A lone door keeps them too: its minimum moves no breakpoint.
    expect(railFoldsAt(RAIL_FOLD_BELOW, DOOR_MIN_W)).toBe(false);
    expect(sidebarFoldsAt(SIDEBAR_FOLD_BELOW, DOOR_MIN_W)).toBe(false);
  });

  it("a split that asks more of the stage folds the columns it cannot sit beside", () => {
    const open = { sidebarCollapsed: false, paneCollapsed: false, narrowOpen: NO_NARROW_OPEN };
    // A plan beside a browser at 1440 (480 + 1 + 420) with a 260 sidebar: the
    // sidebar stays open — the rail gives first, here only down to 280.
    const page = PANE_MIN_W.plan + 1 + PANE_MIN_W.browser;
    expect(responsivePose({ winWidth: 1440, ...open, stageMin: page })).toMatchObject({ sidebarCollapsed: false });
    const l = computePaneLayout({ winWidth: 1440, sidebarWidth: 260, sidebarCollapsed: false, paneWidth: 320, paneCollapsed: false, paneFullscreen: false, stageMin: page, sidebarMin: SIDEBAR_MIN_W, paneMin: RAIL_MIN_W });
    expect(l.sidebarW).toBeGreaterThanOrEqual(SIDEBAR_MIN_W);
    expect(l.docFlowW).toBe(page);
    expect(l.curtainActive).toBe(false);
    // A plan beside a door and a page (1463 px): neither column fits.
    const wide = PANE_MIN_W.plan + PANE_MIN_W.door + PANE_MIN_W.browser + 2;
    expect(responsivePose({ winWidth: 1440, ...open, stageMin: wide })).toMatchObject({ paneCollapsed: true, sidebarCollapsed: true });
    expect(responsivePose({ winWidth: 1440, ...open })).toMatchObject({ paneCollapsed: false, sidebarCollapsed: false });
  });
});

describe("the door at its minimum (D40)", () => {
  it("keeps one chip row and a one-line headline", () => {
    const island = css("src/components/MonochatIsland.css");
    expect(island).toMatch(/\.rl-monochat \.rl-frontdoor\.is-compact \.rl-fd-tools\s*\{\s*flex-wrap:\s*nowrap;/);
    expect(rule(island, ".rl-fd-title")).toMatch(/white-space:\s*nowrap/);
  });
});
