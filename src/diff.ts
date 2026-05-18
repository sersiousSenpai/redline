import type { Paragraph, Section } from "./types";

export type ParagraphDiffStatus =
  | "unchanged"
  | "added"
  | "modified"
  | "moved";

export interface ParagraphDiffInfo {
  status: ParagraphDiffStatus;
  originalText?: string;
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
        out.set(p.anchorId, { status: "modified", originalText: byBlock.text });
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
      out.set(p.anchorId, { status: "modified", originalText: prev });
    }
  });
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
