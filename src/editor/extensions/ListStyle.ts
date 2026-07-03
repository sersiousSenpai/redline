// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";

/**
 * ListStyle — Word-style list numbering / bullet styles for the Prompt Drafter.
 *
 * Adds a `listStyle` attribute to the `orderedList` and `bulletList` nodes and
 * exposes set/unset commands. The attribute renders as an inline
 * `list-style-type` (native token or one of the `rl-*` custom `@counter-style`
 * rules defined in styles.css) so the editor shows Roman numerals, letters,
 * parenthetical markers, etc.
 *
 * Unlike the purely-visual drafting aids (font, color, line height), list style
 * is semantic: the markdown serializer reads `listStyle` and emits the faithful
 * marker (`i.`, `A)`, `(iv)`, `α.`) so the authored structure carries into the
 * sent prompt. Plan documents never register this extension, so their ordered
 * lists keep the default `null` style and serialize as plain `1.` — the
 * round-trip invariant is untouched.
 *
 * Our own Apache-2.0 code — no dependency. Registered only in
 * `drafterExtensions`; the list wrapping relies on StarterKit's list nodes.
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    listStyle: {
      /** Make (or keep) an ordered list and set its marker style. */
      setOrderedListStyle: (style: string) => ReturnType;
      /** Make (or keep) a bullet list and set its bullet style. */
      setBulletListStyle: (style: string) => ReturnType;
      /** Clear the marker style back to the list's default. */
      unsetListStyle: () => ReturnType;
    };
  }
}

// Map a style key to the CSS `list-style-type` value. Native CSS keywords pass
// through; the parenthetical / trailing-paren / dash variants resolve to the
// `rl-*` custom counter styles declared in styles.css.
const CUSTOM_COUNTERS = new Set([
  "decimal-paren",
  "lower-alpha-paren",
  "lower-alpha-parenthetical",
  "upper-alpha-paren",
  "lower-roman-paren",
  "lower-roman-parenthetical",
  "upper-roman-paren",
  "dash",
]);

export function listStyleTypeCss(key: string): string {
  return CUSTOM_COUNTERS.has(key) ? `rl-${key}` : key;
}

export const ListStyle = Extension.create({
  name: "listStyle",

  addOptions() {
    return { types: ["orderedList", "bulletList"] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types as string[],
        attributes: {
          listStyle: {
            default: null,
            parseHTML: (element) =>
              element.getAttribute("data-list-style") || null,
            renderHTML: (attributes) => {
              const key = attributes.listStyle as string | null;
              if (!key) return {};
              return {
                "data-list-style": key,
                style: `list-style-type: ${listStyleTypeCss(key)}`,
              };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setOrderedListStyle:
        (style) =>
        ({ editor, chain }) => {
          const c = chain().focus();
          if (!editor.isActive("orderedList")) c.toggleOrderedList();
          return c.updateAttributes("orderedList", { listStyle: style }).run();
        },
      setBulletListStyle:
        (style) =>
        ({ editor, chain }) => {
          const c = chain().focus();
          if (!editor.isActive("bulletList")) c.toggleBulletList();
          return c.updateAttributes("bulletList", { listStyle: style }).run();
        },
      unsetListStyle:
        () =>
        ({ editor, chain }) => {
          const type = editor.isActive("orderedList")
            ? "orderedList"
            : "bulletList";
          return chain().focus().updateAttributes(type, { listStyle: null }).run();
        },
    };
  },
});
