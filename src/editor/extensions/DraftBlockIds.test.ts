// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";

import { drafterExtensions } from "./drafterExtensions";

// The drafter's self-minted block identity. The invariant under test: exactly
// the TOP-LEVEL blocks carry a blockId (mirrored into anchorId), and nothing
// nested ever keeps one — a stale id on a paragraph inside a list draws a
// second gutter label on top of the list's own (the "blk-b7k / blk-2c1
// overlap" bug) and hijacks closest('[data-anchor-id]') selection capture.

const editors: Editor[] = [];
function makeEditor(content: string | object): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: drafterExtensions(),
    content,
  });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

type Json = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: Json[];
};

/** Every node in the doc with its depth, flattened. */
function flatten(node: Json, depth = -1): { node: Json; depth: number }[] {
  const here = depth >= 0 ? [{ node, depth }] : [];
  return here.concat(
    (node.content ?? []).flatMap((c) => flatten(c, depth + 1)),
  );
}

describe("DraftBlockIds", () => {
  it("stamps every top-level block on first load, anchorId mirroring blockId", () => {
    const editor = makeEditor("<p>alpha</p><p>beta</p>");
    const doc = editor.getJSON() as Json;
    const tops = doc.content ?? [];
    const ids = tops.map((n) => n.attrs?.blockId);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(tops.length);
    for (const n of tops) expect(n.attrs?.anchorId).toBe(n.attrs?.blockId);
  });

  it("clears the nested paragraph's ids when it is wrapped into a list", () => {
    const editor = makeEditor("<p>alpha</p>");
    const before = (editor.getJSON() as Json).content?.[0].attrs?.blockId;
    expect(before).toBeTruthy();

    editor.commands.selectAll();
    editor.commands.toggleOrderedList();

    const doc = editor.getJSON() as Json;
    const list = doc.content?.[0];
    expect(list?.type).toBe("orderedList");
    // The list (now the top-level block) owns a fresh identity…
    expect(list?.attrs?.blockId).toBeTruthy();
    expect(list?.attrs?.anchorId).toBe(list?.attrs?.blockId);
    // …and the paragraph that moved inside it keeps none — neither its old
    // id (the wrap preserves attrs) nor a minted one.
    for (const { node, depth } of flatten(doc)) {
      if (depth === 0) continue;
      expect(node.attrs?.blockId ?? null).toBeNull();
      expect(node.attrs?.anchorId ?? null).toBeNull();
    }
  });

  it("gives Enter-split halves distinct ids", () => {
    const editor = makeEditor("<p>onetwo</p>");
    // Cursor between "one" and "two" (pos 1 opens the paragraph, +3 chars).
    editor.commands.setTextSelection(4);
    editor.commands.splitBlock();

    const tops = (editor.getJSON() as Json).content ?? [];
    expect(tops).toHaveLength(2);
    const [a, b] = tops.map((n) => n.attrs?.blockId);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("heals a persisted draft that still carries stale nested ids on open", () => {
    // A doc saved by a pre-fix build: the wrapped paragraph kept its id, so
    // both the list and its inner paragraph claim one.
    const stale = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { blockId: "blk-2c1aaaaa", anchorId: "blk-2c1aaaaa" },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "blk-b7kbbbbb", anchorId: "blk-b7kbbbbb" },
                  content: [{ type: "text", text: "one" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const editor = makeEditor(stale);

    const doc = editor.getJSON() as Json;
    const list = doc.content?.[0];
    expect(list?.attrs?.blockId).toBe("blk-2c1aaaaa");
    for (const { node, depth } of flatten(doc)) {
      if (depth === 0) continue;
      expect(node.attrs?.blockId ?? null).toBeNull();
      expect(node.attrs?.anchorId ?? null).toBeNull();
    }
  });
});
