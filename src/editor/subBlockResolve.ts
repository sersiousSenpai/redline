// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

import {
  parseSidecarIdTyped,
  sidecarIdToString,
  type SidecarId,
  type SubAxis,
  type WordRange,
} from "./markdown/sidecar";
import { segmentSentences, segmentSourceLines } from "./sentenceSegment";
import { tokenize } from "./wordDiff";

/** Which addressing axis applies to a given block. Code blocks, lists, and
 *  blockquotes get the source-line axis (`.lN`) because their markdown
 *  source carries hard newlines; everything else gets the sentence axis
 *  (`.sN`) because source-line indexing would collapse to `.l1` for any
 *  normal prose paragraph or heading. */
export type BlockKind = "line" | "sentence";

/** Map a DOM tag name (uppercase) to the axis the block uses. Defaults to
 *  sentence; callers pass an element they've already verified carries a
 *  redline block id. */
export function blockKindForTag(tagName: string): BlockKind {
  const t = tagName.toUpperCase();
  if (t === "PRE" || t === "CODE") return "line";
  if (t === "UL" || t === "OL" || t === "LI") return "line";
  if (t === "BLOCKQUOTE") return "line";
  return "sentence";
}

/** Inclusive char-range within a block's `textContent`. */
export interface CharRange {
  start: number;
  end: number;
}

/** Compute the canonical sub-block id for a selection within `blockText`,
 *  given the parent `blockId` and the block's axis. Returns `undefined`
 *  when the selection doesn't land on a clean unit boundary — partial
 *  selections, multi-unit spans, and zero-length selections all leave the
 *  comment to fall back to its char-offset anchor. */
export function computeSubBlockId(args: {
  blockId: string;
  blockText: string;
  kind: BlockKind;
  charStart: number;
  charEnd: number;
}): string | undefined {
  const { blockId, blockText, kind, charStart, charEnd } = args;
  if (charEnd <= charStart) return undefined;
  const units =
    kind === "line"
      ? segmentSourceLines(blockText)
      : segmentSentences(blockText);
  if (units.length === 0) return undefined;
  // Selection must lie inside exactly one unit. If start is inside unit i
  // and end is inside the same unit (or at its trimmed boundary), we
  // address against that unit; otherwise the selection crosses a unit
  // boundary and is too coarse for sub-block addressing.
  const startIdx = units.findIndex(
    (u) => charStart >= u.start && charStart < u.end,
  );
  if (startIdx === -1) return undefined;
  const unit = units[startIdx];
  if (charEnd > unit.end) return undefined;

  const axis: SubAxis =
    kind === "line"
      ? { kind: "line", index: startIdx + 1 }
      : { kind: "sentence", index: startIdx + 1 };

  // Whole-unit selection: no word qualifier.
  if (charStart === unit.start && charEnd === unit.end) {
    return sidecarIdToString({
      kind: "subBlock",
      blockId,
      axis,
      words: null,
    });
  }

  // Word qualifier: the selection must align with whole-word boundaries
  // inside the unit. Tokenize the unit, find the token span the selection
  // covers exactly, and emit `.wN[-wM]`.
  const tokens = tokenize(unit.text);
  const wordRange = findWordRange(unit, tokens, charStart, charEnd);
  if (!wordRange) return undefined;
  return sidecarIdToString({
    kind: "subBlock",
    blockId,
    axis,
    words: wordRange,
  });
}

/** Resolve a sub-block id against a block's current text. Returns the
 *  char-range the id points to, or `null` if the id doesn't land (parent
 *  block reworded, sentence index past the end, word range out of bounds).
 *  Returns null for `kind === "block"` ids — those don't address a
 *  sub-range. */
export function resolveSubBlockId(args: {
  blockText: string;
  kind: BlockKind;
  subBlockId: string;
}): CharRange | null {
  const parsed = parseSidecarIdTyped(args.subBlockId);
  if (!parsed || parsed.kind !== "subBlock") return null;
  const { axis, words } = parsed;
  // Sanity: id's axis must match the current block kind. A `.s3` id on a
  // code block won't resolve (axis mismatch).
  const expectedAxis: SubAxis["kind"] =
    args.kind === "line" ? "line" : "sentence";
  if (axis.kind !== expectedAxis) return null;
  const units =
    args.kind === "line"
      ? segmentSourceLines(args.blockText)
      : segmentSentences(args.blockText);
  const unit = units[axis.index - 1];
  if (!unit) return null;
  if (!words) return { start: unit.start, end: unit.end };
  const tokens = tokenize(unit.text);
  const range = wordRangeToCharRange(unit, tokens, words);
  if (!range) return null;
  return range;
}

/** Inverse of `findWordRange`: take a `WordRange` (1-based inclusive) and
 *  return the unit-relative char span, offset back into block coords. */
function wordRangeToCharRange(
  unit: { start: number; text: string },
  tokens: string[],
  words: WordRange,
): CharRange | null {
  // Map token index (incl. whitespace tokens) to (start, end) within unit.text.
  // Whitespace tokens count as separators; we want word-tokens only (1-indexed).
  let wordIdx = 0;
  let charPos = 0;
  let wordStart: number | null = null;
  let wordEnd: number | null = null;
  for (const t of tokens) {
    const isSpace = /^\s+$/.test(t);
    if (!isSpace) {
      wordIdx++;
      if (wordIdx === words.start) wordStart = charPos;
      if (wordIdx === words.end) wordEnd = charPos + t.length;
    }
    charPos += t.length;
  }
  if (wordStart == null || wordEnd == null) return null;
  return { start: unit.start + wordStart, end: unit.start + wordEnd };
}

/** Given a selection covering chars [charStart, charEnd) within a unit
 *  starting at unit.start, find the (start, end) word indices it covers
 *  exactly. Returns null if either boundary doesn't align with a word
 *  boundary inside the unit. */
function findWordRange(
  unit: { start: number; text: string },
  tokens: string[],
  charStart: number,
  charEnd: number,
): WordRange | null {
  const rel = { start: charStart - unit.start, end: charEnd - unit.start };
  let wordIdx = 0;
  let charPos = 0;
  let selStart: number | null = null;
  let selEnd: number | null = null;
  for (const t of tokens) {
    const isSpace = /^\s+$/.test(t);
    const tokenStart = charPos;
    const tokenEnd = charPos + t.length;
    if (!isSpace) {
      wordIdx++;
      if (rel.start === tokenStart) selStart = wordIdx;
      if (rel.end === tokenEnd) selEnd = wordIdx;
    }
    charPos = tokenEnd;
  }
  if (selStart == null || selEnd == null) return null;
  if (selEnd < selStart) return null;
  return { start: selStart, end: selEnd };
}

/** Re-export the parsed enum for callers that need to introspect (e.g. the
 *  diff decomposer). Pure pass-through — no behavior added. */
export { type SidecarId, parseSidecarIdTyped };
