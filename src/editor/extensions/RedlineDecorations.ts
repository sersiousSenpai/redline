// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import type { ParagraphDiffStatus, SubBlockDiffEntry } from "../../diff";
import { resolveSubBlockId } from "../subBlockResolve";

export const redlineDecorationsKey = new PluginKey("redlineDecorations");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    redlineDecorations: {
      /** Replace the blockId→revision-status map and repaint decorations. */
      setRedlineStatuses: (
        statuses: Map<string, ParagraphDiffStatus>,
      ) => ReturnType;
      /** Replace the per-block sub-block decomposition. When a block has
       *  any `modified` sub-block entries, the gutter bar paints only those
       *  sentence ranges instead of the whole paragraph. */
      setRedlineSubBlocks: (
        subBlocks: Map<string, SubBlockDiffEntry[]>,
      ) => ReturnType;
    };
  }
}

interface RedlineStorage {
  statuses: Map<string, ParagraphDiffStatus>;
  subBlocks: Map<string, SubBlockDiffEntry[]>;
}

const CLASS: Record<ParagraphDiffStatus, string | null> = {
  unchanged: null,
  added: "rl-block-added",
  modified: "rl-block-modified",
  moved: "rl-block-moved",
};

// A modified block that already carries inline rl_ins/rl_del marks gets the
// narrower "precision" treatment: gutter bar at the block edge instead of a
// full-paragraph background, so the reviewer's eye lands on the actually-
// changed words. Added/moved blocks keep the full-node paint (no inline marks
// exist for them).
const PRECISION_CLASS = "rl-block-changed-bar";

/**
 * Revision-level redline (vN vs vN-1) as block decorations keyed by the stable
 * `blockId`. Phase 1 shows the same add/modify/move affordance the old
 * `Document.tsx` rendered with borders; Phase 4 folds this into the inline
 * ins/del track-change language.
 */
// True when a block node contains any inline track-change marks
// (rl_ins/rl_del). When it does, the inline marks already pinpoint the changed
// words and the full-node modified background becomes visual noise.
function blockHasTrackMarks(
  node: import("@tiptap/pm/model").Node,
  insName: string | undefined,
  delName: string | undefined,
): boolean {
  if (!insName && !delName) return false;
  let found = false;
  node.descendants((child) => {
    if (found) return false;
    if (!child.marks.length) return true;
    for (const m of child.marks) {
      if (m.type.name === insName || m.type.name === delName) {
        found = true;
        return false;
      }
    }
    return true;
  });
  return found;
}

export const RedlineDecorations = Extension.create<unknown, RedlineStorage>({
  name: "redlineDecorations",

  addStorage() {
    return { statuses: new Map(), subBlocks: new Map() };
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
      setRedlineSubBlocks:
        (subBlocks) =>
        ({ editor, tr, dispatch }) => {
          editor.storage.redlineDecorations.subBlocks = subBlocks;
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
            const subBlocks: Map<string, SubBlockDiffEntry[]> =
              extension.editor.storage.redlineDecorations.subBlocks;
            if (statuses.size === 0) return DecorationSet.empty;
            const insMarkName = state.schema.marks.rl_ins?.name;
            const delMarkName = state.schema.marks.rl_del?.name;
            const decos: Decoration[] = [];
            state.doc.forEach((node, offset) => {
              const id = node.attrs.blockId as string | null;
              if (!id) return;
              const status = statuses.get(id) ?? "unchanged";
              const cls = CLASS[status];
              if (!cls) return;

              // Sentence-level decomposition wins when present: paint
              // inline decorations over just the modified sentences,
              // skip the node-wide paint entirely. This is the visible
              // payoff of sub-block addressing — a 4-sentence paragraph
              // with one changed sentence no longer reads as wholly
              // modified.
              const decomp = subBlocks.get(id);
              if (status === "modified" && decomp && decomp.length > 0) {
                const modified = decomp.filter((e) => e.status === "modified");
                if (modified.length > 0) {
                  const text = node.textContent;
                  for (const entry of modified) {
                    const r = resolveSubBlockId({
                      blockText: text,
                      kind: "sentence",
                      subBlockId: entry.subBlockId,
                    });
                    if (!r) continue;
                    // First doc position INSIDE the node is `offset + 1`
                    // (step through the opening token).
                    const base = offset + 1;
                    decos.push(
                      Decoration.inline(base + r.start, base + r.end, {
                        class: PRECISION_CLASS,
                      }),
                    );
                  }
                  return;
                }
              }

              const precise =
                status === "modified" &&
                blockHasTrackMarks(node, insMarkName, delMarkName);
              decos.push(
                Decoration.node(offset, offset + node.nodeSize, {
                  class: precise ? PRECISION_CLASS : cls,
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
