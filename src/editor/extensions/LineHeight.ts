// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";

/**
 * LineHeight — Word-style line spacing for the Prompt Drafter.
 *
 * Adds a `lineHeight` attribute to block nodes (paragraph/heading) and exposes
 * set/unset commands. Our own Apache-2.0 code — no dependency.
 *
 * Visual-only, like the other drafting aids: line spacing is a presentation
 * concern with no markdown equivalent, so `planDocToMarkdown` (which reads only
 * the node type and a handful of structural attrs) ignores it and it never
 * reaches the sent prompt. Registered only in `drafterExtensions`.
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    lineHeight: {
      /** Apply a unitless CSS line-height (e.g. "1.5") to selected blocks. */
      setLineHeight: (value: string) => ReturnType;
      /** Clear the line-height back to the stylesheet default. */
      unsetLineHeight: () => ReturnType;
    };
  }
}

export interface LineHeightOptions {
  /** Block types the attribute is added to. */
  types: string[];
}

export const LineHeight = Extension.create<LineHeightOptions>({
  name: "lineHeight",

  addOptions() {
    return { types: ["paragraph", "heading"] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (element) => element.style.lineHeight || null,
            renderHTML: (attributes) => {
              if (!attributes.lineHeight) return {};
              return { style: `line-height: ${attributes.lineHeight}` };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setLineHeight:
        (value) =>
        ({ chain }) => {
          // Apply to whichever of the configured block types the selection
          // spans; updateAttributes is a no-op for non-matching types.
          let c = chain();
          for (const type of this.options.types) {
            c = c.updateAttributes(type, { lineHeight: value });
          }
          return c.run();
        },
      unsetLineHeight:
        () =>
        ({ chain }) => {
          let c = chain();
          for (const type of this.options.types) {
            c = c.resetAttributes(type, "lineHeight");
          }
          return c.run();
        },
    };
  },
});
