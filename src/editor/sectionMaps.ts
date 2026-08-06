// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Pure section-tree projections — no editor, no ProseMirror, no serializer.
 * Split out of docModel.ts so App's one static need (blockIdByAnchorId for
 * comment-highlight resolution) doesn't drag the whole Tiptap universe onto
 * the main chunk (docs/perf-budget.md "Size budget"). docModel re-exports
 * everything here, so editor-side callers keep their import path.
 */
import type { ParagraphDiff, ParagraphDiffStatus } from "../diff";
import type { Section } from "../types";

/**
 * Project the per-anchor revision diff onto stable block ids, so the editor
 * (which keys everything by blockId) can paint revision redline. Covers
 * heading blocks and paragraph blocks alike.
 */
export function redlineStatusByBlockId(
  sections: Section[],
  diff: ParagraphDiff | undefined,
): Map<string, ParagraphDiffStatus> {
  const out = new Map<string, ParagraphDiffStatus>();
  if (!diff) return out;
  const walk = (secs: Section[]) => {
    for (const s of secs) {
      const sInfo = diff.get(s.anchorId);
      if (s.blockId && sInfo && sInfo.status !== "unchanged") {
        out.set(s.blockId, sInfo.status);
      }
      for (const p of s.paragraphs) {
        const info = diff.get(p.anchorId);
        if (p.blockId && info && info.status !== "unchanged") {
          out.set(p.blockId, info.status);
        }
      }
      walk(s.children);
    }
  };
  walk(sections);
  return out;
}

/** blockId → positional anchorId (for comment display/feedback ordering).
 *  PM nodes only carry the stable blockId; anchors live in the section tree. */
export function anchorByBlockId(sections: Section[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (secs: Section[]) => {
    for (const s of secs) {
      if (s.blockId) out.set(s.blockId, s.anchorId);
      for (const p of s.paragraphs) {
        if (p.blockId) out.set(p.blockId, p.anchorId);
      }
      walk(s.children);
    }
  };
  walk(sections);
  return out;
}

/** anchorId → stable blockId — the inverse of {@link anchorByBlockId}. A
 *  selection-originated comment only knows the positional `anchorId` of the
 *  block it landed in; this resolves the stable `blockId` join key the in-doc
 *  highlight decoration is keyed by, so the highlight actually paints. */
export function blockIdByAnchorId(sections: Section[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (secs: Section[]) => {
    for (const s of secs) {
      if (s.anchorId && s.blockId) out.set(s.anchorId, s.blockId);
      for (const p of s.paragraphs) {
        if (p.anchorId && p.blockId) out.set(p.anchorId, p.blockId);
      }
      walk(s.children);
    }
  };
  walk(sections);
  return out;
}

export interface RevisionEdit {
  status: ParagraphDiffStatus;
  originalText: string;
}

/** Richer projection than `redlineStatusByBlockId`: also carries the prior
 *  text so the revision delta can be rendered as inline ins/del marks. */
export function revisionEditByBlockId(
  sections: Section[],
  diff: ParagraphDiff | undefined,
): Map<string, RevisionEdit> {
  const out = new Map<string, RevisionEdit>();
  if (!diff) return out;
  const walk = (secs: Section[]) => {
    for (const s of secs) {
      for (const p of s.paragraphs) {
        const info = diff.get(p.anchorId);
        if (p.blockId && info && info.status !== "unchanged") {
          out.set(p.blockId, {
            status: info.status,
            originalText: info.originalText ?? "",
          });
        }
      }
      walk(s.children);
    }
  };
  walk(sections);
  return out;
}
