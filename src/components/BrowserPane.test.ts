// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, it, expect } from "vitest";
import { clampChatRatio, reorderTabs } from "./BrowserPane";

// Regression: a prior build let the discussion divider fold all the way to the
// edge, persisting `redline.browser.chatRatio = 1`. That gave the browser slot
// 100% and the discussion pane 0 width, so clicking 💬 / 🎯 / 🔗 mounted the
// panel but it was invisible ("the discussion won't open"). The clamp keeps the
// ratio in a visible band and self-heals such a persisted value.
describe("clampChatRatio", () => {
  it("self-heals a fully-folded persisted ratio so the chat pane stays visible", () => {
    expect(clampChatRatio(1)).toBe(0.8); // was folding the chat to 0 width
    expect(clampChatRatio(0)).toBe(0.2);
  });

  it("leaves a comfortable in-band ratio untouched", () => {
    expect(clampChatRatio(0.62)).toBe(0.62);
    expect(clampChatRatio(0.5)).toBe(0.5);
  });

  it("clamps near-fold drags to the band edges", () => {
    expect(clampChatRatio(0.97)).toBe(0.8);
    expect(clampChatRatio(0.03)).toBe(0.2);
  });

  it("falls back to the default for a NaN/garbage value", () => {
    expect(clampChatRatio(NaN)).toBe(0.62);
    expect(clampChatRatio(Number.POSITIVE_INFINITY)).toBe(0.62);
  });
});

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

  it("drags an earlier tab toward a later slot", () => {
    // t2 inserts just before t9.
    const out = reorderTabs(make(10), "t2", "t9");
    expect(ids(out)).toEqual([
      "t1", "t3", "t4", "t5", "t6", "t7", "t8", "t2", "t9", "t10",
    ]);
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
