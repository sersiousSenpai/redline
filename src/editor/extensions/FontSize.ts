// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";

/**
 * FontSize — a font-size control for the Prompt Drafter.
 *
 * Tiptap v2 ships no official font-size extension, so we follow the standard
 * community pattern: hang a `fontSize` attribute off the `textStyle` mark
 * (from @tiptap/extension-text-style, the same mark FontFamily and Color use)
 * and expose set/unset commands. This is our own Apache-2.0 code — no extra
 * dependency.
 *
 * Like underline/highlight/font-family/color, font size is a *drafting aid*:
 * it lives only in the editor's JSON and is ignored by `planDocToMarkdown`
 * (markdown has no notion of font size), so it never reaches the sent prompt.
 *
 * Requires the `textStyle` mark to be registered (TextStyle extension).
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fontSize: {
      /** Apply a CSS font size (e.g. "18px") to the selection. */
      setFontSize: (size: string) => ReturnType;
      /** Clear any font size, removing an emptied textStyle mark. */
      unsetFontSize: () => ReturnType;
    };
  }
}

export interface FontSizeOptions {
  /** Marks the attribute is added to. Defaults to ["textStyle"]. */
  types: string[];
}

export const FontSize = Extension.create<FontSizeOptions>({
  name: "fontSize",

  addOptions() {
    return { types: ["textStyle"] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) => {
              if (!attributes.fontSize) return {};
              return { style: `font-size: ${attributes.fontSize}` };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontSize:
        (size) =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontSize: size }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain()
            .setMark("textStyle", { fontSize: null })
            .removeEmptyTextStyle()
            .run(),
    };
  },
});
