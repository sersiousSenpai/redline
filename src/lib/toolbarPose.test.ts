// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  TOOLBAR_COMPACT_AT,
  TOOLBAR_FULL_AT,
  toolbarPose,
  type ToolbarPose,
} from "./toolbarPose";

describe("toolbarPose", () => {
  it("sheds its words in a narrow column and takes them back in a wide one", () => {
    expect(toolbarPose(360, "full")).toBe("compact");
    expect(toolbarPose(900, "compact")).toBe("full");
  });

  it("holds its pose inside the band", () => {
    // The band is the anti-flap: a drag that crosses one threshold must not
    // immediately re-cross the other.
    for (const w of [TOOLBAR_COMPACT_AT, 440, TOOLBAR_FULL_AT - 1]) {
      expect(toolbarPose(w, "compact")).toBe("compact");
      expect(toolbarPose(w, "full")).toBe("full");
    }
  });

  it("a slow drag across the band settles instead of oscillating", () => {
    let pose: ToolbarPose = "full";
    const seen: ToolbarPose[] = [];
    for (const w of [470, 455, 440, 425, 415, 425, 440, 455, 465, 470]) {
      pose = toolbarPose(w, pose);
      seen.push(pose);
    }
    // One trip down and one back up — never a frame-by-frame flip.
    expect(seen).toEqual([
      // 470 455 440 425 — the band holds the pose it arrived with…
      "full", "full", "full", "full",
      // …415 crosses the low threshold, and 425 440 455 stay put on the way
      // back up because taking the words back needs 460, not 420.
      "compact", "compact", "compact", "compact",
      "full", "full",
    ]);
  });

  it("an unmeasured element keeps the pose it had", () => {
    // A `getBoundingClientRect` before layout reports 0; flashing compact for
    // that frame is a visible twitch on every mount.
    expect(toolbarPose(0, "full")).toBe("full");
    expect(toolbarPose(0, "compact")).toBe("compact");
    expect(toolbarPose(NaN, "full")).toBe("full");
    expect(toolbarPose(-10, "full")).toBe("full");
  });
});
