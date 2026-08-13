// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  CANONICAL_PANE_W,
  CANONICAL_SIDEBAR_W,
  CANONICAL_TERM_COLLAPSE_H,
  CANONICAL_TERM_MIN_H,
  DIVIDER_W,
  DOC_MIN,
  DOC_MIN_FRAC,
  SHELL_EDGE,
  SHELL_GUTTER,
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

// The shell's two constants are load-bearing for the plate look: the gutter is
// the divider (PaneDivider's box spans it) and the edge ring is constant <main>
// padding. Drag math reads them through computePaneLayout only.
describe("shell constants", () => {
  it("pins the gutter/divider identity and the edge ring", () => {
    expect(DIVIDER_W).toBe(SHELL_GUTTER);
    expect(SHELL_GUTTER).toBe(10);
    expect(SHELL_EDGE).toBe(10);
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
    expect(docMinFor(1000)).toBe(DOC_MIN); // 200 < 300 → absolute floor
    expect(docMinFor(2000)).toBe(Math.round(2000 * DOC_MIN_FRAC)); // 400
    // On a wide window the curtain engages while the doc is still 20% wide.
    const l = computePaneLayout({
      ...base,
      winWidth: 2000,
      sidebarWidth: 400,
      paneWidth: 1400,
    });
    expect(l.docFlowW).toBe(400);
    expect(l.curtainActive).toBe(true);
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
    expect(c.termHeight).toBe(270); // 30% of 900 beats the floor
    expect(c.termCollapsed).toBe(false);
    expect(c.surface).toBe("document");
    expect(c.docPinned).toBe(false);
    expect(c.splitRatio).toBe(0.5);
    expect(c.sidebarCollapsed).toBe(false);
    expect(c.paneCollapsed).toBe(false);
    expect(c.paneFullscreen).toBe(false);
    expect(c.termFullscreen).toBe(false);
  });

  it("floors the terminal where 30% gets too short", () => {
    expect(canonicalLayout(1440, 800).termHeight).toBe(CANONICAL_TERM_MIN_H);
  });

  it("folds the dock only under the collapse height", () => {
    expect(canonicalLayout(1440, CANONICAL_TERM_COLLAPSE_H).termCollapsed).toBe(
      false,
    );
    expect(
      canonicalLayout(1440, CANONICAL_TERM_COLLAPSE_H - 1).termCollapsed,
    ).toBe(true);
    // Folded, the height is still derived — expanding the dock later lands
    // on a sane size, not zero.
    expect(canonicalLayout(1440, 700).termHeight).toBe(CANONICAL_TERM_MIN_H);
  });

  it("honors in-range manifest overrides, rounded to px", () => {
    const c = canonicalLayout(1440, 900, {
      sidebar: 280.4,
      discussion: 360,
      terminal: 300,
    });
    expect(c.sidebarWidth).toBe(280);
    expect(c.paneWidth).toBe(360);
    expect(c.termHeight).toBe(300);
  });

  it("off-range overrides fall back to defaults — leniency, not clamping", () => {
    const c = canonicalLayout(1440, 900, {
      sidebar: 5000, // typo-sized: > 60% of the window
      discussion: 40, // below any usable pane
      terminal: Number.NaN,
    });
    expect(c.sidebarWidth).toBe(CANONICAL_SIDEBAR_W);
    expect(c.paneWidth).toBe(CANONICAL_PANE_W);
    expect(c.termHeight).toBe(270);
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
      termCollapsed: c.termCollapsed,
      termFullscreen: c.termFullscreen,
      docPinned: c.docPinned,
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
      { termCollapsed: true },
      { termFullscreen: true },
      { docPinned: true },
      { surface: "browser" },
    ];
    for (const flip of flips) {
      expect(isLayoutAtRest({ ...atRest(), ...flip }, canonical)).toBe(false);
    }
  });

  it("tracks the short-window canonical, where the dock folds", () => {
    const winH = CANONICAL_TERM_COLLAPSE_H - 1;
    const canonical = canonicalLayout(1440, winH);
    // Canonical itself folds the terminal here, so a collapsed dock IS rest…
    expect(isLayoutAtRest(atRest(winH), canonical)).toBe(true);
    expect(atRest(winH).termCollapsed).toBe(true);
    // …and an open one is not.
    expect(
      isLayoutAtRest({ ...atRest(winH), termCollapsed: false }, canonical),
    ).toBe(false);
  });
});
