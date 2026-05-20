// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Comment } from "../types";
import { commentsToBlockOverrides } from "./changeLedger";

/** The editor's writable view of one block's body. */
export interface BlockHandle {
  blockId: string;
  /** Current markdown the editor shows for this block. */
  getMarkdown: () => string;
  /** Replace the block body; `meta` lets the editor tag the transaction so
   *  the sync recompute can ignore its own echo (the "rl-sync" guard). */
  setMarkdown: (markdown: string, meta: { source: "rl-sync" }) => void;
}

/**
 * Reverse projection (sidebar → document).
 *
 * Given the persisted comments, force every editor-owned block to the
 * markdown its comment dictates, and restore reverted/deleted-comment blocks
 * to their immutable base. Writes are tagged `rl-sync` so the debounced
 * doc→sidebar pass treats them as echoes and emits no ops.
 *
 * Idempotent: a block already matching its target is skipped, so calling this
 * on every `comments-changed` event is a no-op once the doc and the comment
 * set agree.
 *
 * @returns the blockIds actually rewritten (for logging / tests).
 */
export function applyCommentsToDoc(
  comments: Comment[],
  blocks: BlockHandle[],
  base: Map<string, string>,
): string[] {
  const overrides = commentsToBlockOverrides(comments);
  const touched: string[] = [];

  for (const block of blocks) {
    const target =
      overrides.get(block.blockId) ?? base.get(block.blockId) ?? null;
    if (target === null) continue;
    if (block.getMarkdown() === target) continue; // already reconciled
    block.setMarkdown(target, { source: "rl-sync" });
    touched.push(block.blockId);
  }
  return touched;
}
