// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  DIVIDER_W,
  DOC_MIN,
  DOC_MIN_FRAC,
  computePaneLayout,
  docMinFor,
  type PaneLayoutInput,
} from "./paneLayout";

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
    expect(l.docFlowW).toBe(1440 - 2 * DIVIDER_W - 240 - 320);
    expect(l.docVisibleW).toBe(l.docFlowW);
  });

  it("floors the doc at its minimum and turns the overage into curtain", () => {
    // Pane dragged so wide the doc would squish to ~100px.
    const l = computePaneLayout({ ...base, paneWidth: 1000 });
    expect(l.docFlowW).toBe(docMinFor(1440));
    expect(l.curtainActive).toBe(true);
    const available = 1440 - 2 * DIVIDER_W;
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
    const available = 900 - 2 * DIVIDER_W;
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
    expect(l.docFlowW).toBe(1440 - DIVIDER_W - 240);
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
