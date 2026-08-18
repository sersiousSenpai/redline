// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// What a blank Prompt Drafter offers. The pure half of the opening: which
// starters exist and what each one puts on the page.
//
// The law, same as the front door's: a starter FILLS, it never sends. A
// half-written brief is an invitation to finish it; a launched one is a
// surprise. Lazy-loaded with the drafter's chunk — nothing here is on boot.

import type { JSONContent } from "@tiptap/react";

export interface DrafterStarter {
  /** What the chip reads. */
  label: string;
  /** One line under it in the chip's title, for the shape you're choosing. */
  hint: string;
  /** The document it lays down. */
  doc: () => JSONContent;
}

const h = (level: number, text: string): JSONContent => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});
const p = (text = ""): JSONContent =>
  text
    ? { type: "paragraph", content: [{ type: "text", text }] }
    : { type: "paragraph" };
const bullets = (items: string[]): JSONContent => ({
  type: "bulletList",
  content: items.map((t) => ({ type: "listItem", content: [p(t)] })),
});
const doc = (...content: JSONContent[]): JSONContent => ({
  type: "doc",
  content,
});

/** The three shapes a plan brief usually takes. Structure only — every line is
 *  a prompt for the user to answer, never prose pretending to be theirs. */
export const DRAFTER_STARTERS: DrafterStarter[] = [
  {
    label: "Feature brief",
    hint: "What to build, for whom, and how you'll know it works",
    doc: () =>
      doc(
        h(1, "Feature brief"),
        h(2, "What"),
        p("The change, in one sentence."),
        h(2, "Why"),
        p("What is worse today than it needs to be."),
        h(2, "Shape"),
        bullets([
          "The surface it lands on",
          "What it reuses",
          "What it deliberately doesn't do",
        ]),
        h(2, "Done when"),
        bullets(["", ""]),
      ),
  },
  {
    label: "Bug report",
    hint: "What happens, what should, and the shortest path to see it",
    doc: () =>
      doc(
        h(1, "Bug"),
        h(2, "What happens"),
        p(""),
        h(2, "What should happen"),
        p(""),
        h(2, "Reproduce"),
        bullets(["", ""]),
        h(2, "Where you think it lives"),
        p("A file, a function, or 'no idea' — both are useful."),
      ),
  },
  {
    label: "Refactor plan",
    hint: "What's tangled, what it should become, and what must not change",
    doc: () =>
      doc(
        h(1, "Refactor"),
        h(2, "What's tangled"),
        p(""),
        h(2, "What it should become"),
        p(""),
        h(2, "Behaviour that must not change"),
        bullets(["", ""]),
        h(2, "How we'll know"),
        p("The test or check that proves the move was behaviour-free."),
      ),
  },
];
