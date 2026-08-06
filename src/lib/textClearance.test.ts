// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  COLLAPSE_GAP,
  EXPAND_GAP,
  nextCollapsed,
  nextStage,
  type ClearanceStage,
} from "./textClearance";

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

describe("nextStage", () => {
  // The drafter pill's real proportions, viewport px: the flat pill's right
  // edge, the rotated tab's (as wide as the pill is tall), the icon circle's.
  const EDGES: Record<ClearanceStage, number> = {
    full: 126,
    stowed: 46,
    icon: 32,
  };
  const at = (prev: ClearanceStage, deskLeft: number) =>
    nextStage(prev, deskLeft, EDGES);

  it("holds full while the desk clears it", () => {
    expect(at("full", EDGES.full + 200)).toBe("full");
    expect(at("full", EDGES.full + COLLAPSE_GAP)).toBe("full");
  });

  it("steps down to the widest stage that still clears", () => {
    // Full stops clearing → stowed (which clears comfortably here).
    expect(at("full", EDGES.full + COLLAPSE_GAP - 1)).toBe("stowed");
    // Stowed stops clearing too → icon.
    expect(at("full", EDGES.stowed + COLLAPSE_GAP - 1)).toBe("icon");
    expect(at("stowed", EDGES.stowed + COLLAPSE_GAP - 1)).toBe("icon");
  });

  it("lands on icon when nothing clears — the narrowest honest pose", () => {
    expect(at("full", EDGES.icon - 10)).toBe("icon");
    expect(at("icon", 0)).toBe("icon");
  });

  it("climbs back one rung only past the expand gap", () => {
    // icon → stowed
    expect(at("icon", EDGES.stowed + EXPAND_GAP - 1)).toBe("icon");
    expect(at("icon", EDGES.stowed + EXPAND_GAP)).toBe("stowed");
    // stowed → full
    expect(at("stowed", EDGES.full + EXPAND_GAP - 1)).toBe("stowed");
    expect(at("stowed", EDGES.full + EXPAND_GAP)).toBe("full");
    // icon straight to full when the pane snaps wide open.
    expect(at("icon", EDGES.full + EXPAND_GAP)).toBe("full");
  });

  it("holds its stage inside the anti-flap band, per rung", () => {
    // Same geometry, different answers depending on where it already is —
    // the two-state band's property, kept on every rung of the ladder.
    const midFull = EDGES.full + (COLLAPSE_GAP + EXPAND_GAP) / 2;
    expect(at("full", midFull)).toBe("full");
    expect(at("stowed", midFull)).toBe("stowed");
    const midStowed = EDGES.stowed + (COLLAPSE_GAP + EXPAND_GAP) / 2;
    expect(at("stowed", midStowed)).toBe("stowed");
    expect(at("icon", midStowed)).toBe("icon");
  });
});
