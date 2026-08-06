// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  GLOBAL_KEYMAP,
  REVIEW_KEYMAP,
  bindingKeys,
  globalShortcutGroups,
  isPaletteKey,
  isSnapBackKey,
  tourShortcuts,
} from "./keymap";

function combo(over: Partial<Parameters<typeof isPaletteKey>[0]> = {}) {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  };
}

describe("isPaletteKey", () => {
  it("matches ⌘K and Ctrl+K, either case", () => {
    expect(isPaletteKey(combo({ key: "k", metaKey: true }))).toBe(true);
    expect(isPaletteKey(combo({ key: "K", metaKey: true }))).toBe(true);
    expect(isPaletteKey(combo({ key: "k", ctrlKey: true }))).toBe(true);
  });
  it("requires a command modifier and rejects shift/alt variants", () => {
    expect(isPaletteKey(combo({ key: "k" }))).toBe(false);
    expect(
      isPaletteKey(combo({ key: "K", metaKey: true, shiftKey: true })),
    ).toBe(false);
    expect(
      isPaletteKey(combo({ key: "k", metaKey: true, altKey: true })),
    ).toBe(false);
  });
  it("ignores other keys", () => {
    expect(isPaletteKey(combo({ key: "j", metaKey: true }))).toBe(false);
  });
});

describe("isSnapBackKey", () => {
  it("matches ⌘⇧0 via e.code (Shift rewrites e.key on US layouts)", () => {
    expect(
      isSnapBackKey(
        combo({ key: ")", code: "Digit0", metaKey: true, shiftKey: true }),
      ),
    ).toBe(true);
    expect(
      isSnapBackKey(
        combo({ key: "0", code: "Digit0", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
  });
  it("leaves plain ⌘0 (zoom reset) and bare ⇧0 alone", () => {
    expect(
      isSnapBackKey(combo({ key: "0", code: "Digit0", metaKey: true })),
    ).toBe(false);
    expect(
      isSnapBackKey(combo({ key: ")", code: "Digit0", shiftKey: true })),
    ).toBe(false);
  });
});

describe("the registry", () => {
  it("has unique ids", () => {
    const ids = GLOBAL_KEYMAP.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("wires exactly the two A5 globals — everything else is documentation", () => {
    expect(
      GLOBAL_KEYMAP.filter((b) => b.wired).map((b) => b.id).sort(),
    ).toEqual(["palette", "snap-back"]);
  });
  it("every binding renders: non-empty caps and label", () => {
    for (const b of GLOBAL_KEYMAP) {
      expect(b.keys.length).toBeGreaterThan(0);
      expect(b.keys.every((k) => k.length > 0)).toBe(true);
      expect(b.label.length).toBeGreaterThan(0);
    }
  });
  it("bindingKeys finds a binding by id", () => {
    expect(bindingKeys("palette")).toEqual(["⌘", "K"]);
    expect(bindingKeys("nope")).toBeUndefined();
  });
});

describe("renderings", () => {
  it("tourShortcuts covers the whole registry in order", () => {
    const rows = tourShortcuts();
    expect(rows.map((r) => r.text)).toEqual(GLOBAL_KEYMAP.map((b) => b.label));
    expect(rows[0].keys).toEqual(["⌘", "K"]);
  });
  it("globalShortcutGroups partitions the registry without losing entries", () => {
    const groups = globalShortcutGroups();
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    expect(total).toBe(GLOBAL_KEYMAP.length);
    // ShortcutHelp splits on spaces — caps must survive the round-trip.
    const snap = groups
      .flatMap((g) => g.items)
      .find((i) => i.label === "Snap the layout back");
    expect(snap?.keys.split(" ")).toEqual(["⌘", "⇧", "0"]);
  });
  it("the review cheat sheet keeps its three sections", () => {
    expect(REVIEW_KEYMAP.map((g) => g.title)).toEqual([
      "Files",
      "Annotations",
      "Review",
    ]);
    for (const g of REVIEW_KEYMAP) expect(g.items.length).toBeGreaterThan(0);
  });
});
