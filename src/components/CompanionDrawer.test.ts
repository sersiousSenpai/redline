// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { surfaceChipLabel } from "./CompanionDrawer";

describe("surfaceChipLabel", () => {
  it("assistant turns are just Companion", () => {
    expect(
      surfaceChipLabel({ role: "assistant", surfaceKind: "plan", surfaceLabel: "X" }),
    ).toBe("Companion");
  });

  it("user turns name the surface and its label", () => {
    expect(
      surfaceChipLabel({
        role: "user",
        surfaceKind: "plan",
        surfaceLabel: "My plan",
      }),
    ).toBe("🧭 plan — My plan");
    expect(
      surfaceChipLabel({ role: "user", surfaceKind: "drafter", surfaceLabel: null }),
    ).toBe("🧭 drafter");
    expect(
      surfaceChipLabel({ role: "user", surfaceKind: "welcome", surfaceLabel: null }),
    ).toBe("🧭 home");
  });

  it("a turn with no surface tag falls back to You", () => {
    expect(
      surfaceChipLabel({ role: "user", surfaceKind: null, surfaceLabel: null }),
    ).toBe("You");
  });
});
