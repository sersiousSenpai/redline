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
  note: "",
  locator: null,
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
      note: "",
      locator: null,
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
      { action: "list", text: "keeps this one", note: "and its note" },
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
      note: "",
      locator: null,
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

describe("the ＋ List tap", () => {
  // The bar used to file the highlighted PASSAGE as the list item. That wrote
  // the page's own words into the user's list; the passage is where they were
  // pointing, and the note is what they had to say about it.
  it("carries the typed note and the element, not just the passage", () => {
    const [out] = parseSelectionEvents([
      {
        id: 1,
        action: "list",
        text: "Search jobs",
        url: "http://localhost:3000/jobs",
        title: "Jobs",
        note: "  line   spacing is off  ",
        locator: { tag: "input", name: "Search jobs", classes: ["search-bar"] },
      },
    ]);
    expect(out.note).toBe("line spacing is off");
    expect(out.text).toBe("Search jobs");
    expect(out.locator?.tag).toBe("input");
  });

  it("drops a list tap with no note rather than filing the passage as one", () => {
    expect(
      parseSelectionEvents([
        { id: 1, action: "list", text: "Search jobs", url: "u", title: "t" },
      ]),
    ).toEqual([]);
    // …while every other action is unaffected by the absence of a note.
    expect(
      parseSelectionEvents([
        { id: 1, action: "define", text: "Search jobs", url: "u", title: "t" },
      ]),
    ).toHaveLength(1);
  });

  it("keeps a junk locator out of the item entirely", () => {
    const [out] = parseSelectionEvents([
      {
        id: 1,
        action: "list",
        text: "Search jobs",
        url: "u",
        title: "t",
        note: "off",
        locator: { tag: 42, classes: "not an array" },
      },
    ]);
    expect(out.locator).toBeNull();
  });
});
