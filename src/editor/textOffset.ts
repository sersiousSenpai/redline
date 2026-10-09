// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Node as PMNode } from "@tiptap/pm/model";

/** Map a plaintext offset inside `node` (in `textContent` units — text nodes
 *  only, so neither structural tokens nor leaves like hardBreak contribute) to
 *  a ProseMirror position relative to the start of `node`'s content. For the
 *  doc that is already absolute; for a top-level block at `blockOffset` the
 *  absolute position is `blockOffset + 1 + result` (the `+1` enters the block).
 *  Plain base+offset arithmetic is not enough precisely because list items,
 *  paragraphs and zero-width leaves still occupy positions.
 *
 *  An offset on the boundary between two text nodes belongs to both; `bias`
 *  picks one. `1` resolves to the start of the next node (a range's `from`,
 *  so a selection starting at item 2 doesn't begin at the end of item 1),
 *  `-1` to the end of the previous one (a range's `to`). Returns `null` when
 *  the offset lies past the end of the text. */
export function textOffsetToPos(
  node: PMNode,
  offset: number,
  bias: 1 | -1,
): number | null {
  let acc = 0;
  let lastEnd: number | null = null;
  let result: number | null = null;
  node.descendants((child, pos) => {
    if (result !== null) return false;
    if (!child.isText) return true;
    const len = child.text?.length ?? 0;
    if (bias === 1 ? offset < acc + len : offset <= acc + len) {
      result = pos + (offset - acc);
      return false;
    }
    acc += len;
    lastEnd = pos + len;
    return true;
  });
  // A forward-biased offset at the very end has no next node to start.
  if (result === null && bias === 1 && offset === acc) return lastEnd;
  return result;
}
