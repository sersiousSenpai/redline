// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  fitRibbon,
  GIVE_UP_ORDER,
  NEVER_HIDDEN,
  REVEAL_HYSTERESIS,
  type RibbonGroup,
} from "./ribbonFit";

// Natural (rendered) order, with plausible measured widths.
const GROUPS: RibbonGroup[] = [
  { id: "history", width: 70 },
  { id: "style", width: 130 },
  { id: "type", width: 150 },
  { id: "marks", width: 160 },
  { id: "color", width: 70 },
  { id: "align", width: 130 },
  { id: "lists", width: 110 },
  { id: "insert", width: 100 },
  { id: "clear", width: 36 },
  { id: "generate", width: 90 },
  { id: "mode", width: 100 },
  { id: "comments", width: 70 },
];
const FULL = GROUPS.reduce((n, g) => n + g.width, 0);

describe("the give-up order is one law", () => {
  it("aids before semantics, semantics before authorship", () => {
    const at = (id: string) => GIVE_UP_ORDER.indexOf(id as never);
    // Presentation that doesn't even survive the launch goes first.
    expect(at("color")).toBeLessThan(at("lists"));
    expect(at("align")).toBeLessThan(at("lists"));
    expect(at("type")).toBeLessThan(at("marks"));
    // Semantics before the paragraph structure that carries them.
    expect(at("lists")).toBeLessThan(at("style"));
    // Anything with a keystroke goes before anything without one: History is
    // ⌘Z, so it is the very last to leave.
    expect(at("history")).toBe(GIVE_UP_ORDER.length - 1);
  });

  it("never lists a group that must not be hidden", () => {
    for (const id of NEVER_HIDDEN) {
      expect(GIVE_UP_ORDER).not.toContain(id);
    }
  });
});

describe("fitRibbon", () => {
  it("hides nothing when everything fits", () => {
    const r = fitRibbon(GROUPS, FULL + 50);
    expect(r.overflow).toEqual([]);
    expect(r.visible).toHaveLength(GROUPS.length);
  });

  it("gives up in order as the pane narrows", () => {
    const wide = fitRibbon(GROUPS, FULL - 60).overflow;
    const mid = fitRibbon(GROUPS, FULL - 300).overflow;
    const tight = fitRibbon(GROUPS, 400).overflow;
    // Each stage is a prefix-extension of the last: nothing comes back as it
    // gets narrower, and nothing jumps the queue.
    expect(mid.slice(0, wide.length)).toEqual(wide);
    expect(tight.slice(0, mid.length)).toEqual(mid);
    expect(wide[0]).toBe("clear");
  });

  it("NEVER hides Editing/Suggesting, ✦ or Comments — at any width", () => {
    // The whole point. Two of these govern whether your keystrokes are being
    // tracked, and none has a keyboard equivalent or another entry point.
    for (const available of [800, 500, 300, 120, 40, 0]) {
      const r = fitRibbon(GROUPS, available);
      for (const id of NEVER_HIDDEN) {
        expect(r.visible, `${id} was hidden at ${available}px`).toContain(id);
        expect(r.overflow).not.toContain(id);
      }
    }
  });

  it("keeps the visible groups in their natural order, not give-up order", () => {
    const r = fitRibbon(GROUPS, FULL - 300);
    const natural = GROUPS.map((g) => g.id).filter((id) =>
      r.visible.includes(id),
    );
    expect(r.visible).toEqual(natural);
  });

  it("reserves room for the ⋯ button once anything overflows", () => {
    // Otherwise the last group hidden makes room for a button that then
    // doesn't fit, and the ribbon wraps to two rows anyway.
    const r = fitRibbon(GROUPS, 400, [], 34);
    const shown = GROUPS.filter((g) => r.visible.includes(g.id)).reduce(
      (n, g) => n + g.width,
      0,
    );
    expect(shown + 34).toBeLessThanOrEqual(400);
  });

  it("applies hysteresis so a divider drag doesn't flip-flop", () => {
    // A group needs MORE room to come back than it needed to stay. Sitting
    // exactly on the boundary is what makes a drag stutter.
    const g: RibbonGroup[] = [
      { id: "mode", width: 100 },
      { id: "clear", width: 40 },
    ];
    const boundary = 140;
    // Not previously hidden → it fits at exactly the boundary.
    expect(fitRibbon(g, boundary, []).overflow).toEqual([]);
    // Previously hidden → the same width is NOT enough to bring it back.
    expect(fitRibbon(g, boundary, ["clear"]).overflow).toEqual(["clear"]);
    // ...but the margin above it is.
    expect(
      fitRibbon(g, boundary + REVEAL_HYSTERESIS, ["clear"]).overflow,
    ).toEqual([]);
  });

  it("tolerates a group set that doesn't have every known id", () => {
    const r = fitRibbon([{ id: "mode", width: 100 }], 50);
    expect(r.visible).toEqual(["mode"]);
    expect(r.overflow).toEqual([]);
  });
});
