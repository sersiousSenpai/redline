// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension, getMarkRange } from "@tiptap/core";
import { ChangeSet } from "@tiptap/pm/changeset";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ySyncPluginKey } from "y-prosemirror";

import {
  isPendingSuggestionMark,
  newSuggestionId,
  USER_AUTHOR,
} from "./TrackChanges";

export const trackChangesInputKey = new PluginKey("trackChangesInput");

export interface TrackChangesInputOptions {
  /** Called when a user edit was blocked because its block carries a pending
   *  foreign-author (agent) suggestion — surface "resolve it first" UI. */
  onLockedEdit?: (blockId: string) => void;
}

interface TrackChangesInputStorage {
  /** Top-level blocks currently owned by a pending foreign-author suggestion
   *  (set via `setLockedBlocks`). User edits inside them are filtered out. */
  lockedBlockIds: Set<string>;
}

/**
 * Suggestion identity for a new mark at [from,to): reuse the suggestionId of
 * an adjacent pending run of the same mark type by the same author, so
 * keystroke-by-keystroke typing coalesces into ONE suggestion instead of one
 * per character. Falls back to a fresh id.
 */
function suggestionIdAt(
  doc: PMNode,
  from: number,
  to: number,
  markName: string,
): string {
  const neighbor = (n: PMNode | null | undefined) => {
    if (!n || !n.isText) return null;
    const m = n.marks.find(
      (m) =>
        m.type.name === markName &&
        isPendingSuggestionMark(m) &&
        (m.attrs.authorId ?? USER_AUTHOR) === USER_AUTHOR &&
        m.attrs.suggestionId,
    );
    return m ? (m.attrs.suggestionId as string) : null;
  };
  return (
    neighbor(doc.resolve(from).nodeBefore) ??
    neighbor(doc.resolve(to).nodeAfter) ??
    newSuggestionId()
  );
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    trackChangesInput: {
      /** Strike the current (non-empty) selection exactly as the Delete key
       *  would: mark it `rl_del` in place (or accept-delete an own pending
       *  `rl_ins`). No-op on an empty selection. */
      strikeSelection: () => ReturnType;
      /** Replace the set of blocks locked against user edits (M4: blocks
       *  owned by a pending agent suggestion — "resolve it first"). */
      setLockedBlocks: (blockIds: string[]) => ReturnType;
    };
  }
}

/**
 * The first locked top-level block a transaction touches, or null. Each
 * step's affected range is mapped back through the earlier steps so every
 * range is expressed against `state.doc` (the doc the transaction applies
 * to), then intersected with the locked blocks' extents.
 */
function lockedBlockTouched(
  tr: Transaction,
  state: EditorState,
  locked: ReadonlySet<string>,
): string | null {
  const ranges: { from: number; to: number }[] = [];
  tr.steps.forEach((step, i) => {
    const inv = tr.mapping.slice(0, i).invert();
    // Mark steps (Add/RemoveMarkStep) have an EMPTY position map — positions
    // don't move — so the step's own from/to is the only record of its range.
    const s = step as unknown as { from?: number; to?: number; pos?: number };
    if (typeof s.from === "number" && typeof s.to === "number") {
      ranges.push({ from: inv.map(s.from, -1), to: inv.map(s.to, 1) });
    } else if (typeof s.pos === "number") {
      ranges.push({ from: inv.map(s.pos, -1), to: inv.map(s.pos, 1) });
    } else {
      tr.mapping.maps[i].forEach((fromA, toA) => {
        ranges.push({ from: inv.map(fromA, -1), to: inv.map(toA, 1) });
      });
    }
  });
  if (ranges.length === 0) return null;

  let hit: string | null = null;
  state.doc.forEach((node, pos) => {
    if (hit) return;
    const id = node.attrs?.blockId as string | null | undefined;
    if (!id || !locked.has(id)) return;
    const end = pos + node.nodeSize;
    if (ranges.some((r) => r.from < end && r.to > pos)) hit = id;
  });
  return hit;
}

