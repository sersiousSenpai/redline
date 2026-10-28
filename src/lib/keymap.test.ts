// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it } from "vitest";
import { saveHoldKey } from "../audio/holdKey";
import {
  CLASSIC_KEYMAP,
  GLOBAL_KEYMAP,
  REVIEW_KEYMAP,
  WORKBENCH_KEYMAP,
  bindingKeys,
  globalShortcutGroups,
  isCloseKey,
  isCloseWindowKey,
  isDockKey,
  isFrontDoorKey,
  isNeedsYouKey,
  isNewPlanKey,
  isNewTabKey,
  isPaletteKey,
  isReopenTabKey,
  isSnapBackKey,
  shellKeymap,
  shownKeymap,
  tabCycleKeyOf,
  tabIndexKeyOf,
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
  it("has unique ids across the classic registry", () => {
    const ids = CLASSIC_KEYMAP.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(GLOBAL_KEYMAP.length + WORKBENCH_KEYMAP.length);
  });
  it("wires exactly the globals this module dispatches — the rest is documentation", () => {
    expect(
      GLOBAL_KEYMAP.filter((b) => b.wired).map((b) => b.id).sort(),
    ).toEqual(["dock", "front-door", "needs-you", "new-plan", "palette", "snap-back"]);
    expect(WORKBENCH_KEYMAP.every((b) => b.wired)).toBe(true);
  });
  it("every binding renders: non-empty caps and label", () => {
    for (const b of CLASSIC_KEYMAP) {
      expect(b.keys.length).toBeGreaterThan(0);
      expect(b.keys.every((k) => k.length > 0)).toBe(true);
      expect(b.label.length).toBeGreaterThan(0);
    }
  });
  it("bindingKeys finds a binding by id", () => {
    expect(bindingKeys("palette")).toEqual(["⌘", "K"]);
    expect(bindingKeys("new-tab")).toEqual(["⌘", "T"]);
    expect(bindingKeys("nope")).toBeUndefined();
  });
});

