// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it } from "vitest";
import { saveHoldKey } from "../audio/holdKey";
import {
  GLOBAL_KEYMAP,
  REVIEW_KEYMAP,
  bindingKeys,
  globalShortcutGroups,
  isDockKey,
  isFrontDoorKey,
  isNeedsYouKey,
  isNewPlanKey,
  isNewSessionKey,
  isPaletteKey,
  isPlanPanelKey,
  isSidebarKey,
  isSnapBackKey,
  isStageKey,
  FLOW_KEYMAP,
  shellKeymap,
  shownKeymap,
  toolKeyOf,
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

describe("isNewPlanKey", () => {
  it("matches ⌘⇧N and Ctrl+⇧N via e.code", () => {
    expect(
      isNewPlanKey(combo({ key: "N", code: "KeyN", metaKey: true, shiftKey: true })),
    ).toBe(true);
    expect(
      isNewPlanKey(combo({ key: "n", code: "KeyN", ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });
  it("leaves plain ⌘N alone — macOS and Tauri read it as 'new window'", () => {
    expect(isNewPlanKey(combo({ key: "n", code: "KeyN", metaKey: true }))).toBe(
      false,
    );
  });
  it("requires a command modifier, and ⌥ opts out", () => {
    expect(isNewPlanKey(combo({ key: "N", code: "KeyN", shiftKey: true }))).toBe(
      false,
    );
    expect(
      isNewPlanKey(
        combo({ code: "KeyN", metaKey: true, shiftKey: true, altKey: true }),
      ),
    ).toBe(false);
  });
});

describe("isDockKey", () => {
  it("matches ⌘J and Ctrl+J", () => {
    expect(isDockKey(combo({ key: "j", metaKey: true }))).toBe(true);
    expect(isDockKey(combo({ key: "J", ctrlKey: true }))).toBe(true);
  });
  it("leaves ⌘⇧J and ⌥⌘J free", () => {
    expect(isDockKey(combo({ key: "j", metaKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(isDockKey(combo({ key: "j", metaKey: true, altKey: true }))).toBe(
      false,
    );
  });
  it("a bare J is a keystroke, not a command", () => {
    expect(isDockKey(combo({ key: "j" }))).toBe(false);
  });
});

describe("isNeedsYouKey", () => {
  it("matches ⌘⇧J and Ctrl+⇧J via e.code (Shift rewrites e.key)", () => {
    expect(isNeedsYouKey(combo({ key: "J", code: "KeyJ", metaKey: true, shiftKey: true }))).toBe(true);
    expect(isNeedsYouKey(combo({ key: "J", code: "KeyJ", ctrlKey: true, shiftKey: true }))).toBe(true);
  });
  it("leaves ⌘J (the front door), ⌥⌘⇧J and a bare ⇧J alone — and never both with ⌘J", () => {
    const plain = combo({ key: "j", code: "KeyJ", metaKey: true });
    expect(isNeedsYouKey(plain)).toBe(false);
    expect(isDockKey(plain)).toBe(true);
    const shifted = combo({ key: "J", code: "KeyJ", metaKey: true, shiftKey: true });
    expect(isDockKey(shifted)).toBe(false);
    expect(isNeedsYouKey(combo({ key: "J", code: "KeyJ", metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isNeedsYouKey(combo({ key: "J", code: "KeyJ", shiftKey: true }))).toBe(false);
  });
});

describe("isFrontDoorKey", () => {
  it("matches Shift+Enter while leaving Enter and modified sends alone", () => {
    expect(isFrontDoorKey(combo({ key: "Enter", shiftKey: true }))).toBe(true);
    for (const extra of [{ shiftKey: false }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { key: "j" }]) {
      expect(isFrontDoorKey(combo({ key: "Enter", shiftKey: true, ...extra }))).toBe(false);
    }
  });
});

describe("the registry", () => {
  it("has unique ids", () => {
    const ids = GLOBAL_KEYMAP.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("wires exactly the globals this module dispatches — the rest is documentation", () => {
    expect(
      GLOBAL_KEYMAP.filter((b) => b.wired).map((b) => b.id).sort(),
    ).toEqual(["dock", "front-door", "needs-you", "new-plan", "palette", "snap-back"]);
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
  describe("the dictation key", () => {
    afterEach(() => saveHoldKey("AltRight"));
    const dictate = () => tourShortcuts().find((r) => r.text.startsWith("Dictate"));

    it("is the hold key Voice settings chose, one cap for the key", () => {
      expect(dictate()?.keys).toEqual(["hold", "right\u00a0⌥"]);
      saveHoldKey("MetaRight");
      expect(dictate()?.keys).toEqual(["hold", "right\u00a0⌘"]);
      saveHoldKey("ControlRight");
      expect(dictate()?.keys).toEqual(["hold", "right\u00a0⌃"]);
      const caps = globalShortcutGroups()
        .flatMap((g) => g.items)
        .find((i) => i.label.startsWith("Dictate"))!
        .keys.split(" ");
      expect(caps).toEqual(["hold", "right\u00a0⌃"]);
    });

    it("is left out while dictating by key is off", () => {
      saveHoldKey("off");
      expect(dictate()).toBeUndefined();
      expect(shownKeymap().map((b) => b.id)).not.toContain("dictate");
      expect(globalShortcutGroups().flatMap((g) => g.items)).toHaveLength(GLOBAL_KEYMAP.length - 1);
      // The registry itself still documents it.
      expect(bindingKeys("dictate")).toEqual(["hold", "right\u00a0⌥"]);
    });
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

describe("the flow shell's keys (deviation 5)", () => {
  it("⌘J, ⌘B, ⌘⌥B, ⌘N and ⌘1–4 match on ⌘ alone", () => {
    expect(isStageKey(combo({ key: "j", code: "KeyJ", metaKey: true }))).toBe(true);
    expect(isSidebarKey(combo({ key: "b", code: "KeyB", metaKey: true }))).toBe(true);
    // ⌥ rewrites e.key on a Mac: the plan panel matches on the physical key.
    expect(isPlanPanelKey(combo({ key: "∫", code: "KeyB", metaKey: true, altKey: true }))).toBe(true);
    expect(isNewSessionKey(combo({ key: "n", code: "KeyN", metaKey: true }))).toBe(true);
    expect([1, 2, 3, 4].map((n) => toolKeyOf(combo({ key: String(n), code: `Digit${n}`, metaKey: true })))).toEqual([1, 2, 3, 4]);
  });

  it("never takes a Ctrl chord — in a terminal Ctrl+J is a newline and Ctrl+B is back-a-char", () => {
    expect(isStageKey(combo({ key: "j", ctrlKey: true }))).toBe(false);
    expect(isSidebarKey(combo({ key: "b", ctrlKey: true }))).toBe(false);
    expect(isPlanPanelKey(combo({ code: "KeyB", ctrlKey: true, altKey: true }))).toBe(false);
    expect(isNewSessionKey(combo({ key: "n", ctrlKey: true }))).toBe(false);
    expect(toolKeyOf(combo({ key: "1", ctrlKey: true }))).toBeNull();
    // ⌘ and Ctrl together is neither.
    expect(isStageKey(combo({ key: "j", metaKey: true, ctrlKey: true }))).toBe(false);
  });

  it("keeps the neighbouring chords apart", () => {
    // ⌘⇧J is the needs-you jump; ⌘⇧N the old new-plan alias.
    expect(isStageKey(combo({ key: "J", code: "KeyJ", metaKey: true, shiftKey: true }))).toBe(false);
    expect(isNewSessionKey(combo({ key: "N", code: "KeyN", metaKey: true, shiftKey: true }))).toBe(false);
    expect(isNewPlanKey(combo({ key: "N", code: "KeyN", metaKey: true, shiftKey: true }))).toBe(true);
    // ⌘B and ⌘⌥B never both.
    const plain = combo({ key: "b", code: "KeyB", metaKey: true });
    const alt = combo({ key: "∫", code: "KeyB", metaKey: true, altKey: true });
    expect([isSidebarKey(plain), isPlanPanelKey(plain)]).toEqual([true, false]);
    expect([isSidebarKey(alt), isPlanPanelKey(alt)]).toEqual([false, true]);
    expect(toolKeyOf(combo({ key: "5", metaKey: true }))).toBeNull();
    expect(toolKeyOf(combo({ key: "1", metaKey: true, shiftKey: true }))).toBeNull();
  });

  it("the flow registry swaps the replaced chords for its own and loses nothing else", () => {
    const ids = FLOW_KEYMAP.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["new-session", "stage", "tools", "sidebar", "plan-panel"]) expect(ids).toContain(id);
    for (const id of ["dock", "new-plan", "pane-sidebar"]) expect(ids).not.toContain(id);
    const kept = GLOBAL_KEYMAP.filter((b) => !["dock", "new-plan", "pane-sidebar"].includes(b.id)).map((b) => b.id);
    expect(ids.filter((id) => kept.includes(id)).sort()).toEqual([...kept].sort());
    expect(FLOW_KEYMAP.find((b) => b.id === "stage")?.keys).toEqual(["⌘", "J"]);
    expect(FLOW_KEYMAP.find((b) => b.id === "plan-panel")?.keys).toEqual(["⌘", "⌥", "B"]);
  });

  it("the classic shell keeps its registry exactly", () => {
    expect(shellKeymap("classic")).toBe(GLOBAL_KEYMAP);
    expect(shellKeymap("flow")).toBe(FLOW_KEYMAP);
    // Tests paint classic: nothing flow-only is shown or hinted.
    expect(shownKeymap().map((b) => b.id)).not.toContain("stage");
    expect(bindingKeys("dock")).toEqual(["⌘", "J"]);
    expect(bindingKeys("stage")).toBeUndefined();
  });
});
