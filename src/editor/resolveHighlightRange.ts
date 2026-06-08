// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { blockKindForTag, resolveSubBlockId } from "./subBlockResolve";

/** A persistent highlight over a comment's selected character range. The
 *  decoration is keyed by `(blockId, charStart, charEnd)` with three
 *  resolution tiers (see {@link resolveRange}): the sub-block id is tried
 *  first when present, then the stored char range, finally `quotedText`
 *  self-heal.
 *
 *  Engine-agnostic: shared by the Tiptap `CommentHighlights` plugin (which
 *  paints ProseMirror decorations) and the static-HTML `HtmlAnnotationOverlay`
 *  (which paints absolutely-positioned rects). Both resolve a stored selection
 *  to character offsets the same way — only the rendering differs. */
export interface CommentHighlightRange {
  commentId: string;
  blockId: string;
  charStart: number;
  charEnd: number;
  quotedText: string;
  /** Optional sub-block sidecar id (e.g. `blk-X.s3.w2-w4`) — when set, the
   *  resolver tries it first because it survives reflow inside the parent
   *  block. */
  subBlockId?: string;
  /** Resolved/accepted comments fade their highlight to a muted state but
   *  stay visible (audit trail). */
  muted: boolean;
}

/** Resolve a stored selection to character offsets inside `blockText`, trying
 *  three tiers in order:
 *
 *  1. **Sub-block id** (`blk-X.s3.w2-w4`) — stable across any revise that
 *     leaves the parent block's body byte-identical. When present and
 *     resolvable against the current text, this is the highest-fidelity
 *     anchor we have.
 *  2. **Stored char range** — fast path when the byte slice still equals
 *     `quotedText` (no edits inside the block since capture).
 *  3. **`quotedText` self-heal** — `indexOf` lookup; rescues the highlight
 *     when offsets drifted but the quoted substring still appears somewhere
 *     in the block.
 *
 *  `blockTagName` is the DOM tag (or ProseMirror-mapped equivalent) used to
 *  pick the addressing axis — `PRE`/`UL`/`OL`/`LI`/`BLOCKQUOTE` → line axis,
 *  everything else → sentence axis. */
export function resolveRange(
  blockText: string,
  blockTagName: string,
  range: Pick<
    CommentHighlightRange,
    "charStart" | "charEnd" | "quotedText" | "subBlockId"
  >,
): { from: number; to: number } | null {
  if (range.subBlockId) {
    const resolved = resolveSubBlockId({
      blockText,
      kind: blockKindForTag(blockTagName),
      subBlockId: range.subBlockId,
    });
    // Only trust the sub-block tier when its slice actually matches the
    // captured `quotedText`. The id is minted against the whole-block DOM
    // textContent at selection time but resolved here against the live block
    // text — for lists/blockquotes those texts can differ, so a stale id can
    // resolve to a wrong (but non-null) range. Validating before returning
    // lets a mismatch fall through to the proven char-range / quotedText tiers
    // instead of painting (or losing) the highlight at the wrong spot.
    if (
      resolved &&
      resolved.end > resolved.start &&
      (range.quotedText.length === 0 ||
        blockText.slice(resolved.start, resolved.end) === range.quotedText)
    ) {
      return { from: resolved.start, to: resolved.end };
    }
  }
  const { charStart, charEnd, quotedText } = range;
  if (
    charStart >= 0 &&
    charEnd <= blockText.length &&
    blockText.slice(charStart, charEnd) === quotedText
  ) {
    return { from: charStart, to: charEnd };
  }
  if (quotedText.length === 0) return null;
  const idx = blockText.indexOf(quotedText);
  if (idx === -1) return null;
  return { from: idx, to: idx + quotedText.length };
}
