// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { saveHoldKey } from "../audio/holdKey";
import {
  CLASSIC_KEYMAP,
  GLOBAL_KEYMAP,
  PAGE_KEEPS,
  PAGE_ONLY_SIGNALS,
  PAGE_ROUTES,
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
  isQuickOpenKey,
  isRailToggleKey,
  isReopenTabKey,
  isSidebarToggleKey,
  isSnapBackKey,
  isZoomPaneKey,
  isSplitAnywhereKey,
  isEqualizeKey,
  focusPaneKeyOf,
  shellKeymap,
  splitKeyOf,
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
    expect(WORKBENCH_KEYMAP.map((b) => b.id)).toEqual(["new-tab", "reopen-tab", "close", "close-window", "tab-n", "tab-cycle", "sidebar", "rail", "quick-open", "split", "split-down", "split-anywhere", "focus-pane", "equalize", "zoom-pane"]);
    expect(WORKBENCH_KEYMAP.every((b) => b.keys[0] === "⌘")).toBe(true);
    const ids = CLASSIC_KEYMAP.map((b) => b.id);
    // The workbench globals follow the palette; its layout rows lead Layout.
    expect(ids.slice(0, 6)).toEqual(["palette", "new-tab", "reopen-tab", "close", "close-window", "quick-open"]);
    const layout = CLASSIC_KEYMAP.filter((b) => b.group === "Layout").map((b) => b.id);
    expect(layout.slice(0, 4)).toEqual(["tab-n", "tab-cycle", "sidebar", "rail"]);
    expect(bindingKeys("close")).toEqual(["⌘", "W"]);
    expect(bindingKeys("tab-cycle")).toEqual(["⌘", "⌥", "←/→"]);
  });
});

