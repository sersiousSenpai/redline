// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  CANONICAL_PANE_W,
  CANONICAL_SIDEBAR_W,
  DIVIDER_W,
  DOC_MIN,
  DOC_MIN_FRAC,
  DOOR_MIN_W,
  SEAM_W,
  SHELL_EDGE,
  SHELL_GUTTER,
  STAGE_MIN_W,
  VOICE_DOC_MIN,
  VOICE_PANE_MIN,
  canonicalLayout,
  computePaneLayout,
  docMinFor,
  isLayoutAtRest,
  voicePaneMaxW,
  type PaneLayoutInput,
  type RestingShapeInput,
} from "./paneLayout";

// D38: the columns meet on 1px rules — no gutter, no window-edge ring — and
// the stage holds a hard floor: D38's 480 px, or what the tab on screen asks
// (D40). Drag math reads them through computePaneLayout only.
describe("shell constants", () => {
  it("pins no gutter, no edge ring, a one-rule seam and the stage's floor", () => {
    expect(SHELL_GUTTER).toBe(0);
    expect(SHELL_EDGE).toBe(0);
    expect(SEAM_W).toBe(1);
    expect(DIVIDER_W).toBe(SEAM_W);
    expect(DOOR_MIN_W).toBe(560);
    expect(STAGE_MIN_W).toBe(480);
    // The tab on screen sets the real floor: a lone door's is its own.
    expect(docMinFor(1440, DOOR_MIN_W)).toBe(DOOR_MIN_W);
    expect(computePaneLayout({ ...base, winWidth: 1100, stageMin: DOOR_MIN_W, sidebarMin: 200, paneMin: 280 }).docFlowW).toBe(DOOR_MIN_W);
    expect(DOC_MIN).toBe(STAGE_MIN_W);
  });
});

const base: PaneLayoutInput = {
  winWidth: 1440,
  sidebarWidth: 240,
  sidebarCollapsed: false,
  paneWidth: 320,
  paneCollapsed: false,
  paneFullscreen: false,
};

