// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { NARROW_DOC_MIN, NO_NARROW_OPEN, narrowLayoutInputs, responsivePose, settleNarrowOpen } from "./poses";

const open = { sidebarCollapsed: false, paneCollapsed: false };

describe("responsive poses (D18)", () => {
  it("leaves a wide window to the preferences", () => {
    expect(responsivePose({ winWidth: 1440, ...open, narrowOpen: NO_NARROW_OPEN })).toMatchObject({ sidebarCollapsed: false, paneCollapsed: false });
    expect(responsivePose({ winWidth: 1440, sidebarCollapsed: true, paneCollapsed: true, narrowOpen: NO_NARROW_OPEN })).toMatchObject({ sidebarCollapsed: true, paneCollapsed: true });
  });
  it("folds the rail below 1100 px and the sidebar below 900 px", () => {
    expect(responsivePose({ winWidth: 1100, ...open, narrowOpen: NO_NARROW_OPEN })).toMatchObject({ paneCollapsed: false, railNarrow: false });
    expect(responsivePose({ winWidth: 1099, ...open, narrowOpen: NO_NARROW_OPEN })).toMatchObject({ paneCollapsed: true, sidebarCollapsed: false, railNarrow: true, sidebarNarrow: false });
    expect(responsivePose({ winWidth: 900, ...open, narrowOpen: NO_NARROW_OPEN })).toMatchObject({ sidebarCollapsed: false });
    expect(responsivePose({ winWidth: 899, ...open, narrowOpen: NO_NARROW_OPEN })).toMatchObject({ paneCollapsed: true, sidebarCollapsed: true });
  });
  it("keeps what the user opened while narrow, and forgets it once the window grows past the breakpoint", () => {
    const narrowOpen = { rail: true, sidebar: true };
    expect(responsivePose({ winWidth: 899, ...open, narrowOpen })).toMatchObject({ paneCollapsed: false, sidebarCollapsed: false });
    expect(settleNarrowOpen(narrowOpen, 1000)).toEqual({ rail: true, sidebar: false });
    expect(settleNarrowOpen(narrowOpen, 1200)).toEqual(NO_NARROW_OPEN);
    expect(settleNarrowOpen(narrowOpen, 800)).toBe(narrowOpen);
    // Back above the breakpoint the stored preference applies again: a rail
    // the user had folded stays folded, one they had open is open.
    expect(responsivePose({ winWidth: 1300, sidebarCollapsed: false, paneCollapsed: true, narrowOpen: settleNarrowOpen(narrowOpen, 1300) })).toMatchObject({ paneCollapsed: true });
  });
  it("floors the document only for a column opened by hand while narrow, and names it as the curtain", () => {
    const rest = responsivePose({ winWidth: 1000, ...open, narrowOpen: NO_NARROW_OPEN });
    expect(narrowLayoutInputs(rest, NO_NARROW_OPEN)).toEqual({});
    const railOpen = { rail: true, sidebar: false };
    const pose = responsivePose({ winWidth: 1000, ...open, narrowOpen: railOpen });
    expect(narrowLayoutInputs(pose, railOpen)).toEqual({ docMin: NARROW_DOC_MIN, overlayFirst: "pane" });
    const both = { rail: true, sidebar: true };
    expect(narrowLayoutInputs(responsivePose({ winWidth: 880, ...open, narrowOpen: both }), both)).toEqual({ docMin: NARROW_DOC_MIN, overlayFirst: undefined });
  });
});
