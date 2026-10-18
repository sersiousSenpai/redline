// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const marginNotesKey = new PluginKey("marginNotes");

/** One comment, drawn as a note under the block it marks. */
export interface MarginNote {
  commentId: string;
  /** The top-level block the comment's mark sits in. */
  blockId: string;
  /** Its author's initials, for the disc (lib/feedbackThreads' `noteInitials`). */
  initials: string;
  body: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    marginNotes: {
      /** Replace the notes drawn under their blocks. Empty draws none. */
      setMarginNotes: (notes: MarginNote[]) => ReturnType;
      /** Fired with the note's comment id when a note is clicked. */
      bindMarginNoteClick: (fn: ((commentId: string) => void) | null) => ReturnType;
    };
  }
}

interface MarginNotesStorage {
  notes: MarginNote[];
  onClick: ((commentId: string) => void) | null;
}

/**
 * The flow shell's split pose has no comment pane beside the plan (board
 * 4c): a mark's comment is drawn in the document instead, as a small card
 * under the block it marks. A widget decoration, so it is pure presentation —
 * nothing enters the document, the Y.Doc or the change ledger, and the block
 * text a selection reads is untouched (the card is not editable and not
 * selectable). PlanEditor sets notes only when the host asks for them; the
 * classic shell never does, so classic renders exactly as before.
 */
export const MarginNotes = Extension.create<unknown, MarginNotesStorage>({
  name: "marginNotes",

  addStorage() {
    return { notes: [], onClick: null };
  },

  addCommands() {
    return {
      setMarginNotes:
        (notes) =>
        ({ editor, tr, dispatch }) => {
          editor.storage.marginNotes.notes = notes;
          if (dispatch) dispatch(tr.setMeta(marginNotesKey, true));
          return true;
        },
      bindMarginNoteClick:
        (fn) =>
        ({ editor }) => {
          editor.storage.marginNotes.onClick = fn;
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const extension = this;
    return [
      new Plugin({
        key: marginNotesKey,
        props: {
          decorations(state) {
            const notes: MarginNote[] = extension.editor.storage.marginNotes.notes;
            if (notes.length === 0) return DecorationSet.empty;
            const byBlock = new Map<string, MarginNote[]>();
            for (const n of notes) {
              const list = byBlock.get(n.blockId);
              if (list) list.push(n);
              else byBlock.set(n.blockId, [n]);
            }
            const decos: Decoration[] = [];
            state.doc.forEach((node, offset) => {
              const id = node.attrs.blockId as string | null;
              const list = id ? byBlock.get(id) : undefined;
              if (!list) return;
              const end = offset + node.nodeSize;
              list.forEach((note, i) => {
                decos.push(
                  Decoration.widget(end, () => noteDom(note, extension.editor.storage.marginNotes), {
                    // Bound to the block before it, in order, and rebuilt
                    // only when the note itself changes.
                    side: -(list.length - i),
                    key: `mn:${note.commentId}:${note.initials}:${note.body}`,
                    ignoreSelection: true,
                    stopEvent: () => true,
                  }),
                );
              });
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

/** The note's DOM: the same classes as shell/MarginNote's `marginNoteElement`
 *  (the feedback lane's), so one stylesheet says how a note looks. Built here
 *  rather than imported, so the plan editor's chunk carries no flow CSS. */
function noteDom(note: MarginNote, storage: MarginNotesStorage): HTMLElement {
  const card = document.createElement("div");
  card.className = "rl-margin-note";
  card.setAttribute("contenteditable", "false");
  card.setAttribute("role", "note");
  card.dataset.commentId = note.commentId;
  const who = document.createElement("span");
  who.className = "rl-margin-note-avatar";
  who.textContent = note.initials;
  who.setAttribute("aria-hidden", "true");
  const body = document.createElement("span");
  body.className = "rl-margin-note-body";
  body.textContent = note.body;
  card.append(who, body);
  card.addEventListener("mousedown", (e) => e.preventDefault());
  card.addEventListener("click", () => storage.onClick?.(note.commentId));
  return card;
}
