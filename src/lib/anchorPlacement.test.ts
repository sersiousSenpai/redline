// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { placeByRect, type AnchorRect } from "./anchorPlacement";

// A 600×800 pane sitting 100px from the left of the window — deliberately NOT
// the viewport, because "the bounds are the pane" is one of the three things
// this module exists to fix.
const PANE: AnchorRect = { left: 100, top: 50, right: 700, bottom: 850 };
const SIZE = { width: 200, height: 40 };
const rect = (left: number, top: number, w = 80, h = 20): AnchorRect => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

describe("placeByRect — flip, don't clamp", () => {
  it("takes the preferred side when there is room", () => {
    const p = placeByRect(rect(200, 400), SIZE, { bounds: PANE });
    expect(p.side).toBe("above");
    expect(p.top).toBe(400 - 8 - 40);
  });

  it("FLIPS below when the anchor is near the top", () => {
    // The bug: every overlay did `Math.max(8, top - 36)`, which pins the panel
    // over the ribbon while still claiming to point at the paragraph.
    const p = placeByRect(rect(200, 60), SIZE, { bounds: PANE });
    expect(p.side).toBe("below");
    expect(p.top).toBe(80 + 8);
  });

  it("flips up when the preferred side is below and there is no room", () => {
    const p = placeByRect(rect(200, 830), SIZE, {
      bounds: PANE,
      prefer: "below",
    });
    expect(p.side).toBe("above");
  });

  it("picks the roomier side when neither fits", () => {
    const tiny: AnchorRect = { left: 0, top: 0, right: 400, bottom: 90 };
    // Anchor low in a very short pane: more room above than below.
    expect(placeByRect(rect(10, 70, 80, 15), SIZE, { bounds: tiny }).side).toBe(
      "above",
    );
    // ...and the mirror case.
    expect(
      placeByRect(rect(10, 5, 80, 15), SIZE, { bounds: tiny, prefer: "below" })
        .side,
    ).toBe("below");
  });
});

describe("placeByRect — the bounds are the pane", () => {
  it("keeps the overlay inside the pane, not merely inside the window", () => {
    // An anchor near the pane's right edge. Clamping to `window.innerWidth`
    // (what popover.tsx does, correctly, for header menus) would let this run
    // out over whatever sits beside the pane.
    const p = placeByRect(rect(650, 400), SIZE, { bounds: PANE });
    expect(p.left).toBe(700 - 200 - 8);
    expect(p.left + SIZE.width).toBeLessThanOrEqual(PANE.right);
  });

  it("never runs off the pane's left edge either", () => {
    const p = placeByRect(rect(0, 400), SIZE, { bounds: PANE });
    expect(p.left).toBe(PANE.left + 8);
  });

  it("degrades readably when the pane is narrower than the overlay", () => {
    const narrow: AnchorRect = { left: 0, top: 0, right: 120, bottom: 500 };
    const p = placeByRect(rect(10, 200), SIZE, { bounds: narrow });
    // Pin the overlay's own left edge on screen rather than inverting.
    expect(p.left).toBe(8);
  });
});

describe("placeByRect — the height budget", () => {
  // The fourth lie: a panel capping itself at `60vh` quotes a fraction of the
  // WINDOW, unrelated to the room left beside its anchor. A `position: fixed`
  // panel that overhangs cannot be scrolled back, so its last rows are simply
  // unreachable. These pin the number that replaces it.

  it("an anchor near the bottom either FITS below or flips above", () => {
    // 830 in a pane ending at 850: 20px of room. The old code put the panel at
    // `anchor.bottom + 6` regardless and let it hang off the edge.
    const p = placeByRect(rect(200, 830), SIZE, { bounds: PANE, prefer: "below" });
    if (p.side === "below") {
      expect(p.top + p.maxHeight).toBeLessThanOrEqual(PANE.bottom - 8);
    } else {
      expect(p.side).toBe("above");
    }
    expect(p.maxHeight).toBeGreaterThan(0);
  });

  it("an anchor near the top never places the panel above the bounds", () => {
    const p = placeByRect(rect(200, 60), SIZE, { bounds: PANE, prefer: "above" });
    expect(p.top).toBeGreaterThanOrEqual(PANE.top + 8);
    expect(p.maxHeight).toBeGreaterThan(0);
  });

  it("budgets the room on the side it actually landed on", () => {
    // Mid-pane, preferring above: roomAbove is 400 - 50 = 350, less gap and
    // margin. The budget describes the chosen side, not the roomier one.
    const up = placeByRect(rect(200, 400), SIZE, { bounds: PANE, prefer: "above" });
    expect(up.side).toBe("above");
    expect(up.maxHeight).toBe(350 - 8 - 8);

    const down = placeByRect(rect(200, 400), SIZE, { bounds: PANE, prefer: "below" });
    expect(down.side).toBe("below");
    // roomBelow = 850 - 420 = 430.
    expect(down.maxHeight).toBe(430 - 8 - 8);
  });

  it("never budgets a panel to nothing, even in a pane with no room", () => {
    // Both sides cramped: the viewport itself is the problem, and a scrollable
    // stub beats a zero-height panel.
    const tiny: AnchorRect = { left: 0, top: 0, right: 400, bottom: 60 };
    const p = placeByRect(rect(10, 20, 80, 20), SIZE, { bounds: tiny });
    expect(p.maxHeight).toBeGreaterThan(0);
  });
});

describe("placeByRect — visibility", () => {
  it("is visible while the anchor overlaps the pane", () => {
    expect(placeByRect(rect(200, 400), SIZE, { bounds: PANE }).visible).toBe(
      true,
    );
    // Partially scrolled off still counts — you can see what it points at.
    expect(placeByRect(rect(200, 40), SIZE, { bounds: PANE }).visible).toBe(
      true,
    );
  });

  it("is NOT visible once the anchor has scrolled out", () => {
    // The overlay must unmount, not hover at the edge pointing at nothing.
    expect(placeByRect(rect(200, -60, 80, 20), SIZE, { bounds: PANE }).visible).toBe(
      false,
    );
    expect(placeByRect(rect(200, 900), SIZE, { bounds: PANE }).visible).toBe(
      false,
    );
    expect(placeByRect(rect(-200, 400), SIZE, { bounds: PANE }).visible).toBe(
      false,
    );
  });

  it("reports a placement even when invisible — the caller decides", () => {
    // Returning null would force every call site to branch twice.
    const p = placeByRect(rect(200, 900), SIZE, { bounds: PANE });
    expect(Number.isFinite(p.left)).toBe(true);
    expect(Number.isFinite(p.top)).toBe(true);
  });
});
