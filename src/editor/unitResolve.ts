// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Node as PMNode } from "@tiptap/pm/model";

import type { SubAxis } from "./markdown/sidecar";
import { segmentSourceLines } from "./sentenceSegment";

/**
 * The ProseMirror-side counterpart to the DOM capture in `domPoint`: given a
 * structured top-level block (list / table / code) and a `.lN` line-axis
 * index, locate the addressed *unit* — the N-th list item, the N-th cell
 * (row-major), or the N-th source line of a code block — and return enough to
 * paint a highlight or splice an edit against just that unit.
 *
 * The single load-bearing invariant of the granular-anchoring rework lives
 * here: the capture-side unit index (DOM order of `<li>`/`<td>`, or
 * `segmentSourceLines` index for code) must equal the resolve-side index this
 * function walks. DOM document order and PM descendant order agree, and code
 * lines segment identically on both sides, so the index round-trips.
 */
export interface UnitNode {
  /** Doc position of the first character inside the unit's textblock, relative
   *  to the block node's own doc position (`blockOffset`). So the absolute
   *  start is `blockOffset + contentStart + charBase`. For a code block this is
   *  `1` (the block *is* the textblock); for a list item / table cell it is the
   *  `node.descendants` position plus 2 — one token to enter the block, one to
   *  enter the textblock — which holds at any nesting depth. */
  contentStart: number;
  /** Char offset within the textblock's `textContent` where the unit's text
   *  begins. Zero for list items / cells (the whole textblock is the unit);
   *  non-zero for a code source line, which is a slice of the code block's one
   *  text node. */
  charBase: number;
  /** The unit's own text — what word ranges resolve against. */
  unitText: string;
}

/** Walk `block`'s descendants and, for the N-th node matching `isUnit` (1-based,
 *  document order), return its first textblock and that textblock's
 *  block-relative position. */
function nthUnitTextblock(
  block: PMNode,
  isUnit: (node: PMNode) => boolean,
  n: number,
): { node: PMNode; pos: number } | null {
  let count = 0;
  let armed = false;
  let result: { node: PMNode; pos: number } | null = null;
  block.descendants((node, pos) => {
    if (result) return false;
    if (isUnit(node)) {
      count += 1;
      armed = count === n;
      return true; // descend to find this unit's textblock
    }
    if (armed && node.isTextblock) {
      result = { node, pos };
      return false;
    }
    return true;
  });
  return result;
}

/** Resolve a `.lN` axis index to the unit it addresses inside `block`. Returns
 *  `null` for non-line axes, unsupported block kinds, or an index past the end
 *  (a drifted id self-heals via the char/quotedText fallback tiers). */
export function findUnitNode(block: PMNode, axis: SubAxis): UnitNode | null {
  if (axis.kind !== "line") return null;
  const index = axis.index; // 1-based

  if (block.type.name === "codeBlock") {
    // The code block is a single textblock; its units are source lines.
    const line = segmentSourceLines(block.textContent)[index - 1];
    if (!line) return null;
    return { contentStart: 1, charBase: line.start, unitText: line.text };
  }

  let isUnit: ((node: PMNode) => boolean) | null = null;
  if (block.type.name === "bulletList" || block.type.name === "orderedList") {
    isUnit = (node) => node.type.name === "listItem";
  } else if (block.type.name === "table") {
    isUnit = (node) =>
      node.type.name === "tableCell" || node.type.name === "tableHeader";
  }
  if (!isUnit) return null;

  const tb = nthUnitTextblock(block, isUnit, index);
  if (!tb) return null;
  // `tb.pos` is content-relative (block content starts at blockOffset + 1);
  // +2 steps through the block's and the textblock's opening tokens.
  return { contentStart: tb.pos + 2, charBase: 0, unitText: tb.node.textContent };
}
