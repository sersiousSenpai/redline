// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";

/**
 * Indent — Word-style indent / outdent for the Prompt Drafter.
 *
 * Two behaviours under one pair of commands:
 *  - Inside a list, indent/outdent nest the list item (sink/lift), the correct
 *    semantic move — so the change survives into the markdown as nested lists.
 *  - Elsewhere, indent/outdent bump a clamped `indent` *level* attribute on the
 *    block (rendered as left margin). That margin is a visual-only drafting aid
 *    with no markdown equivalent, so `planDocToMarkdown` ignores it.
 *
 * Our own Apache-2.0 code — no dependency. Registered only in
 * `drafterExtensions`; the list nesting relies on StarterKit's `listItem`.
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    indentControls: {
      /** Increase nesting (in lists) or left indent level (in blocks). */
      indent: () => ReturnType;
      /** Decrease nesting (in lists) or left indent level (in blocks). */
      outdent: () => ReturnType;
    };
  }
}

export interface IndentOptions {
  /** Block types that carry an indent level. */
  types: string[];
  /** Indent levels per block (min..max) and em width per level. */
  min: number;
  max: number;
  emPerLevel: number;
}

export const Indent = Extension.create<IndentOptions>({
  name: "indent",

  addOptions() {
    return {
      types: ["paragraph", "heading"],
      min: 0,
      max: 8,
      emPerLevel: 2,
    };
  },

  addGlobalAttributes() {
    const { emPerLevel } = this.options;
    return [
      {
        types: this.options.types,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => {
              const ml = element.style.marginLeft;
              if (!ml) return 0;
              return Math.round((parseFloat(ml) || 0) / emPerLevel);
            },
            renderHTML: (attributes) => {
              const level = (attributes.indent as number) || 0;
              if (level <= 0) return {};
              return { style: `margin-left: ${level * emPerLevel}em` };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    const { types, min, max } = this.options;
    const clamp = (n: number) => Math.min(max, Math.max(min, n));

    const shift =
      (delta: number) =>
      ({ editor, chain }: { editor: import("@tiptap/core").Editor; chain: () => import("@tiptap/core").ChainedCommands }) => {
        // Real list nesting takes priority over margin indentation.
        if (editor.isActive("listItem")) {
          return delta > 0
            ? chain().sinkListItem("listItem").run()
            : chain().liftListItem("listItem").run();
        }
        let c = chain();
        for (const type of types) {
          if (!editor.isActive(type)) continue;
          const cur = (editor.getAttributes(type).indent as number) || 0;
          c = c.updateAttributes(type, { indent: clamp(cur + delta) });
        }
        return c.run();
      };

    return {
      indent: () => shift(1),
      outdent: () => shift(-1),
    };
  },
});
