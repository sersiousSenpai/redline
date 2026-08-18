// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { shouldReveal, type EdgeRevealState } from "./useEdgeReveal";

const away: EdgeRevealState = {
  revealed: false,
  overRail: false,
  overChrome: false,
  menusOpen: 0,
};

describe("shouldReveal", () => {
  it("reveals the moment the pointer reaches the rail", () => {
    expect(shouldReveal({ ...away, overRail: true })).toBe(true);
  });

  it("stays hidden while the pointer is nowhere near the edge", () => {
    expect(shouldReveal(away)).toBe(false);
  });

  it("stays revealed while the pointer is on the chrome", () => {
    expect(
      shouldReveal({ ...away, revealed: true, overChrome: true }),
    ).toBe(true);
  });

  it("retracts once the pointer leaves the revealed chrome", () => {
    expect(shouldReveal({ ...away, revealed: true })).toBe(false);
  });

  // The one rule worth a test of its own: a dropdown hangs BELOW the header,
  // so the pointer moving into it has already left the header. Retracting
  // there would tear the menu out from under the pointer mid-click.
  it("never retracts while a menu is open", () => {
    expect(shouldReveal({ ...away, revealed: true, menusOpen: 1 })).toBe(true);
    expect(
      shouldReveal({ ...away, revealed: true, overChrome: false, menusOpen: 3 }),
    ).toBe(true);
  });

  it("an open menu cannot reveal chrome that is already hidden", () => {
    expect(shouldReveal({ ...away, menusOpen: 2 })).toBe(false);
  });

  // The rail is a momentary trigger: it unmounts the instant it works, so it
  // can never receive its own leave. Reaching it must reveal from any state.
  it("the rail reveals regardless of what else is true", () => {
    for (const revealed of [false, true]) {
      for (const overChrome of [false, true]) {
        for (const menusOpen of [0, 2]) {
          expect(
            shouldReveal({ revealed, overRail: true, overChrome, menusOpen }),
          ).toBe(true);
        }
      }
    }
  });
});
