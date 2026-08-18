// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySeed,
  isEditableTarget,
  isSeedKey,
  seedStep,
} from "./landing";

const key = (k: string, mods: Partial<Parameters<typeof isSeedKey>[0]> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });

describe("isSeedKey", () => {
  it("accepts printable characters, including space and shifted capitals", () => {
    for (const k of ["a", "Z", "7", " ", ".", "#", "é"]) {
      expect(isSeedKey(key(k))).toBe(true);
    }
  });

  it("rejects command modifiers — those are shortcuts, not text", () => {
    expect(isSeedKey(key("a", { metaKey: true }))).toBe(false);
    expect(isSeedKey(key("a", { ctrlKey: true }))).toBe(false);
    expect(isSeedKey(key("a", { altKey: true }))).toBe(false);
  });

  it("rejects IME composition keystrokes", () => {
    expect(isSeedKey(key("a", { isComposing: true }))).toBe(false);
  });

  it("rejects named keys via their multi-char `key`", () => {
    for (const k of ["Enter", "Escape", "Backspace", "ArrowLeft", "F5", "Tab"]) {
      expect(isSeedKey(key(k))).toBe(false);
    }
  });
});

describe("isEditableTarget", () => {
  it("claims inputs, textareas (xterm's hidden one), and selects", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "textarea" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
  });

  it("claims contenteditable hosts (TipTap, CodeMirror)", () => {
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(
      true,
    );
  });

  it("leaves plain elements and null to the landing", () => {
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("seedStep", () => {
  const k = (p: Partial<{ printable: boolean; erase: boolean; editable: boolean }>) =>
    ({ printable: false, erase: false, editable: false, ...p });

  it("idle: a printable key on the page starts the handoff", () => {
    expect(seedStep("idle", k({ printable: true }))).toBe("start");
  });

  it("idle: keystrokes owned by an editing surface never start one", () => {
    expect(seedStep("idle", k({ printable: true, editable: true }))).toBe(
      "ignore",
    );
  });

  it("idle: non-printable keys are ignored", () => {
    expect(seedStep("idle", k({}))).toBe("ignore");
    expect(seedStep("idle", k({ erase: true }))).toBe("ignore");
  });

  it("handoff: printable keys buffer, Backspace trims, others pass", () => {
    expect(seedStep("handoff", k({ printable: true }))).toBe("buffer");
    expect(seedStep("handoff", k({ erase: true }))).toBe("erase");
    expect(seedStep("handoff", k({}))).toBe("ignore");
  });

  it("handoff: an editable target means the editor took over — release", () => {
    expect(seedStep("handoff", k({ editable: true }))).toBe("release");
    expect(seedStep("handoff", k({ printable: true, editable: true }))).toBe(
      "release",
    );
  });
});

describe("applySeed", () => {
  it("builds the seed across a start → buffer → erase run", () => {
    let buf = applySeed("", "start", "W");
    buf = applySeed(buf, "buffer", "r");
    buf = applySeed(buf, "buffer", "x");
    buf = applySeed(buf, "erase", "Backspace");
    buf = applySeed(buf, "buffer", "i");
    expect(buf).toBe("Wri");
  });

  it("erase on an empty buffer stays empty; release clears; ignore holds", () => {
    expect(applySeed("", "erase", "Backspace")).toBe("");
    expect(applySeed("abc", "release", "x")).toBe("");
    expect(applySeed("abc", "ignore", "x")).toBe("abc");
  });
});

// Source invariants — the wiring half of the handoff lives in App.tsx,
// FrontDoor.tsx and PromptDrafter.tsx; these pin the contract the pure
// machine assumes.
describe("landing wiring", () => {
  const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
  const drafter = readFileSync(
    join(process.cwd(), "src/components/PromptDrafter.tsx"),
    "utf8",
  );
  const frontDoor = readFileSync(
    join(process.cwd(), "src/components/FrontDoor.tsx"),
    "utf8",
  );

  it("App renders the front door where the 'No plans yet' zero state lived", () => {
    expect(app).toContain("<FrontDoor");
    expect(app).not.toContain("No plans yet");
  });

  it("keeps the tour anchor the landing carried", () => {
    expect(frontDoor).toContain('data-tour="landing"');
  });

  it("the front door is REACHABLE — something clears the session selection", () => {
    // The door renders only when no plan is selected, and boot auto-selects
    // the most recent one. Without a deselect path it is unreachable for
    // anyone who has ever reviewed a plan — it would show on a virgin
    // install and never again. This shipped broken exactly once.
    expect(app).toContain("setActiveId(null)");
    expect(app).toContain("onNewPlan={openFrontDoor}");
  });

  it("the door survives the sidebar going away — two entries outside it", () => {
    // The sentence above is the whole point, and `onNewPlan` alone no longer
    // makes it true: that row lives INSIDE the sessions sidebar, which is now
    // masked on every non-document surface and collapsible on the document.
    // Same failure, one layer out — so the guard follows it out.
    //
    // 1. The sidebar's divider is always in flow whatever the panel does, and
    //    it carries the door's action while collapsed.
    expect(app).toContain("onClick: openFrontDoor");
    // 2. A real chord, so the door is reachable with no pointer at all.
    expect(app).toContain("isNewPlanKey(e)");
    expect(app).toContain("openFrontDoorRef.current()");
    const keymap = readFileSync(join(process.cwd(), "src/lib/keymap.ts"), "utf8");
    const binding = keymap.match(/\{[^{}]*id: "new-plan"[^{}]*\}/);
    expect(binding).not.toBeNull();
    expect(binding?.[0]).toContain("wired: true");
  });

  it("the front door drains the seed in a LAYOUT effect — the losslessness guarantee", () => {
    // A passive effect would let the browser dispatch the next keydown
    // between focus and drain, reordering a character. The composer is
    // always mounted, so focus + consume is all that is left of the handoff
    // — but it still has to be synchronous with the DOM update.
    const idx = frontDoor.indexOf("consumeSeed()");
    expect(idx).toBeGreaterThan(-1);
    const effectIdx = frontDoor.lastIndexOf("useLayoutEffect", idx);
    const focusIdx = frontDoor.lastIndexOf("taRef.current?.focus()", idx);
    expect(effectIdx).toBeGreaterThan(-1);
    // Focus happens first, inside that same layout effect.
    expect(focusIdx).toBeGreaterThan(effectIdx);
    expect(idx - effectIdx).toBeLessThan(600);
  });

  it("the drafter consumes the seed in the same task as its mount focus — the losslessness guarantee", () => {
    const idx = drafter.indexOf("consumeSeedRef.current");
    const focusIdx = drafter.indexOf('focus("end")', idx);
    expect(idx).toBeGreaterThan(-1);
    // Seed insertion and focus happen in one synchronous block (insertion
    // first): no keydown can land between them.
    expect(focusIdx).toBeGreaterThan(idx);
    expect(focusIdx - idx).toBeLessThan(1200);
  });
});
