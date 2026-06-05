// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { segmentSentences } from "./editor/sentenceSegment";
import type { Paragraph, Section } from "./types";

export type ParagraphDiffStatus =
  | "unchanged"
  | "added"
  | "modified"
  | "moved";

/** Sub-block-level breakdown of a `modified` paragraph: which sentences
 *  actually changed and which were carried through unchanged. Only
 *  populated when v1's sentence count equals v2's — the conservative case
 *  where pair-by-index alignment is unambiguous. Empty / absent for any
 *  other status, code blocks, lists, and reflowed paragraphs (count
 *  mismatch). `RedlineDecorations` reads this to paint the gutter bar
 *  against just the modified sentences instead of the whole paragraph. */
export interface SubBlockDiffEntry {
  /** Canonical sub-block sidecar id (`blk-X.s2`). */
  subBlockId: string;
  status: "unchanged" | "modified";
  /** Present for `modified` entries — the v1 sentence text. */
  originalText?: string;
}

export interface ParagraphDiffInfo {
  status: ParagraphDiffStatus;
  originalText?: string;
  subBlocks?: SubBlockDiffEntry[];
}

export type ParagraphDiff = Map<string, ParagraphDiffInfo>;

/**
 * Per-paragraph diff between revisions, keyed by `anchorId` (what the UI
 * looks up). Matching prefers the stable `blockId` when present (Milestone A
 * sidecars) so a block that only *moved* is recognized as `moved` rather than
 * a spurious add+delete — intra-session integrity per SPEC §5.3. Falls back
 * to positional `anchorId` for legacy/sidecar-less revisions.
 */
export function computeParagraphDiff(
  currentSections: Section[],
  previousSections: Section[] | undefined,
): ParagraphDiff {
  const out: ParagraphDiff = new Map();
  if (!previousSections) {
    forEachParagraph(currentSections, (p) => {
      out.set(p.anchorId, { status: "unchanged" });
    });
    return out;
  }
  const prevByAnchor = new Map<string, string>();
  const prevByBlock = new Map<string, { text: string; anchorId: string }>();
  forEachParagraph(previousSections, (p) => {
    prevByAnchor.set(p.anchorId, p.text);
    if (p.blockId) prevByBlock.set(p.blockId, { text: p.text, anchorId: p.anchorId });
  });
  forEachParagraph(currentSections, (p) => {
    const byBlock = p.blockId ? prevByBlock.get(p.blockId) : undefined;
    if (byBlock) {
      if (byBlock.text !== p.text) {
        out.set(p.anchorId, {
          status: "modified",
          originalText: byBlock.text,
          subBlocks: decomposeSentenceLevel(p, byBlock.text),
        });
      } else if (byBlock.anchorId !== p.anchorId) {
        out.set(p.anchorId, { status: "moved" });
      } else {
        out.set(p.anchorId, { status: "unchanged" });
      }
      return;
    }
    const prev = prevByAnchor.get(p.anchorId);
    if (prev === undefined) {
      out.set(p.anchorId, { status: "added" });
    } else if (prev === p.text) {
      out.set(p.anchorId, { status: "unchanged" });
    } else {
      out.set(p.anchorId, {
        status: "modified",
        originalText: prev,
        subBlocks: decomposeSentenceLevel(p, prev),
      });
    }
  });
  return out;
}

/** Decompose a modified prose paragraph into per-sentence diff entries when
 *  v1 and v2 have the same number of sentences. Pair-align by index; flag
 *  each pair as `unchanged` or `modified` based on byte equality.
 *
 *  Returns `undefined` when:
 *  - No `blockId` (sub-block sidecar grammar needs a parent id)
 *  - The paragraph looks like a code block (decomposition is line-axis there
 *    and inline ins/del marks already pinpoint the change)
 *  - Sentence counts differ between v1 and v2 (reflow — too ambiguous for
 *    safe per-sentence alignment; falls through to paragraph-level paint) */
function decomposeSentenceLevel(
  current: Paragraph,
  previousText: string,
): SubBlockDiffEntry[] | undefined {
  if (!current.blockId) return undefined;
  // Skip code blocks — handled by the inline-mark precision path.
  if (current.markdown.trimStart().startsWith("```")) return undefined;
  const v1 = segmentSentences(previousText);
  const v2 = segmentSentences(current.text);
  if (v1.length === 0 || v2.length === 0) return undefined;
  if (v1.length !== v2.length) return undefined;
  const out: SubBlockDiffEntry[] = [];
  for (let i = 0; i < v2.length; i++) {
    const same = v1[i].text === v2[i].text;
    out.push({
      subBlockId: `${current.blockId}.s${i + 1}`,
      status: same ? "unchanged" : "modified",
      originalText: same ? undefined : v1[i].text,
    });
  }
  return out;
}

function forEachParagraph(
  sections: Section[],
  cb: (p: Paragraph) => void,
): void {
  for (const s of sections) {
    for (const p of s.paragraphs) cb(p);
    forEachParagraph(s.children, cb);
  }
}
