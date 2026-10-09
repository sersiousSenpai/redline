// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { splitAtClosedBlock } from "./streamSplit";

const at = (text: string) => {
  const { head, tail, openFence } = splitAtClosedBlock(text);
  expect(head + tail).toBe(text);
  return { head, tail, openFence };
};

describe("splitAtClosedBlock", () => {
  it("splits after a blank line once the next block has begun", () => {
    expect(at("One paragraph.\n\nAnother")).toMatchObject({
      head: "One paragraph.\n\n",
      tail: "Another",
    });
    // The blank line alone places nothing: the boundary is the start of the
    // next block, once its first line shows that it is one.
    expect(at("One paragraph.\n\n").head).toBe("");
    expect(at("No blank line yet\nso one block").head).toBe("");
  });

  it("never splits inside a code fence, and says where an open one starts", () => {
    const open = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;";
    expect(at(open)).toEqual({
      head: "Intro\n\n",
      tail: "```ts\nconst a = 1;\n\nconst b = 2;",
      openFence: 0,
    });
    // Closed, then followed by a new block: the fence is settled.
    const closed = `${open}\n\`\`\`\n\nAfter`;
    expect(at(closed)).toMatchObject({ tail: "After", openFence: -1 });
    // A shorter or different marker does not close it; a longer one does.
    expect(at("````\na\n```\n\nb").openFence).toBe(0);
    expect(at("~~~\na\n```\n\nb").openFence).toBe(0);
    expect(at("```\na\n````\n\nb").tail).toBe("b");
  });

  it("holds a list open across a blank line while the next line could be another item", () => {
    // `- b` continues the list (and makes it loose): no boundary.
    expect(at("- a\n\n- b").head).toBe("");
    expect(at("1. a\n\n2. b").head).toBe("");
    // Not yet decidable: `1` may become `1.`.
    expect(at("1. a\n\n1").head).toBe("");
    // An indented line belongs to the item.
    expect(at("- a\n\n  more of a").head).toBe("");
    // A column-0 line that is not a marker ends the list.
    expect(at("- a\n\nAfter the list").head).toBe("- a\n\n");
    expect(at("- a\n\n**Bold** start").head).toBe("- a\n\n");
    // After a paragraph, a list item is just the next block.
    expect(at("Para\n\n- a").head).toBe("Para\n\n");
  });

  it("does not split a reply holding a reference-style link definition", () => {
    expect(at("See [the docs].\n\nMore\n\n[the docs]: https://example.com").head).toBe("");
  });

  it("only moves forward as the text grows", () => {
    const text =
      "# Title\n\nIntro\n\n- a\n- b\n\n- c\n\nAfter\n\n```js\nx\n\ny\n```\n\n| a |\n|---|\n| 1 |\n\nEnd";
    let previous = "";
    for (let n = 0; n <= text.length; n++) {
      const { head } = at(text.slice(0, n));
      expect(head.startsWith(previous), `at ${n}: ${JSON.stringify(head)}`).toBe(true);
      previous = head;
    }
    expect(previous).toBe(text.slice(0, text.lastIndexOf("End")));
  });
});
