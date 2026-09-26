// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, it, expect } from "vitest";
import {
  WEBVIEW_PLATE_INSET,
  webviewSlotInset,
} from "./BrowserPane";
import { reorderTabs } from "../lib/browserTabDrag";

// The native webview is a square rect composited over the rounded document
// plate. The measured slot insets so the rect can never cross the plate's
// corner curve: with radius r, any inset ≥ r·(1−1/√2) clears it.
describe("webviewSlotInset", () => {
  it("uses the browser's edge-to-edge square frame", () => {
    expect(webviewSlotInset(false)).toBe(0);
    expect(WEBVIEW_PLATE_INSET).toBe(0);
  });

  it("drops the inset in fullscreen — a square takeover has no plate", () => {
    expect(webviewSlotInset(true)).toBe(0);
  });
});

// (The `clampChatRatio` band that kept the browser's own discussion split off
// zero width retired with the split itself: the four panels moved into the
// app's conversation dock, whose width is clamped by `voicePaneMaxW` — see
// paneLayout.test.ts, which carries the same guarantee for the whole app.)

describe("reorderTabs", () => {
  const ids = (ts: { id: string }[]) => ts.map((t) => t.id);
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}` }));

  it("drags a later tab onto an earlier slot (tab 9 → tab 2)", () => {
    // t9 lands where t2 was; everything from t2 shifts right by one.
    const out = reorderTabs(make(10), "t9", "t2");
    expect(ids(out)).toEqual([
      "t1", "t9", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t10",
    ]);
    // Positional: t9 is now the 2nd tab (index 1 → "tab 2").
    expect(out[1].id).toBe("t9");
  });

  it("drags an earlier tab into the requested later slot", () => {
    // t2 lands in the ninth slot, matching the drag preview.
    const out = reorderTabs(make(10), "t2", "t9");
    expect(ids(out)).toEqual([
      "t1", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t2", "t10",
    ]);
  });

  it("moves tab 1 into position 2 without needing to drag to position 3", () => {
    expect(ids(reorderTabs(make(3), "t1", "t2"))).toEqual(["t2", "t1", "t3"]);
    expect(ids(reorderTabs(make(3), "t1", "t3"))).toEqual(["t2", "t3", "t1"]);
  });

  it("is a no-op when dropped on itself or an unknown tab", () => {
    const tabs = make(3);
    expect(reorderTabs(tabs, "t2", "t2")).toBe(tabs);
    expect(reorderTabs(tabs, "t2", "nope")).toBe(tabs);
    expect(reorderTabs(tabs, "nope", "t2")).toBe(tabs);
  });

  it("preserves every tab (no drops/dupes) on a valid move", () => {
    const out = reorderTabs(make(6), "t5", "t1");
    expect([...ids(out)].sort()).toEqual(
      ["t1", "t2", "t3", "t4", "t5", "t6"].sort(),
    );
    expect(out[0].id).toBe("t5");
  });
});
