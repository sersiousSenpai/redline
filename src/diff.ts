import type { Paragraph, Section } from "./types";

export type ParagraphDiffStatus = "unchanged" | "added" | "modified";

export interface ParagraphDiffInfo {
  status: ParagraphDiffStatus;
  originalText?: string;
}

export type ParagraphDiff = Map<string, ParagraphDiffInfo>;

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
  forEachParagraph(previousSections, (p) => {
    prevByAnchor.set(p.anchorId, p.text);
  });
  forEachParagraph(currentSections, (p) => {
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
