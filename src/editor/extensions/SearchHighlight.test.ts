// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { findMatches } from "./SearchHighlight";

/** A stand-in for a ProseMirror doc: `findMatches` only walks text nodes via
 *  `descendants`, so we feed it text nodes at known absolute positions. */
function fakeDoc(nodes: { text: string; pos: number }[]) {
  return {
    descendants(cb: (node: unknown, pos: number) => void) {
      for (const n of nodes) {
        cb({ isText: true, text: n.text }, n.pos);
      }
    },
  } as unknown as import("@tiptap/pm/model").Node;
}

describe("findMatches", () => {
  it("returns no matches for an empty query", () => {
    expect(findMatches(fakeDoc([{ text: "hello", pos: 1 }]), "")).toEqual([]);
  });

  it("finds every case-insensitive occurrence with absolute positions", () => {
    // Text node starts at position 1: "The cat sat on the cat."
    //                                  123456789...
    const doc = fakeDoc([{ text: "The cat sat on the cat.", pos: 1 }]);
    const m = findMatches(doc, "cat");
    expect(m).toEqual([
      { from: 5, to: 8 }, // "cat" at text offset 4 → 1 + 4
      { from: 20, to: 23 }, // second "cat" at text offset 19 → 1 + 19
    ]);
  });

  it("matches across separate text nodes at their own offsets", () => {
    const doc = fakeDoc([
      { text: "find me", pos: 1 },
      { text: "me again", pos: 50 },
    ]);
    expect(findMatches(doc, "me")).toEqual([
      { from: 6, to: 8 },
      { from: 50, to: 52 },
    ]);
  });

  it("does not overlap matches", () => {
    const doc = fakeDoc([{ text: "aaaa", pos: 1 }]);
    // "aa" at 0 and at 2 — non-overlapping.
    expect(findMatches(doc, "aa")).toEqual([
      { from: 1, to: 3 },
      { from: 3, to: 5 },
    ]);
  });
});