describe("computePaneLayout", () => {
  it("reserves a collapsed rail's edge strip, and nothing for an open or fullscreen one", () => {
    const folded = computePaneLayout({ ...base, paneCollapsed: true, paneEdgeW: 40 });
    expect(folded.paneFlowW).toBe(0);
    expect(folded.docFlowW).toBe(1440 - 2 * DIVIDER_W - 2 * SHELL_EDGE - 240 - 40);
    expect(computePaneLayout({ ...base, paneEdgeW: 40 }).docFlowW).toBe(computePaneLayout(base).docFlowW);
    const icons = computePaneLayout({ ...base, sidebarCollapsed: true, sidebarEdgeW: 44, paneCollapsed: true, paneEdgeW: 40 });
    expect(icons.docFlowW).toBe(1440 - 2 * DIVIDER_W - 2 * SHELL_EDGE - 44 - 40);
    // A narrow window's floor turns a hand-opened rail into a curtain (D18).
    const narrow = computePaneLayout({ ...base, winWidth: 1000, docMin: 700 });
    expect(narrow.docFlowW).toBe(700);
    expect(narrow.curtainActive).toBe(true);
    const full = computePaneLayout({ ...base, paneCollapsed: true, paneFullscreen: true, paneEdgeW: 40 });
    expect(full.docFlowW).toBe(1440 - DIVIDER_W - 2 * SHELL_EDGE - 240);
  });

  it("a hand-opened narrow rail curtains alone: the sidebar in its default pose stays in flow (D18)", () => {
    const l = computePaneLayout({ ...base, winWidth: 1000, paneWidth: 400, docMin: 700, overlayFirst: "pane" });
    expect(l.sidebarOverlayPx).toBe(0);
    expect(l.sidebarFlowW).toBe(240);
    expect(l.paneOverlayPx).toBeGreaterThan(0);
    // The default narrow pose (rail at its edge, no floor) never curtains.
    const rest = computePaneLayout({ ...base, winWidth: 900, paneCollapsed: true, paneEdgeW: 40 });
    expect(rest.curtainActive).toBe(false);
  });

  it("passes widths through untouched when the doc has room", () => {
    const l = computePaneLayout(base);
    expect(l.sidebarFlowW).toBe(240);
    expect(l.paneFlowW).toBe(320);
    expect(l.sidebarOverlayPx).toBe(0);
    expect(l.paneOverlayPx).toBe(0);
    expect(l.curtainActive).toBe(false);
    expect(l.docFlowW).toBe(1440 - 2 * DIVIDER_W - 2 * SHELL_EDGE - 240 - 320);
    expect(l.docVisibleW).toBe(l.docFlowW);
  });

  it("floors the doc at its minimum and turns the overage into curtain", () => {
    // Pane dragged so wide the doc would squish to ~100px.
    const l = computePaneLayout({ ...base, paneWidth: 1000 });
    expect(l.docFlowW).toBe(docMinFor(1440));
    expect(l.curtainActive).toBe(true);
    const available = 1440 - 2 * DIVIDER_W - 2 * SHELL_EDGE;
    const deficit = 240 + 1000 + docMinFor(1440) - available;
    expect(l.sidebarOverlayPx + l.paneOverlayPx).toBe(deficit);
    // The wide pane absorbs nearly all of it.
    expect(l.paneOverlayPx).toBeGreaterThan(l.sidebarOverlayPx);
    // Flow invariant: the row always fills the window exactly.
    expect(l.sidebarFlowW + l.paneFlowW + l.docFlowW).toBe(available);
  });

  it("caps each side's curtain at its own width", () => {
    const l = computePaneLayout({
      ...base,
      sidebarWidth: 200,
      paneWidth: 2000,
      winWidth: 900,
    });
    expect(l.sidebarOverlayPx).toBeLessThanOrEqual(200);
    expect(l.paneOverlayPx).toBeLessThanOrEqual(2000);
    const available = 900 - 2 * DIVIDER_W - 2 * SHELL_EDGE;
    expect(l.sidebarFlowW + l.paneFlowW + l.docFlowW).toBe(available);
    expect(l.docFlowW).toBe(docMinFor(900));
  });

  it("scales the doc floor to 20% of the window when that beats DOC_MIN", () => {
    expect(docMinFor(1000)).toBe(DOC_MIN); // 200 < 480 → absolute floor
    expect(docMinFor(3000)).toBe(Math.round(3000 * DOC_MIN_FRAC)); // 600
    // On a wide window the curtain engages while the doc is still 20% wide.
    const l = computePaneLayout({
      ...base,
      winWidth: 3000,
      sidebarWidth: 600,
      paneWidth: 2000,
    });
    expect(l.docFlowW).toBe(600);
    expect(l.curtainActive).toBe(true);
  });

  it("gives the stage its floor back from the columns before anything curtains (D38)", () => {
    const mins = { sidebarMin: 200, paneMin: 280 };
    // 1440: 360 + 600 + 2 seams leaves 478 — the rail gives 122 px.
    const l = computePaneLayout({ ...base, sidebarWidth: 360, paneWidth: 600, ...mins });
    expect(l.paneW).toBe(600 - (STAGE_MIN_W - 478));
    expect(l.sidebarW).toBe(360);
    expect(l.docFlowW).toBe(STAGE_MIN_W);
    expect(l.curtainActive).toBe(false);
    // The rail gives down to its minimum, then the sidebar down to its own.
    const tight = computePaneLayout({ ...base, winWidth: 1100, sidebarWidth: 400, paneWidth: 600, ...mins });
    expect(tight.paneW).toBe(280);
    expect(tight.sidebarW).toBe(1100 - 2 * DIVIDER_W - STAGE_MIN_W - 280);
    expect(tight.sidebarW).toBeGreaterThanOrEqual(200);
    expect(tight.curtainActive).toBe(false);
    // Neither ever draws below its minimum: what is left curtains.
    const floor = computePaneLayout({ ...base, winWidth: 900, sidebarWidth: 400, paneWidth: 600, ...mins });
    expect(floor.paneW).toBe(280);
    expect(floor.sidebarW).toBe(200);
    expect(floor.curtainActive).toBe(true);
    // A tab that asks more of the stage (D40) takes it the same way — and
    // where both columns at their minimums still leave it short, the rest
    // would curtain, which is why the poses fold first (workbench/poses.ts).
    const split = computePaneLayout({ ...base, stageMin: 900, ...mins });
    expect(split.docFlowW).toBe(900);
    expect(split.paneW).toBe(1440 - 2 * DIVIDER_W - 900 - 240);
    expect(split.sidebarW).toBe(240);
    expect(computePaneLayout({ ...base, stageMin: 1000, ...mins })).toMatchObject({ paneW: 280, sidebarW: 200, curtainActive: true });
    // A hand-opened narrow column curtains at its own width instead (D18).
    const narrow = computePaneLayout({ ...base, winWidth: 1000, paneWidth: 400, docMin: 700, overlayFirst: "pane", ...mins });
    expect(narrow.paneW).toBe(400);
    expect(narrow.paneOverlayPx).toBeGreaterThan(0);
  });

  it("collapsed panes contribute nothing and never curtain", () => {
    const l = computePaneLayout({
      ...base,
      sidebarCollapsed: true,
      paneWidth: 2000,
    });
    expect(l.sidebarFlowW).toBe(0);
    expect(l.sidebarOverlayPx).toBe(0);
    expect(l.paneOverlayPx).toBeGreaterThan(0);
  });

  it("a fullscreen discussion pane is opaque to the flow model", () => {
    const l = computePaneLayout({
      ...base,
      paneFullscreen: true,
      paneWidth: 2000,
    });
    expect(l.paneFlowW).toBe(0);
    expect(l.paneOverlayPx).toBe(0);
    // Only one divider in fullscreen.
    expect(l.docFlowW).toBe(1440 - DIVIDER_W - 2 * SHELL_EDGE - 240);
  });

  it("degrades gracefully on tiny windows with no negative widths", () => {
    const l = computePaneLayout({ ...base, winWidth: 200 });
    expect(l.docFlowW).toBeGreaterThanOrEqual(0);
    expect(l.docVisibleW).toBeGreaterThanOrEqual(0);
    expect(l.sidebarFlowW).toBeGreaterThanOrEqual(0);
    expect(l.paneFlowW).toBeGreaterThanOrEqual(0);
  });

  it("docVisibleW reaches 0 when curtains cover the whole floor", () => {
    const l = computePaneLayout({
      ...base,
      sidebarWidth: 800,
      paneWidth: 800,
      winWidth: 900,
    });
    expect(l.docVisibleW).toBe(0);
  });
});