describe("the side columns (W4)", () => {
  const cmd = (over: Parameters<typeof combo>[0]) => combo({ metaKey: true, ...over });
  it("⌘B is the sidebar and ⌘⌥B the rail, on the physical key", () => {
    expect(isSidebarToggleKey(cmd({ key: "b", code: "KeyB" }))).toBe(true);
    expect(isRailToggleKey(cmd({ key: "∫", code: "KeyB", altKey: true }))).toBe(true);
    // Never both, and ⇧ or Ctrl opts out (Ctrl+B is a terminal's).
    expect(isRailToggleKey(cmd({ key: "b", code: "KeyB" }))).toBe(false);
    expect(isSidebarToggleKey(cmd({ key: "∫", code: "KeyB", altKey: true }))).toBe(false);
    expect(isSidebarToggleKey(cmd({ key: "B", code: "KeyB", shiftKey: true }))).toBe(false);
    expect(isSidebarToggleKey(combo({ key: "b", code: "KeyB", ctrlKey: true }))).toBe(false);
    expect(isRailToggleKey(combo({ key: "b", code: "KeyB", ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSidebarToggleKey(combo({ key: "b", code: "KeyB" }))).toBe(false);
  });
  it("hints both, with ⇧← / ⇧→ kept as aliases", () => {
    expect(bindingKeys("sidebar")).toEqual(["⌘", "B"]);
    expect(bindingKeys("rail")).toEqual(["⌘", "⌥", "B"]);
    expect(bindingKeys("pane-sidebar")).toEqual(["⇧", "←"]);
    expect(bindingKeys("pane-discussion")).toEqual(["⇧", "→"]);
  });
});

describe("quick open (W4)", () => {
  it("⌘P is Go to File; ⌘⌥P (Print), ⌘⇧P and Ctrl+P are not", () => {
    expect(isQuickOpenKey(combo({ metaKey: true, key: "p", code: "KeyP" }))).toBe(true);
    expect(isQuickOpenKey(combo({ metaKey: true, altKey: true, key: "π", code: "KeyP" }))).toBe(false);
    expect(isQuickOpenKey(combo({ metaKey: true, shiftKey: true, key: "P", code: "KeyP" }))).toBe(false);
    expect(isQuickOpenKey(combo({ ctrlKey: true, key: "p", code: "KeyP" }))).toBe(false);
    expect(bindingKeys("quick-open")).toEqual(["⌘", "P"]);
  });
});

describe("splits and the zoom (W3 walk fixes)", () => {
  const cmd = (over: Parameters<typeof combo>[0]) => combo({ metaKey: true, ...over });
  it("⌘D splits right (in a wall: a new tile), ⌘⇧D splits down, on the physical key", () => {
    expect(splitKeyOf(cmd({ key: "d", code: "KeyD" }))).toBe("row");
    expect(splitKeyOf(cmd({ key: "D", code: "KeyD", shiftKey: true }))).toBe("column");
    // Ctrl+D is the shell's end of input; ⌘⌥D and a bare D are no split.
    expect(splitKeyOf(combo({ key: "d", code: "KeyD", ctrlKey: true }))).toBeNull();
    expect(splitKeyOf(cmd({ key: "∂", code: "KeyD", altKey: true }))).toBeNull();
    expect(splitKeyOf(combo({ key: "d", code: "KeyD" }))).toBeNull();
    expect(bindingKeys("split")).toEqual(["⌘", "D"]);
    expect(bindingKeys("split-down")).toEqual(["⌘", "⇧", "D"]);
  });
  it("⌘⇧↩ zooms; ⇧↩ (the door) and ⌘↩ (a composer's send) do not", () => {
    expect(isZoomPaneKey(cmd({ key: "Enter", code: "Enter", shiftKey: true }))).toBe(true);
    expect(isZoomPaneKey(cmd({ key: "Enter", code: "NumpadEnter", shiftKey: true }))).toBe(true);
    expect(isZoomPaneKey(cmd({ key: "Enter", code: "Enter" }))).toBe(false);
    expect(isZoomPaneKey(combo({ key: "Enter", code: "Enter", shiftKey: true }))).toBe(false);
    expect(isFrontDoorKey(cmd({ key: "Enter", code: "Enter", shiftKey: true }))).toBe(false);
    expect(bindingKeys("zoom-pane")).toEqual(["⌘", "⇧", "↩"]);
  });
});

describe("any split tree (W5)", () => {
  const cmd = (over: Parameters<typeof combo>[0]) => combo({ metaKey: true, ...over });
  it("⌘\\ splits right everywhere, on the physical key; nothing else does", () => {
    expect(isSplitAnywhereKey(cmd({ key: "\\", code: "Backslash" }))).toBe(true);
    // A layout that types another character there still splits.
    expect(isSplitAnywhereKey(cmd({ key: "#", code: "Backslash" }))).toBe(true);
    expect(isSplitAnywhereKey(cmd({ key: "|", code: "Backslash", shiftKey: true }))).toBe(false);
    expect(isSplitAnywhereKey(cmd({ key: "«", code: "Backslash", altKey: true }))).toBe(false);
    expect(isSplitAnywhereKey(combo({ key: "\\", code: "Backslash", ctrlKey: true }))).toBe(false);
    expect(isSplitAnywhereKey(combo({ key: "\\", code: "Backslash" }))).toBe(false);
    expect(bindingKeys("split-anywhere")).toEqual(["⌘", "\\"]);
  });
  it.each([
    ["ArrowLeft", "left"],
    ["ArrowRight", "right"],
    ["ArrowUp", "up"],
    ["ArrowDown", "down"],
  ] as const)("⌃⌘%s focuses the pane %s", (code, dir) => {
    expect(focusPaneKeyOf(combo({ key: code, code, metaKey: true, ctrlKey: true }))).toBe(dir);
  });
  it("only ⌃⌘ moves the pane focus: ⌘⌥↑/↓ (CodeMirror), ⌘⌥←/→ (tabs), ⌃ + an arrow and ⌘ + an arrow are left alone", () => {
    expect(focusPaneKeyOf(cmd({ key: "ArrowUp", code: "ArrowUp", altKey: true }))).toBeNull();
    expect(focusPaneKeyOf(cmd({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }))).toBeNull();
    expect(tabCycleKeyOf(cmd({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }))).toBe(-1);
    expect(tabCycleKeyOf(combo({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true, ctrlKey: true }))).toBeNull();
    expect(focusPaneKeyOf(combo({ key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true }))).toBeNull();
    expect(focusPaneKeyOf(cmd({ key: "ArrowLeft", code: "ArrowLeft" }))).toBeNull();
    expect(focusPaneKeyOf(combo({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true, ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(focusPaneKeyOf(combo({ key: "h", code: "KeyH", metaKey: true, ctrlKey: true }))).toBeNull();
  });
  it("⌘⌥= evens the splits, on e.code (⌥ rewrites the key); ⌘= (the zoom-in) does not", () => {
    expect(isEqualizeKey(cmd({ key: "≠", code: "Equal", altKey: true }))).toBe(true);
    expect(isEqualizeKey(cmd({ key: "=", code: "Equal" }))).toBe(false);
    expect(isEqualizeKey(cmd({ key: "±", code: "Equal", altKey: true, shiftKey: true }))).toBe(false);
    expect(isEqualizeKey(combo({ key: "=", code: "Equal", altKey: true, ctrlKey: true }))).toBe(false);
    expect(bindingKeys("equalize")).toEqual(["⌘", "⌥", "="]);
  });
  it("a focused web page keeps the pane chords (no menu item or signal carries them)", () => {
    for (const id of ["split-anywhere", "focus-pane", "equalize"]) {
      expect(PAGE_KEEPS).toContain(id);
      expect(PAGE_ROUTES[id]).toBeUndefined();
    }
  });
});

describe("with a web page focused", () => {
  it("every wired chord has a way in from a page, or is the page's to keep", () => {
    for (const b of CLASSIC_KEYMAP.filter((x) => x.wired)) {
      const routes = PAGE_ROUTES[b.id];
      expect(routes?.length || PAGE_KEEPS.includes(b.id), b.id).toBeTruthy();
    }
    // ⌘K is the palette there too, never the page's own ⌘K.
    expect(PAGE_ROUTES.palette).toEqual([{ signal: "palette" }]);
    expect(Object.keys(PAGE_ROUTES).every((id) => CLASSIC_KEYMAP.some((b) => b.id === id))).toBe(true);
  });
});

describe("the page-focused matrix, against the files that carry it", () => {
  const signals = readFileSync("src-tauri/src/browser_signals.js", "utf8") + readFileSync("src-tauri/src/browser_frontdoor_shortcut.js", "utf8");
  const events = readFileSync("src-tauri/src/browser_events.rs", "utf8");
  const pane = readFileSync("src/components/BrowserPane.tsx", "utf8");
  const menus = readFileSync("src-tauri/src/workbench_menu.rs", "utf8") + readFileSync("src-tauri/src/lib.rs", "utf8");
  const allowed = events.slice(events.indexOf("pub const PAGE_SHORTCUTS"), events.indexOf("pub fn parse_signal"));
  const forwarded = [...Object.values(PAGE_ROUTES).flat().flatMap((r) => ("signal" in r ? [r.signal] : [])), ...PAGE_ONLY_SIGNALS];
  it.each(forwarded)("the page sends %s, the backend lets it through and the pane answers it", (signal) => {
    expect(signals).toContain(`"${signal}"`);
    expect(allowed).toContain(`"${signal}"`);
    expect(pane).toContain(`"${signal}"`);
  });
  it.each(Object.values(PAGE_ROUTES).flat().flatMap((r) => ("menu" in r ? [r.menu] : [])))("menu item %s exists", (id) => {
    expect(menus).toMatch(new RegExp(`"${id}"|\\b${id.toUpperCase()}_ID\\b|with_id\\("${id}"`));
  });
});
