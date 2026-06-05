// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const commentMarkersKey = new PluginKey("commentMarkers");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    commentMarkers: {
      /** Replace the set of blockIds that should show a "has comments" dot
       *  in the left gutter. Empty set hides all dots. */
      setCommentedBlocks: (ids: Set<string>) => ReturnType;
    };
  }
}

interface CommentMarkersStorage {
  ids: Set<string>;
}

/**
 * Adds a `.rl-has-comments` class to every top-level block whose `blockId` is
 * in the supplied set. Pure presentation — the gutter dot in `styles.css`
 * picks it up. Kept separate from `RedlineDecorations` so the two affordances
 * (revision redline vs. comments-on-block) can be toggled and reasoned about
 * independently.
 */
export const CommentMarkers = Extension.create<unknown, CommentMarkersStorage>({
  name: "commentMarkers",

  addStorage() {
    return { ids: new Set<string>() };
  },

  addCommands() {
    return {
      setCommentedBlocks:
        (ids) =>
        ({ editor, tr, dispatch }) => {
          editor.storage.commentMarkers.ids = ids;
          if (dispatch) dispatch(tr.setMeta(commentMarkersKey, true));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const extension = this;
    return [
      new Plugin({
        key: commentMarkersKey,
        props: {
          decorations(state) {
            const ids: Set<string> =
              extension.editor.storage.commentMarkers.ids;
            if (ids.size === 0) return DecorationSet.empty;
            const decos: Decoration[] = [];
            state.doc.forEach((node, offset) => {
              const id = node.attrs.blockId as string | null;
              if (!id || !ids.has(id)) return;
              decos.push(
                Decoration.node(offset, offset + node.nodeSize, {
                  class: "rl-has-comments",
                }),
              );
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});
