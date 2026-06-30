// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * TableAlign — Word-style alignment of a whole table on the page.
 *
 * Plain `text-align` doesn't move a TipTap table. We:
 *  1. Add an `align` attribute ("left" | "center" | "right") to the table node
 *     — persisted in the JSON, and emitted as `data-align` for copy/paste.
 *  2. Reflect it live with a node DECORATION that adds an `rl-talign-*` class to
 *     the table's DOM. Decorations are applied by ProseMirror's own render pass
 *     (it diffs and patches outer decorations onto the node view's element), so
 *     — unlike imperatively writing classList from a plugin view — this cannot
 *     loop with the editor's mutation observer.
 *  3. Expose `setTableAlign` for the toolbar.
 *
 * Visual-only — whole-table page alignment has no markdown equivalent, so the
 * serializer ignores it (GFM tables can't express it). Our own Apache-2.0 code.
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tableAlign: {
      /** Align the table the cursor is in: left, center, or right. */
      setTableAlign: (align: "left" | "center" | "right") => ReturnType;
    };
  }
}

const alignDecorationsKey = new PluginKey("tableAlignDecorations");

export const TableAlign = Extension.create({
  name: "tableAlign",

  addGlobalAttributes() {
    return [
      {
        types: ["table"],
        attributes: {
          align: {
            default: null,
            parseHTML: (el) => el.getAttribute("data-align"),
            renderHTML: (attrs) =>
              attrs.align ? { "data-align": attrs.align } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      // Find the table from the selection — works whether the table is
      // node-selected (the move-handle), the cursor is in a cell, or cells are
      // drag-selected — and set its align attr directly by position.
      setTableAlign:
        (align) =>
        ({ state, dispatch }) => {
          const { selection } = state;
          if (
            selection instanceof NodeSelection &&
            selection.node.type.name === "table"
          ) {
            if (dispatch) {
              dispatch(
                state.tr.setNodeMarkup(selection.from, undefined, {
                  ...selection.node.attrs,
                  align,
                }),
              );
            }
            return true;
          }
          const { $from } = selection;
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name === "table") {
              const pos = $from.before(d);
              if (dispatch) {
                dispatch(
                  state.tr.setNodeMarkup(pos, undefined, {
                    ...node.attrs,
                    align,
                  }),
                );
              }
              return true;
            }
          }
          return false;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: alignDecorationsKey,
        props: {
          decorations: (state) => {
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "table") return true;
              if (node.attrs.align) {
                decos.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: `rl-talign-${node.attrs.align}`,
                  }),
                );
              }
              return false; // tables don't nest
            });
            return decos.length ? DecorationSet.create(state.doc, decos) : null;
          },
        },
      }),
    ];
  },
});
