// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";

/**
 * TableControls — Word-like table selection & deletion for the Prompt Drafter.
 *
 * ProseMirror tables are frustrating out of the box: there's no way to "select
 * the table" the way Word lets you (click the move-handle, then Backspace), and
 * drag-selecting cells + Delete only clears cell *contents* — the table stays.
 *
 * This adds two Word affordances:
 *  1. A **table handle** — a small grip rendered at the top-left of the table
 *     the cursor is in. Clicking it node-selects the whole table; Backspace /
 *     Delete then removes it (ProseMirror's default deleteSelection handles a
 *     NodeSelection). The grip floats in the page margin and is repositioned on
 *     every state change (it lives inside `.rl-page`, which scrolls with the
 *     table, so no scroll listener is needed).
 *  2. **Whole-table delete via cell selection** — if a CellSelection spans every
 *     row *and* column (the entire table), Backspace/Delete deletes the table.
 *
 * Our own Apache-2.0 code; relies on the table extensions already registered.
 */

interface TableInfo {
  pos: number; // position directly before the table node
}

/** Find the table containing the current selection (or the node-selected table). */
function findTable(state: EditorState): TableInfo | null {
  const { selection } = state;
  if (
    selection instanceof NodeSelection &&
    selection.node.type.name === "table"
  ) {
    return { pos: selection.from };
  }
  const { $from } = selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "table") {
      return { pos: $from.before(d) };
    }
  }
  return null;
}

const MOVE_ICON =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/></svg>';

export const TableControls = Extension.create({
  name: "tableControls",

  addKeyboardShortcuts() {
    const deleteWholeTableIfFullySelected = () => {
      const { selection } = this.editor.state;
      if (
        selection instanceof CellSelection &&
        selection.isRowSelection() &&
        selection.isColSelection()
      ) {
        return this.editor.commands.deleteTable();
      }
      return false; // fall through (clear cells, or delete a node selection)
    };

    return {
      Backspace: deleteWholeTableIfFullySelected,
      Delete: deleteWholeTableIfFullySelected,
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("tableHandle"),
        view(editorView) {
          // The grip is positioned `fixed` in viewport coordinates taken
          // straight from the table's getBoundingClientRect — no offset-parent
          // math to get wrong — and lives on <body> so no ancestor clips it.
          // The scroll container is watched so the grip tracks the table.
          const scroller = editorView.dom.closest(
            ".rl-page-workspace",
          ) as HTMLElement | null;
          const grip = document.createElement("button");
          grip.type = "button";
          grip.className = "rl-table-grip";
          grip.title = "Select table (then ⌫ to delete)";
          grip.setAttribute("aria-label", "Select table");
          grip.innerHTML = MOVE_ICON;
          grip.style.display = "none";
          grip.addEventListener("mousedown", (e) => {
            e.preventDefault();
            const info = findTable(editorView.state);
            if (!info) return;
            editorView.dispatch(
              editorView.state.tr.setSelection(
                NodeSelection.create(editorView.state.doc, info.pos),
              ),
            );
            editorView.focus();
          });
          document.body.appendChild(grip);

          const reposition = () => {
            const info = findTable(editorView.state);
            const dom = info ? editorView.nodeDOM(info.pos) : null;
            const tableEl =
              dom instanceof HTMLElement
                ? dom.tagName === "TABLE"
                  ? dom
                  : (dom.querySelector("table") ?? dom)
                : null;
            if (!tableEl) {
              grip.style.display = "none";
              return;
            }
            const r = tableEl.getBoundingClientRect();
            // Hide when the table scrolls out of the visible page area.
            const clip = scroller?.getBoundingClientRect();
            if (clip && (r.bottom < clip.top || r.top > clip.bottom)) {
              grip.style.display = "none";
              return;
            }
            grip.style.display = "block";
            grip.style.left = `${r.left - 21}px`;
            grip.style.top = `${r.top - 1}px`;
          };

          const onScroll = () => reposition();
          scroller?.addEventListener("scroll", onScroll, { passive: true });
          window.addEventListener("resize", onScroll);
          reposition();
          return {
            update: () => reposition(),
            destroy: () => {
              scroller?.removeEventListener("scroll", onScroll);
              window.removeEventListener("resize", onScroll);
              grip.remove();
            },
          };
        },
      }),
    ];
  },
});
