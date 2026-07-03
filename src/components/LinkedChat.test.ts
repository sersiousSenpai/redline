// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, it, expect } from "vitest";
import { tabChipLabel } from "./LinkedChat";

describe("tabChipLabel", () => {
  it("tags a user turn with its tab number and title", () => {
    expect(
      tabChipLabel({ role: "user", tabN: 2, tabTitle: "Example" }),
    ).toBe("🔗 tab 2 — Example");
  });

  it("shows just the tab number when the title is missing", () => {
    expect(tabChipLabel({ role: "user", tabN: 3, tabTitle: null })).toBe(
      "🔗 tab 3",
    );
  });

  it("falls back to 'You' for a user turn with no tab tag", () => {
    // The first turn can precede any tab context.
    expect(tabChipLabel({ role: "user", tabN: null, tabTitle: null })).toBe(
      "You",
    );
  });

  it("labels assistant turns 'Linked' regardless of tab fields", () => {
    expect(
      tabChipLabel({ role: "assistant", tabN: 5, tabTitle: "Docs" }),
    ).toBe("Linked");
  });
});