describe("voicePaneMaxW", () => {
  it("caps at 60% of the column when the column is roomy", () => {
    // 1200 - 360 = 840, but 60% = 720 binds first.
    expect(voicePaneMaxW(1200)).toBe(720);
    expect(voicePaneMaxW(1200)).toBeLessThan(1200 - VOICE_DOC_MIN);
  });

  it("leaves the document its minimum strip once the column tightens", () => {
    // 60% of 800 = 480, but the doc floor allows only 440.
    expect(voicePaneMaxW(800)).toBe(800 - VOICE_DOC_MIN);
  });

  it("holds at the panel's hard stop once the doc floor stops fitting", () => {
    // 400px column: the doc floor would leave only 40px of panel, so the panel
    // holds at its 300 minimum and the document takes the squeeze instead.
    expect(voicePaneMaxW(400)).toBe(VOICE_PANE_MIN);
    // 700px is the other side of that trade: 340 of panel, 360 of document.
    expect(voicePaneMaxW(700)).toBe(700 - VOICE_DOC_MIN);
    expect(voicePaneMaxW(700)).toBeGreaterThan(VOICE_PANE_MIN);
  });

  it("degrades to the column width rather than overflowing it", () => {
    expect(voicePaneMaxW(200)).toBe(200);
    expect(voicePaneMaxW(0)).toBe(0);
    expect(voicePaneMaxW(-50)).toBe(0);
  });

  it("is monotonic — a wider column never allows a narrower panel", () => {
    let prev = -Infinity;
    for (let w = 0; w <= 2400; w += 10) {
      const max = voicePaneMaxW(w);
      expect(max).toBeGreaterThanOrEqual(prev);
      expect(max).toBeLessThanOrEqual(Math.max(w, VOICE_PANE_MIN));
      prev = max;
    }
  });
});

