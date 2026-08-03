// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  DOC_PAD_R_NARROW,
  DOC_PAD_R_WIDE,
  docControlFits,
} from "./docControl";

// The pane's right edge, as an arbitrary viewport coordinate.
const RIGHT = 1000;
// The control's measured widths: a row of − 100% + and the toggle, and the
// column it stacks into in wide view (22px buttons + 3px padding + 1px border).
const ROW_W = 118;
const COL_W = 30;

describe("docControlFits — normal (centred) view", () => {
  const narrow = (articleRight: number) =>
    docControlFits({
      articleRight,
      containerRight: RIGHT,
      padRight: DOC_PAD_R_NARROW,
      controlWidth: ROW_W,
    });

  it("fits while the centred column leaves a gutter", () => {
    // Article ends 300px short of the pane edge: acres of room.
    expect(narrow(RIGHT - 300)).toBe(true);
  });

  it("drops out once the text closes on it", () => {
    // A pane barely wider than the 820px measure — the article reaches the edge.
    expect(narrow(RIGHT)).toBe(false);
  });
});

describe("docControlFits — wide view", () => {
  // Wide view is full-bleed: the article's right edge IS the pane's right edge,
  // whatever the pane's width. The stacked control has to fit inside the
  // article's right padding at every one of them — the toggle back out of wide
  // view lives in this control, so hiding it would strand the mode.
  it("fits at any pane width", () => {
    const PANE_LEFT = 100;
    for (const width of [400, 700, 1200, 2400]) {
      const right = PANE_LEFT + width;
      expect(
        docControlFits({
          articleRight: right,
          containerRight: right,
          padRight: DOC_PAD_R_WIDE,
          controlWidth: COL_W,
        }),
        `pane ${width}px`,
      ).toBe(true);
    }
  });

  it("would NOT fit if it stayed a horizontal row — hence the stack", () => {
    expect(
      docControlFits({
        articleRight: RIGHT,
        containerRight: RIGHT,
        padRight: DOC_PAD_R_WIDE,
        controlWidth: ROW_W,
      }),
    ).toBe(false);
  });
});
