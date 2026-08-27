// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  autoSends,
  clampSelection,
  MAX_SELECTION_CHARS,
  parseSelectionEvents,
  promptForSelection,
  type SelectionAction,
  type SelectionEvent,
} from "./browseSelection";

const ev = (
  action: SelectionAction,
  text = "attention is all you need",
): SelectionEvent => ({
  id: 1,
  action,
  text,
  url: "https://example.com/a",
  title: "A page",
});

describe("parseSelectionEvents", () => {
  it("reads a well-formed queue", () => {
    const out = parseSelectionEvents([
      { id: 1, action: "ask", text: "hello there", url: "u", title: "t" },
      { id: 2, action: "define", text: "ansatz", url: "u", title: "t" },
    ]);
    expect(out.map((e) => e.action)).toEqual(["ask", "define"]);
    expect(out[1]).toEqual({
      id: 2,
      action: "define",
      text: "ansatz",
      url: "u",
      title: "t",
    });
  });

  it("returns nothing for anything that isn't an array", () => {
    for (const junk of [null, undefined, 0, "", "[]", {}, { length: 2 }]) {
      expect(parseSelectionEvents(junk)).toEqual([]);
    }
  });

  // The queue crosses a JSON boundary out of an arbitrary web page, so a
  // malformed row must be dropped rather than dispatched as a chat turn.
  it("drops rows with no usable action or text", () => {
    const out = parseSelectionEvents([
      null,
      "ask",
      42,
      {},
      { action: "ask" }, // no text
      { action: "ask", text: "   " }, // whitespace only
      { action: "summarise", text: "not an action we have" },
      { action: "list", text: "keeps this one" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe("list");
  });

  it("fills in the parts a partial row is missing", () => {
    const [only] = parseSelectionEvents([{ action: "explain", text: "  padded  " }]);
    expect(only).toEqual({
      id: 0,
      action: "explain",
      text: "padded",
      url: "",
      title: "",
    });
  });

  it("clamps an over-long passage on the way in", () => {
    const [big] = parseSelectionEvents([
      { action: "ask", text: "x".repeat(MAX_SELECTION_CHARS + 500) },
    ]);
    expect(big.text).toHaveLength(MAX_SELECTION_CHARS + 1); // + the marker
    expect(big.text.endsWith("…")).toBe(true);
  });
});

describe("clampSelection", () => {
  it("leaves a normal passage alone", () => {
    expect(clampSelection("  a quiet sentence.  ")).toBe("a quiet sentence.");
  });

  it("marks the cut so a truncated quote can't pass as the whole passage", () => {
    const out = clampSelection("y".repeat(MAX_SELECTION_CHARS * 2));
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_SELECTION_CHARS + 1);
  });
});

describe("promptForSelection", () => {
  it("blockquotes the passage and leaves the caret below it for `ask`", () => {
    expect(promptForSelection(ev("ask", "the model is a diffusion prior"))).toBe(
      "> the model is a diffusion prior\n\n",
    );
  });

  it("quotes every line of a multi-line passage", () => {
    expect(promptForSelection(ev("ask", "first line\nsecond line"))).toBe(
      "> first line\n> second line\n\n",
    );
  });

  it("never leaves trailing whitespace on a blank quoted line", () => {
    expect(promptForSelection(ev("ask", "one\n\ntwo"))).toBe("> one\n>\n> two\n\n");
  });

  it("appends the intent line for each one-tap action", () => {
    expect(promptForSelection(ev("define", "ansatz"))).toBe(
      "> ansatz\n\nDefine this as it's used on this page.",
    );
    expect(promptForSelection(ev("explain", "ansatz"))).toBe(
      "> ansatz\n\nExplain this simply, in the context of this page.",
    );
    expect(promptForSelection(ev("research", "ansatz"))).toContain("WebSearch");
    expect(promptForSelection(ev("research", "ansatz")).startsWith("> ansatz\n\n")).toBe(
      true,
    );
  });

  it("clamps here too, so a hand-made queue entry can't smuggle a whole page in", () => {
    const out = promptForSelection(ev("define", "z".repeat(MAX_SELECTION_CHARS + 10)));
    expect(out.startsWith("> ")).toBe(true);
    expect(out).toContain("…");
    expect(out).toContain("Define this as it's used on this page.");
  });
});

describe("autoSends", () => {
  it("waits only for `ask`", () => {
    expect(autoSends("ask")).toBe(false);
    for (const a of ["define", "explain", "research", "list"] as SelectionAction[]) {
      expect(autoSends(a)).toBe(true);
    }
  });
});