// The resting arrangement ⌘⇧0 returns to (and a fresh install's doors open
// onto). Reading prefs and the voice panel are outside this model on purpose.
describe("canonicalLayout", () => {
  it("derives the resting shape on a roomy window", () => {
    const c = canonicalLayout(1440, 900);
    expect(c.sidebarWidth).toBe(CANONICAL_SIDEBAR_W);
    expect(c.paneWidth).toBe(CANONICAL_PANE_W);
    expect(c.surface).toBe("document");
    expect(c.sidebarCollapsed).toBe(false);
    expect(c.paneCollapsed).toBe(false);
    expect(c.paneFullscreen).toBe(false);
  });

  it("honors in-range manifest overrides, rounded to px", () => {
    const c = canonicalLayout(1440, 900, {
      sidebar: 280.4,
      discussion: 360,
    });
    expect(c.sidebarWidth).toBe(280);
    expect(c.paneWidth).toBe(360);
  });

  it("off-range overrides fall back to defaults — leniency, not clamping", () => {
    const c = canonicalLayout(1440, 900, {
      sidebar: 5000, // typo-sized: > 60% of the window
      discussion: 40, // below any usable pane
    });
    expect(c.sidebarWidth).toBe(CANONICAL_SIDEBAR_W);
    expect(c.paneWidth).toBe(CANONICAL_PANE_W);
  });

  it("override range scales with the window it must fit", () => {
    // 700px wide: a 500px sidebar exceeds 60% and falls back.
    expect(canonicalLayout(700, 900, { sidebar: 500 }).sidebarWidth).toBe(
      CANONICAL_SIDEBAR_W,
    );
    // The same 500 is fine on a wide window.
    expect(canonicalLayout(1800, 900, { sidebar: 500 }).sidebarWidth).toBe(500);
  });
});

// The snap-back toggle's derived "am I already canonical?" check. Shape flags
// only — widths never flip the button's meaning from re-snap to close.
describe("isLayoutAtRest", () => {
  const atRest = (winH = 900): RestingShapeInput => {
    const c = canonicalLayout(1440, winH);
    return {
      sidebarCollapsed: c.sidebarCollapsed,
      paneCollapsed: c.paneCollapsed,
      paneFullscreen: c.paneFullscreen,
      surface: c.surface,
    };
  };

  it("matches the exact canonical shape", () => {
    expect(isLayoutAtRest(atRest(), canonicalLayout(1440, 900))).toBe(true);
  });

  it("any flipped shape flag breaks rest", () => {
    const canonical = canonicalLayout(1440, 900);
    const flips: Partial<RestingShapeInput>[] = [
      { sidebarCollapsed: true },
      { paneCollapsed: true },
      { paneFullscreen: true },
      // A tab with a surface in it, alone or tiled beside the plan, is not
      // the resting document.
      { surface: "browser" },
      { surface: "review" },
    ];
    for (const flip of flips) {
      expect(isLayoutAtRest({ ...atRest(), ...flip }, canonical)).toBe(false);
    }
  });
});