/** Every inline text leaf in [from,to) carries a still-PENDING `markName`.
 *  Status matters: text whose `rl_ins` was accepted in place (M4 agent
 *  suggestions) is settled content — deleting it must strike it like any
 *  original text, not hard-remove it as "your own pending insertion". */
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
      if (
        !n.marks.some(
          (m) => m.type.name === markName && isPendingSuggestionMark(m),
        )
      )
        all = false;
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
    // If the caret sits against an inline-code span (a file-reference chip),
    // strike the WHOLE chip at once. Nibbling one character at a time off a
    // `path/to/file.tsx` chip is never what the user means — they want the
    // file removed from the plan as a unit.
    const codeType = schema.marks.code;
    if (codeType) {
      const range = getMarkRange(state.doc.resolve(from), codeType);
      if (range) {
        from = range.from;
        to = range.to;
      }
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
    tr.addMark(
      from,
      to,
      delMark.create({
        authorId: USER_AUTHOR,
        suggestionId: suggestionIdAt(state.doc, from, to, "rl_del"),
        status: "pending",
      }),
    );
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
export const TrackChangesInput = Extension.create<
  TrackChangesInputOptions,
  TrackChangesInputStorage
>({
  name: "trackChangesInput",

  addOptions() {
    return { onLockedEdit: undefined };
  },

  addStorage() {
    return { lockedBlockIds: new Set<string>() };
  },

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

  addCommands() {
    return {
      strikeSelection:
        () =>
        ({ state, dispatch }) => {
          if (state.selection.empty) return false;
          // dir is irrelevant for a non-empty selection — trackedDelete keys
          // off selection.from/to and lands the caret at `from`.
          return trackedDelete(state, dispatch, -1);
        },
      setLockedBlocks: (blockIds: string[]) => () => {
        // Enforcement-only state read by filterTransaction — no transaction
        // to dispatch.
        this.storage.lockedBlockIds = new Set(blockIds);
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const ext = this;
    return [
      new Plugin({
        key: trackChangesInputKey,
        // M4 lock: while a block is owned by a pending foreign-author (agent)
        // suggestion, user edits inside it are rejected — accept or reject
        // the suggestion first. Derived writes pass: rl-sync (materialize/
        // reject/accept projections) and ySync (CRDT hydration, undo/redo,
        // future remote edits). `rl-trackchange` strikes are genuine user
        // edits and stay subject to the lock.
        filterTransaction(tr, state) {
          if (!tr.docChanged) return true;
          if (tr.getMeta("rl-sync") || tr.getMeta(ySyncPluginKey)) return true;
          const locked = ext.storage.lockedBlockIds;
          if (locked.size === 0) return true;
          const hit = lockedBlockTouched(tr, state, locked);
          if (hit) {
            ext.options.onLockedEdit?.(hit);
            return false;
          }
          return true;
        },
        appendTransaction(transactions, oldState, newState) {
          const relevant = transactions.filter(
            (tr) =>
              tr.docChanged &&
              !tr.getMeta("rl-sync") &&
              !tr.getMeta("rl-trackchange") &&
              // CRDT binding writes — initial render of a (restored) Y.Doc,
              // undo/redo, future remote edits — are content *arriving*,
              // never a local user edit to mark as a suggestion.
              !tr.getMeta(ySyncPluginKey),
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
              if (to > from) {
                tr.addMark(
                  from,
                  to,
                  insMark.create({
                    authorId: USER_AUTHOR,
                    suggestionId: suggestionIdAt(
                      newState.doc,
                      from,
                      to,
                      "rl_ins",
                    ),
                    status: "pending",
                  }),
                );
              }
            }
          }

          if (tr.steps.length === 0) return null;
          tr.setMeta("rl-trackchange", true);
          // No `addToHistory: false` here, deliberately: this appended tr
          // lands in the SAME dispatch batch as the user edit it decorates,
          // and y-prosemirror derives one addToHistory flag per batch
          // (last transaction wins) — tagging it would poison the batch and
          // keep the user's own edit out of the Yjs undo stack. Captured
          // together, undo reverts text + suggestion mark as one item,
          // which is exactly right. Standalone derived writes (docModel's
          // reconcile/projection) keep the tag — their batches are wholly
          // derived and must stay un-undoable.
          return tr;
        },
      }),
    ];
  },
});
