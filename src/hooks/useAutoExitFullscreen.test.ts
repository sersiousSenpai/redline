// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { PaneLayoutInput } from "../lib/paneLayout";
import { shouldExitFullscreen } from "./useAutoExitFullscreen";

// A fullscreen discussion on a mid-size window with the sidebar open.
const fullscreenBase: PaneLayoutInput = {
  winWidth: 800,
  sidebarWidth: 240,
  sidebarCollapsed: false,
  paneWidth: 400,
  paneCollapsed: false,
  paneFullscreen: true,
};

describe("shouldExitFullscreen", () => {
  it("exits when collapsing the sidebar frees enough room", () => {
    // 800 - 20 dividers - 20 edge ring - 400 pane = 360 ≥ DOC_MIN → fits.
    const next = { ...fullscreenBase, sidebarCollapsed: true };
    expect(
      shouldExitFullscreen(
        { sidebarCollapsed: false, winWidth: 800 },
        next,
        true,
      ),
    ).toBe(true);
  });

  it("stays fullscreen when the window is too narrow even without a sidebar", () => {
    const next = {
      ...fullscreenBase,
      winWidth: 600,
      sidebarCollapsed: true,
    };
    // 600 - 20 - 20 - 400 = 160 < DOC_MIN → the pane still wouldn't fit beside.
    expect(
      shouldExitFullscreen(
        { sidebarCollapsed: false, winWidth: 600 },
        next,
        true,
      ),
    ).toBe(false);
  });

  it("exits when the window grows past the threshold", () => {
    const next = { ...fullscreenBase, winWidth: 1400 };
    expect(
      shouldExitFullscreen(
        { sidebarCollapsed: false, winWidth: 800 },
        next,
        true,
      ),
    ).toBe(true);
  });

  it("never exits without a freeing transition, even with plenty of space", () => {
    const next = { ...fullscreenBase, winWidth: 2000 };
    expect(
      shouldExitFullscreen(
        { sidebarCollapsed: false, winWidth: 2000 },
        next,
        true,
      ),
    ).toBe(false);
  });

  it("is a no-op while not fullscreen", () => {
    const next = { ...fullscreenBase, sidebarCollapsed: true };
    expect(
      shouldExitFullscreen(
        { sidebarCollapsed: false, winWidth: 800 },
        next,
        false,
      ),
    ).toBe(false);
  });
});
