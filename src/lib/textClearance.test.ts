// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { COLLAPSE_GAP, EXPAND_GAP, nextCollapsed } from "./textClearance";

// An expanded control's right edge, viewport px. The text edge moves; the
// control's layout position doesn't.
const CTRL_RIGHT = 126;

describe("nextCollapsed", () => {
  it("stays expanded while the text is comfortably clear", () => {
    expect(nextCollapsed(false, CTRL_RIGHT, CTRL_RIGHT + 200)).toBe(false);
    expect(nextCollapsed(false, CTRL_RIGHT, CTRL_RIGHT + COLLAPSE_GAP)).toBe(
      false,
    );
  });

  it("collapses once the text closes inside the collapse gap", () => {
    expect(
      nextCollapsed(false, CTRL_RIGHT, CTRL_RIGHT + COLLAPSE_GAP - 1),
    ).toBe(true);
    expect(nextCollapsed(false, CTRL_RIGHT, CTRL_RIGHT)).toBe(true);
  });

  it("collapses when the text has already overrun the control", () => {
    expect(nextCollapsed(false, CTRL_RIGHT, CTRL_RIGHT - 60)).toBe(true);
  });

  it("stays collapsed until the clearance passes the wider expand gap", () => {
    expect(nextCollapsed(true, CTRL_RIGHT, CTRL_RIGHT + EXPAND_GAP - 1)).toBe(
      true,
    );
    expect(nextCollapsed(true, CTRL_RIGHT, CTRL_RIGHT + EXPAND_GAP)).toBe(
      false,
    );
  });

  it("holds whichever state it is already in inside the anti-flap band", () => {
    // Same geometry, opposite answers — that is the whole point of the band.
    const textLeft = CTRL_RIGHT + (COLLAPSE_GAP + EXPAND_GAP) / 2;
    expect(nextCollapsed(false, CTRL_RIGHT, textLeft)).toBe(false);
    expect(nextCollapsed(true, CTRL_RIGHT, textLeft)).toBe(true);
  });

  it("keeps the band wide enough to absorb pointer jitter", () => {
    expect(EXPAND_GAP - COLLAPSE_GAP).toBeGreaterThanOrEqual(8);
  });
});
