import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import type { ParagraphDiffStatus } from "../../diff";

export const redlineDecorationsKey = new PluginKey("redlineDecorations");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    redlineDecorations: {
      /** Replace the blockId→revision-status map and repaint decorations. */
      setRedlineStatuses: (
        statuses: Map<string, ParagraphDiffStatus>,
      ) => ReturnType;
    };
  }
}

interface RedlineStorage {
  statuses: Map<string, ParagraphDiffStatus>;
}

const CLASS: Record<ParagraphDiffStatus, string | null> = {
  unchanged: null,
  added: "rl-block-added",
  modified: "rl-block-modified",
  moved: "rl-block-moved",
};

/**
 * Revision-level redline (vN vs vN-1) as block decorations keyed by the stable
 * `blockId`. Phase 1 shows the same add/modify/move affordance the old
 * `Document.tsx` rendered with borders; Phase 4 folds this into the inline
 * ins/del track-change language.
 */
export const RedlineDecorations = Extension.create<unknown, RedlineStorage>({
  name: "redlineDecorations",

  addStorage() {
    return { statuses: new Map() };
  },

  addCommands() {
    return {
      setRedlineStatuses:
        (statuses) =>
        ({ editor, tr, dispatch }) => {
          editor.storage.redlineDecorations.statuses = statuses;
          if (dispatch) dispatch(tr.setMeta(redlineDecorationsKey, true));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const extension = this;
    return [
      new Plugin({
        key: redlineDecorationsKey,
        props: {
          decorations(state) {
            const statuses: Map<string, ParagraphDiffStatus> =
              extension.editor.storage.redlineDecorations.statuses;
            if (statuses.size === 0) return DecorationSet.empty;
            const decos: Decoration[] = [];
            state.doc.forEach((node, offset) => {
              const id = node.attrs.blockId as string | null;
              if (!id) return;
              const cls = CLASS[statuses.get(id) ?? "unchanged"];
              if (cls) {
                decos.push(
                  Decoration.node(offset, offset + node.nodeSize, {
                    class: cls,
                  }),
                );
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});
