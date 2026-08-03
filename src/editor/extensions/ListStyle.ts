// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension, InputRule } from "@tiptap/core";
import type { Range } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { canJoin, findWrapping } from "@tiptap/pm/transform";

import {
  classifyOrderedToken,
  NEXT_BULLET,
  NEXT_ORDERED,
} from "../listMarkers";

/**
 * ListStyle — Word-style list numbering / bullet styles for the Prompt Drafter.
 *
 * Adds a `listStyle` attribute to the `orderedList` and `bulletList` nodes and
 * exposes set/unset commands. The attribute renders as an inline
 * `list-style-type` (native token or one of the `rl-*` custom `@counter-style`
 * rules defined in styles.css) so the editor shows Roman numerals, letters,
 * parenthetical markers, etc.
 *
 * Two Word behaviours ride on the attribute (see `../listMarkers.ts`):
 *  - the numbering CASCADE — Tab (and toolbar indent) nests the item and
 *    stamps the new sublist with the successor of its parent's style
 *    (`I. → A. → 1. → a. → i.`), unless the sublist already has one;
 *  - AutoFormat input rules — typing `a. `, `iv) `, or `(b) ` at the start of
 *    a paragraph opens an ordered list with the matching style and start.
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
      /** After a sink, stamp the freshly nested list with Word's cascade
       *  successor of its parent list's style. Chain after `sinkListItem`. */
      stampListCascade: () => ReturnType;
    };
  }
}

// Map a style key to the CSS `list-style-type` value. Native CSS keywords pass
// through; the parenthetical / trailing-paren / dash variants resolve to the
// `rl-*` custom counter styles declared in styles.css.
const CUSTOM_COUNTERS = new Set([
  "decimal-paren",
  "decimal-parenthetical",
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
      stampListCascade:
        () =>
        ({ tr, dispatch }) => {
          // The sink this chains after added no steps (it failed) — nothing to
          // stamp; the whole chain fails and Tab falls through as today.
          if (!tr.steps.length) return true;
          const $from = tr.selection.$from;
          let innerDepth = 0;
          for (let d = $from.depth; d > 0; d--) {
            const name = $from.node(d).type.name;
            if (name === "orderedList" || name === "bulletList") {
              innerDepth = d;
              break;
            }
          }
          if (!innerDepth) return true;
          const inner = $from.node(innerDepth);
          // An explicit style (picker, or an existing sublist the item merged
          // into) always wins — only a freshly created null list is stamped.
          if (inner.attrs.listStyle != null) return true;
          let base: string | null | undefined;
          for (let d = innerDepth - 1; d > 0; d--) {
            const outer = $from.node(d);
            if (outer.type === inner.type) {
              base = (outer.attrs.listStyle as string | null) ?? null;
              break;
            }
          }
          // The cascade reads the nearest same-type ancestor; a lone list (or
          // an ordered list sunk inside bullets) has nothing to cascade from.
          if (base === undefined) return true;
          const next =
            inner.type.name === "orderedList"
              ? NEXT_ORDERED[base ?? "decimal"]
              : NEXT_BULLET[base ?? "disc"];
          if (!next) return true;
          if (dispatch) {
            tr.setNodeMarkup($from.before(innerDepth), undefined, {
              ...inner.attrs,
              listStyle: next,
            });
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      // Word's Tab-to-demote with the numbering cascade. ListStyle registers
      // after StarterKit, so this keymap wins over ListItem's plain sink; Table
      // registers later still, so `goToNextCell` keeps owning Tab in tables.
      Tab: () => {
        if (!this.editor.isActive("listItem")) return false;
        return this.editor
          .chain()
          .sinkListItem("listItem")
          .stampListCascade()
          .run();
      },
      // No Shift-Tab override: lifting merges the item back into the parent
      // list, which already carries its own style.
    };
  },

  addInputRules() {
    return [
      // Word AutoFormat, dot family: `a. ` / `iv. ` / `C. ` open a styled
      // list. Decimal tokens return null so StarterKit's own rule keeps
      // owning `1. `/`3. ` (null style, native start handling).
      new InputRule({
        find: /^([A-Za-z0-9]{1,6})\.\s$/,
        handler: ({ state, range, match }) => {
          const cls = classifyOrderedToken(match[1]);
          if (!cls || cls.family === "decimal") return null;
          return wrapStyledList(state, range, cls.family, cls.start);
        },
      }),
      // Trailing-paren family: `1) ` / `b) ` / `IV) `.
      new InputRule({
        find: /^([A-Za-z0-9]{1,6})\)\s$/,
        handler: ({ state, range, match }) => {
          const cls = classifyOrderedToken(match[1]);
          if (!cls) return null;
          return wrapStyledList(state, range, `${cls.family}-paren`, cls.start);
        },
      }),
      // Parenthetical family: `(1) ` / `(b) ` — lowercase + decimal only, so
      // an upper-* parenthetical style can never arise here.
      new InputRule({
        find: /^\(([a-z0-9]{1,6})\)\s$/,
        handler: ({ state, range, match }) => {
          const cls = classifyOrderedToken(match[1]);
          if (!cls) return null;
          return wrapStyledList(
            state,
            range,
            `${cls.family}-parenthetical`,
            cls.start,
          );
        },
      }),
    ];
  },
});

/** Replicate `wrappingInputRule`'s delete/wrap/join for a styled ordered list:
 *  delete the typed marker, wrap the block in an orderedList carrying
 *  `{ listStyle, start }`, and join into the list directly above only when it
 *  continues the same styled sequence (equal style, consecutive start).
 *  Returns null — rule not applied, fall through — when the wrap is invalid. */
function wrapStyledList(
  state: EditorState,
  range: Range,
  listStyle: string,
  start: number,
): null | undefined {
  const listType = state.schema.nodes.orderedList;
  if (!listType) return null;
  const attrs = { start, listStyle };
  const tr = state.tr.delete(range.from, range.to);
  const $start = tr.doc.resolve(range.from);
  const blockRange = $start.blockRange();
  const wrapping = blockRange && findWrapping(blockRange, listType, attrs);
  if (!blockRange || !wrapping) return null;
  tr.wrap(blockRange, wrapping);
  const before = tr.doc.resolve(range.from - 1).nodeBefore;
  if (
    before &&
    before.type === listType &&
    canJoin(tr.doc, range.from - 1) &&
    ((before.attrs.listStyle as string | null) ?? null) === listStyle &&
    ((before.attrs.start as number) ?? 1) + before.childCount === start
  ) {
    tr.join(range.from - 1);
  }
}
