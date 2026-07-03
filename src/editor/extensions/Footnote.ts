// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Node, mergeAttributes } from "@tiptap/core";

/**
 * Footnote — a Word-style footnote reference for the Prompt Drafter.
 *
 * An inline atom node that renders as a superscript marker. The visible number
 * is supplied entirely by a CSS counter (`.rl-footnote`, see styles.css), so
 * references renumber automatically as footnotes are added, moved, or deleted —
 * no plugin bookkeeping. The footnote body lives in the node's `text` attribute
 * and surfaces as a hover tooltip (`title`).
 *
 * Footnotes are semantic content, not a visual aid: the markdown serializer
 * emits `[^n]` at each reference and appends a `[^n]: …` definitions block at
 * the end of the document, so they carry into the sent prompt as GitHub /
 * pandoc-style footnotes. Registered only in `drafterExtensions`.
 *
 * Our own Apache-2.0 code — no dependency.
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnote: {
      /** Insert a footnote reference carrying `text` at the cursor. */
      insertFootnote: (text: string) => ReturnType;
      /** Rewrite the body of the currently selected footnote. */
      updateFootnote: (text: string) => ReturnType;
    };
  }
}

export const Footnote = Node.create({
  name: "footnote",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      text: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-text") || "",
        renderHTML: (attributes) => ({
          "data-text": (attributes.text as string) || "",
          // Surface the body on hover without a NodeView.
          title: (attributes.text as string) || "",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "sup[data-footnote]" }];
  },

  renderHTML({ HTMLAttributes }) {
    // Empty element — the number is drawn by the `.rl-footnote::before`
    // CSS counter so references stay contiguous no matter the edit order.
    return [
      "sup",
      mergeAttributes(HTMLAttributes, {
        "data-footnote": "",
        class: "rl-footnote",
      }),
    ];
  },

  addCommands() {
    return {
      insertFootnote:
        (text) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { text } }),
      updateFootnote:
        (text) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { text }),
    };
  },
});