describe("renderings", () => {
  it("tourShortcuts covers the whole registry in order", () => {
    const rows = tourShortcuts();
    expect(rows.map((r) => r.text)).toEqual(CLASSIC_KEYMAP.map((b) => b.label));
    expect(rows[0].keys).toEqual(["⌘", "K"]);
  });
  it("globalShortcutGroups partitions the registry without losing entries", () => {
    const groups = globalShortcutGroups();
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    expect(total).toBe(CLASSIC_KEYMAP.length);
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
      expect(globalShortcutGroups().flatMap((g) => g.items)).toHaveLength(CLASSIC_KEYMAP.length - 1);
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

describe("the registry", () => {
  it("the registry is the global one merged with the workbench's", () => {
    expect(shellKeymap()).toBe(CLASSIC_KEYMAP);
    // Nothing of the classic registry is lost, and within a group nothing is
    // reordered (the merge groups Global ahead of Layout).
    for (const group of ["Global", "Layout", "Document"] as const) {
      const merged = CLASSIC_KEYMAP.filter((b) => b.group === group && GLOBAL_KEYMAP.includes(b)).map((b) => b.id);
      expect(merged).toEqual(GLOBAL_KEYMAP.filter((b) => b.group === group).map((b) => b.id));
    }
    expect(bindingKeys("dock")).toEqual(["⌘", "J"]);
    expect(bindingKeys("stage")).toBeUndefined();
  });
});

describe("the workbench's keys (W1)", () => {
  const cmd = (over: Parameters<typeof combo>[0]) => combo({ metaKey: true, ...over });

  it("⌘T, ⌘⇧T, ⌘W and ⌘⇧W match on the physical key", () => {
    expect(isNewTabKey(cmd({ key: "t", code: "KeyT" }))).toBe(true);
    expect(isReopenTabKey(cmd({ key: "T", code: "KeyT", shiftKey: true }))).toBe(true);
    expect(isCloseKey(cmd({ key: "w", code: "KeyW" }))).toBe(true);
    expect(isCloseWindowKey(cmd({ key: "W", code: "KeyW", shiftKey: true }))).toBe(true);
    // A non-US layout: the physical key decides, not the character.
    expect(isNewTabKey(cmd({ key: "е", code: "KeyT" }))).toBe(true);
  });

  it("⌘1–⌘8 are tab indices 0..7 and ⌘9 is the last tab", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => tabIndexKeyOf(cmd({ key: String(n), code: `Digit${n}` })))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(tabIndexKeyOf(cmd({ key: "9", code: "Digit9" }))).toBe(-1);
    expect(tabIndexKeyOf(cmd({ key: "0", code: "Digit0" }))).toBeNull();
    expect(tabIndexKeyOf(cmd({ key: "1", code: "Numpad1" }))).toBeNull();
  });

  it("⌘⌥← / ⌘⌥→ and ⌘⇧[ / ⌘⇧] cycle −1 / +1", () => {
    expect(tabCycleKeyOf(cmd({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }))).toBe(-1);
    expect(tabCycleKeyOf(cmd({ key: "ArrowRight", code: "ArrowRight", altKey: true }))).toBe(1);
    // ⇧ rewrites e.key ("[" → "{"): the code decides.
    expect(tabCycleKeyOf(cmd({ key: "{", code: "BracketLeft", shiftKey: true }))).toBe(-1);
    expect(tabCycleKeyOf(cmd({ key: "}", code: "BracketRight", shiftKey: true }))).toBe(1);
  });

  it("never takes a Ctrl chord — in a terminal Ctrl+T, Ctrl+W and Ctrl+[ are the shell's", () => {
    expect(isNewTabKey(combo({ key: "t", code: "KeyT", ctrlKey: true }))).toBe(false);
    expect(isReopenTabKey(combo({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isCloseKey(combo({ key: "w", code: "KeyW", ctrlKey: true }))).toBe(false);
    expect(isCloseWindowKey(combo({ key: "W", code: "KeyW", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(tabIndexKeyOf(combo({ key: "1", code: "Digit1", ctrlKey: true }))).toBeNull();
    expect(tabCycleKeyOf(combo({ code: "BracketLeft", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(tabCycleKeyOf(combo({ code: "ArrowLeft", ctrlKey: true, altKey: true }))).toBeNull();
    // ⌘ and Ctrl together is neither.
    expect(isNewTabKey(combo({ key: "t", code: "KeyT", metaKey: true, ctrlKey: true }))).toBe(false);
    expect(tabIndexKeyOf(combo({ key: "1", code: "Digit1", metaKey: true, ctrlKey: true }))).toBeNull();
    // And a bare key is a keystroke, not a command.
    expect(isCloseKey(combo({ key: "w", code: "KeyW" }))).toBe(false);
    expect(tabCycleKeyOf(combo({ code: "ArrowLeft", altKey: true }))).toBeNull();
  });

  it("keeps the neighbouring chords apart", () => {
    // ⌘T vs ⌘⇧T vs ⌘⇧N: never two at once.
    const t = cmd({ key: "t", code: "KeyT" });
    const shiftT = cmd({ key: "T", code: "KeyT", shiftKey: true });
    const shiftN = cmd({ key: "N", code: "KeyN", shiftKey: true });
    expect([isNewTabKey(t), isReopenTabKey(t), isNewPlanKey(t)]).toEqual([true, false, false]);
    expect([isNewTabKey(shiftT), isReopenTabKey(shiftT), isNewPlanKey(shiftT)]).toEqual([false, true, false]);
    expect([isNewTabKey(shiftN), isReopenTabKey(shiftN), isNewPlanKey(shiftN)]).toEqual([false, false, true]);
    // ⌥ opts out of both T chords (⌘⌥T stays free).
    expect(isNewTabKey(cmd({ key: "†", code: "KeyT", altKey: true }))).toBe(false);
    expect(isReopenTabKey(cmd({ key: "ˇ", code: "KeyT", altKey: true, shiftKey: true }))).toBe(false);
    // ⌘W vs ⌘⇧W: the page/pane/tab vs the window, never both.
    const w = cmd({ key: "w", code: "KeyW" });
    const shiftW = cmd({ key: "W", code: "KeyW", shiftKey: true });
    expect([isCloseKey(w), isCloseWindowKey(w)]).toEqual([true, false]);
    expect([isCloseKey(shiftW), isCloseWindowKey(shiftW)]).toEqual([false, true]);
    expect(isCloseKey(cmd({ key: "∑", code: "KeyW", altKey: true }))).toBe(false);
    // ⌘1–9 vs the snap-back ⌘⇧0 and the zoom reset ⌘0.
    const snap = cmd({ key: ")", code: "Digit0", shiftKey: true });
    expect([tabIndexKeyOf(snap), isSnapBackKey(snap)]).toEqual([null, true]);
    expect(tabIndexKeyOf(cmd({ key: "0", code: "Digit0" }))).toBeNull();
    expect(tabIndexKeyOf(cmd({ key: "!", code: "Digit1", shiftKey: true }))).toBeNull();
    expect(tabIndexKeyOf(cmd({ key: "¡", code: "Digit1", altKey: true }))).toBeNull();
    // ⌘⌥← vs plain ⌘← (the line start in a text field), ⌘⇧← and ⌘⌥⇧←.
    expect(tabCycleKeyOf(cmd({ key: "ArrowLeft", code: "ArrowLeft" }))).toBeNull();
    expect(tabCycleKeyOf(cmd({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }))).toBeNull();
    expect(tabCycleKeyOf(cmd({ key: "ArrowLeft", code: "ArrowLeft", altKey: true, shiftKey: true }))).toBeNull();
    // ⌘[ alone is the browser's back, and ⌘⌥[ stays free.
    expect(tabCycleKeyOf(cmd({ key: "[", code: "BracketLeft" }))).toBeNull();
    expect(tabCycleKeyOf(cmd({ key: "“", code: "BracketLeft", altKey: true }))).toBeNull();
    // ⌘⌥↑ / ⌘⌥↓ belong to CodeMirror.
    expect(tabCycleKeyOf(cmd({ key: "ArrowUp", code: "ArrowUp", altKey: true }))).toBeNull();
    const one = cmd({ key: "1", code: "Digit1" });
    expect(tabIndexKeyOf(one)).toBe(0);
  });

  it("the workbench registry: ⌘-only chords, hinted in the classic shell in reading order", () => {
    expect(WORKBENCH_KEYMAP.map((b) => b.id)).toEqual(["new-tab", "reopen-tab", "close", "close-window", "tab-n", "tab-cycle"]);
    expect(WORKBENCH_KEYMAP.every((b) => b.keys[0] === "⌘")).toBe(true);
    const ids = CLASSIC_KEYMAP.map((b) => b.id);
    // The workbench globals follow the palette; its layout rows lead Layout.
    expect(ids.slice(0, 5)).toEqual(["palette", "new-tab", "reopen-tab", "close", "close-window"]);
    const layout = CLASSIC_KEYMAP.filter((b) => b.group === "Layout").map((b) => b.id);
    expect(layout.slice(0, 2)).toEqual(["tab-n", "tab-cycle"]);
    expect(bindingKeys("close")).toEqual(["⌘", "W"]);
    expect(bindingKeys("tab-cycle")).toEqual(["⌘", "⌥", "←/→"]);
  });
});
