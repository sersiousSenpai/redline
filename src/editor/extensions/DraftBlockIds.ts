// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { BLOCK_ID_NODE_TYPES } from "./BlockIdAttribute";

/**
 * Self-minted block identity for the Prompt Drafter.
 *
 * The plan editor gets its `blockId`s from the Rust parser (every revision
 * round-trips through the daemon). A draft never does — it lives in the
 * editor and is only *mirrored* out — so the drafter mints its own ids:
 * an `appendTransaction` gives every top-level block missing a `blockId` a
 * fresh `blk-xxxxxxxx`, and mirrors it into `anchorId` (draft comments anchor
 * at block granularity, so anchor == block here).
 *
 * With ids in place, `planDocToMarkdown(doc, { sidecars: true })` emits
 * `<!-- rl:blk-… -->` markers into the mirror — which is what lets the draft
 * agents address suggestions to a block and lets `useTextSelection` +
 * `CommentHighlights` work over the drafter unchanged.
 */

const TYPES: ReadonlySet<string> = new Set(BLOCK_ID_NODE_TYPES);

export function mintBlockId(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `blk-${rand}`;
}

import type { EditorState, Transaction } from "@tiptap/pm/state";

/** Build the id-fix transaction for `state`, or null when nothing needs
 *  stamping. Mints for blocks missing an id, re-mints duplicates (a
 *  split/copy can duplicate attrs), and mirrors `anchorId = blockId`. */
function fixTransaction(state: EditorState): Transaction | null {
  const seen = new Set<string>();
  const fixes: { pos: number; id: string | null }[] = [];
  state.doc.forEach((node, pos) => {
    if (!TYPES.has(node.type.name)) return;
    const id = node.attrs.blockId as string | null;
    if (id && !seen.has(id)) {
      seen.add(id);
      if (node.attrs.anchorId !== id) fixes.push({ pos, id });
      return;
    }
    fixes.push({ pos, id: null });
  });
  if (fixes.length === 0) return null;
  const tr = state.tr;
  for (const f of fixes) {
    const node = state.doc.nodeAt(f.pos);
    if (!node) continue;
    const id = f.id ?? mintBlockId();
    tr.setNodeMarkup(f.pos, undefined, {
      ...node.attrs,
      blockId: id,
      anchorId: id,
    });
  }
  if (tr.steps.length === 0) return null;
  tr.setMeta("addToHistory", false);
  return tr;
}

export const DraftBlockIds = Extension.create({
  name: "draftBlockIds",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("draftBlockIds"),
        // Stamp ids on first load — editor creation builds the doc without a
        // transaction, so appendTransaction never sees it. The plugin `view`
        // hook runs synchronously when the EditorView mounts.
        view(view) {
          const tr = fixTransaction(view.state);
          if (tr) view.dispatch(tr);
          return {};
        },
        appendTransaction: (transactions, _old, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          return fixTransaction(state);
        },
      }),
    ];
  },
});
