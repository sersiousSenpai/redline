// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";
import { ChangeSet } from "@tiptap/pm/changeset";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";

export const trackChangesInputKey = new PluginKey("trackChangesInput");

/** Every inline text leaf in [from,to) carries `markName`. */
function rangeAllMarked(
  state: EditorState,
  from: number,
  to: number,
  markName: string,
): boolean {
  let sawText = false;
  let all = true;
  state.doc.nodesBetween(from, to, (n) => {
    if (n.isText) {
      sawText = true;
      if (!n.marks.some((m) => m.type.name === markName)) all = false;
    }
  });
  return sawText && all;
}

/**
 * Word-correct deletion: instead of removing original text (a fragile
 * delete-then-reinsert in the browser), mark the target range struck-through
 * *in place* — text never moves. Deleting your own still-pending insertion
 * (`rl_ins`) really removes it (accept). Returns false at block boundaries so
 * the default join behavior still runs.
 */
function trackedDelete(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  dir: -1 | 1,
): boolean {
  const { selection, schema } = state;
  const insName = "rl_ins";
  const delMark = schema.marks.rl_del;
  if (!delMark) return false;

  let from: number;
  let to: number;
  if (!selection.empty) {
    from = selection.from;
    to = selection.to;
  } else {
    const $pos = selection.$head;
    if (dir < 0) {
      if ($pos.parentOffset === 0) return false; // let default join run
      from = $pos.pos - 1;
      to = $pos.pos;
    } else {
      if ($pos.parentOffset === $pos.parent.content.size) return false;
      from = $pos.pos;
      to = $pos.pos + 1;
    }
  }
  if (to <= from) return false;

  // Removing your own un-submitted insertion → accept (really delete it).
  if (rangeAllMarked(state, from, to, insName)) {
    if (dispatch) {
      const tr = state.tr.delete(from, to);
      tr.setMeta("rl-trackchange", true);
      dispatch(tr);
    }
    return true;
  }

  if (dispatch) {
    const tr = state.tr;
    tr.addMark(from, to, delMark.create());
    // Skip the struck text so the caret keeps flowing in the press direction.
    const caret = dir < 0 ? from : to;
    tr.setSelection(TextSelection.create(tr.doc, caret));
    tr.setMeta("rl-trackchange", true); // mark op, not an insert/delete diff
    dispatch(tr);
  }
  return true;
}

/**
 * Live Word-style "suggestion mode". On every genuine user edit it rewrites
 * the change so nothing is destructively lost: newly inserted text is marked
 * `rl_ins` (proposed), and deleted text is re-inserted in place marked
 * `rl_del` (struck-through + faded) — unless the deleted text was the user's
 * own still-pending `rl_ins`, which is simply accepted away.
 *
 * The accept-all serializer collapses these marks back to clean
 * `{original, revised}`, so the existing changeLedger/sidebar sync is
 * unaffected (the sidebar mirror keeps working) and the loop terminates.
 */
export const TrackChangesInput = Extension.create({
  name: "trackChangesInput",

  addKeyboardShortcuts() {
    const run = (dir: -1 | 1) => () => {
      const { state, view } = this.editor;
      return trackedDelete(state, view.dispatch.bind(view), dir);
    };
    return {
      Backspace: run(-1),
      Delete: run(1),
      "Mod-Backspace": run(-1),
      "Mod-Delete": run(1),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: trackChangesInputKey,
        appendTransaction(transactions, oldState, newState) {
          const relevant = transactions.filter(
            (tr) =>
              tr.docChanged &&
              !tr.getMeta("rl-sync") &&
              !tr.getMeta("rl-trackchange"),
          );
          if (relevant.length === 0) return null;

          const insMark = newState.schema.marks.rl_ins;
          if (!insMark) return null;

          let cs = ChangeSet.create(oldState.doc);
          cs = cs.addSteps(
            newState.doc,
            relevant.flatMap((tr) => tr.mapping.maps),
            null,
          );
          if (cs.changes.length === 0) return null;

          const tr = newState.tr;
          // Mark genuinely inserted text as a proposed insertion. Deletions
          // are owned by the Backspace/Delete keymap (which strikes text in
          // place) — re-inserting deleted content here resurrected empty list
          // items and fought structural edits, so it is intentionally gone.
          for (const ch of cs.changes) {
            if (ch.toB > ch.fromB) {
              const from = tr.mapping.map(ch.fromB);
              const to = tr.mapping.map(ch.toB);
              if (to > from) tr.addMark(from, to, insMark.create());
            }
          }

          if (tr.steps.length === 0) return null;
          tr.setMeta("rl-trackchange", true);
          tr.setMeta("addToHistory", false);
          return tr;
        },
      }),
    ];
  },
});
