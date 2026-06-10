// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";

import type { ParagraphDiff, ParagraphDiffStatus } from "../diff";
import type { Section } from "../types";
import { diffWords } from "./wordDiff";
import { serializeBlockToMarkdown } from "./markdown";
import { hasPendingSuggestions } from "./extensions/TrackChanges";

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

/**
 * Stamp each top-level block's DOM with `data-anchor-id` (from the section
 * tree), so the existing `useTextSelection` hook + Edit/Feedback/Question
 * `SelectionMenu` work over the single-document editor. Idempotent.
 */
export function applyAnchorIds(
  editor: Editor,
  anchors: Map<string, string>,
): void {
  const { state } = editor;
  let tr = state.tr;
  let changed = false;
  state.doc.forEach((node, pos) => {
    const id = node.attrs?.blockId as string | undefined;
    if (!id) return;
    const want = anchors.get(id);
    if (!want || node.attrs.anchorId === want) return;
    tr = tr.setNodeAttribute(pos, "anchorId", want);
    changed = true;
  });
  if (!changed) return;
  tr.setMeta("rl-sync", true);
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}

export interface SerializedBlock {
  blockId: string;
  anchorId: string;
  markdown: string;
}

/**
 * The new `readCurrent`/baseline source: every top-level block serialized to
 * clean markdown. Feeds the existing `changeLedger` engine unchanged — the
 * round-trip fixed-point gate guarantees an untouched block serializes to its
 * baseline, so no phantom edits.
 */
export function serializeBlocks(
  editor: Editor,
  anchors: Map<string, string>,
): SerializedBlock[] {
  return serializeDocBlocks(editor.state.doc, anchors);
}

/** Doc-level form of {@link serializeBlocks} — works on any PM doc node, no
 *  live editor needed. Lets the per-revision baseline be captured headlessly
 *  from `planMarkdownToDoc(markdown)` even when the on-screen editor hydrates
 *  asynchronously from a persisted Y.Doc (which may already carry uncommitted
 *  edits and so must never be the baseline). */
export function serializeDocBlocks(
  doc: PMNode,
  anchors: Map<string, string>,
): SerializedBlock[] {
  const out: SerializedBlock[] = [];
  doc.forEach((node) => {
    const blockId = node.attrs?.blockId as string | undefined;
    if (!blockId) return;
    out.push({
      blockId,
      anchorId: anchors.get(blockId) ?? blockId,
      markdown: serializeBlockToMarkdown(node),
    });
  });
  return out;
}

/**
 * Fold the revision-level redline (vN vs vN-1) into the *same* inline ins/del
 * language as edit track-changes — replacing the old separate struck-through
 * block. Only paragraphs not owned by an edit comment are touched; structured
 * blocks and `moved` keep the block decoration. Idempotent via `node.eq`;
 * tagged `rl-sync` so the doc→sidebar sync ignores it.
 */
export function applyRevisionRedline(
  editor: Editor,
  revisions: Map<string, RevisionEdit>,
  overriddenIds: Set<string>,
): string[] {
  if (revisions.size === 0) return [];
  if (editor.view.composing) return [];
  const { state } = editor;
  const sel = state.selection;
  const schema = editor.schema;
  const insMark = schema.marks.rl_ins;

  const edits: { from: number; to: number; para: PMNode }[] = [];
  state.doc.forEach((node, pos) => {
    if (node.type.name !== "paragraph") return;
    const id = node.attrs?.blockId as string | undefined;
    if (!id || overriddenIds.has(id)) return;
    // M3: a block carrying open suggestions is owned by them — repainting it
    // from the diff would destroy the only record of the user's proposal.
    if (hasPendingSuggestions(node)) return;
    const rev = revisions.get(id);
    if (!rev || (rev.status !== "modified" && rev.status !== "added")) return;
    const from = pos;
    const to = pos + node.nodeSize;
    if (editor.isFocused && sel.from >= from && sel.from <= to) return;

    const original = rev.status === "added" ? "" : rev.originalText;
    const revised = serializeBlockToMarkdown(node);
    // Revision-level diffs (vN vs vN-1) drop `delete` runs entirely: the user
    // wants the new paragraph to read as a clean sentence, not as a strike-
    // through soup. The block-level gutter (`.rl-block-modified` /
    // `.rl-block-changed-bar`) still marks the section as edited, and inline
    // `rl_ins` highlights the added words. Edit track-changes (author-authored
    // proposed edits) keep the existing inline ins/del treatment via the
    // separate edit path — this only touches revision diffs.
    const runs = diffWords(original, revised)
      .filter((p) => p.kind !== "delete" && p.text.length > 0)
      .map((p) =>
        p.kind === "equal"
          ? schema.text(p.text)
          : schema.text(p.text, [
              // Presentation-only paint of Claude's vN-vs-vN-1 delta — never
              // a pending suggestion, so the sidebar projection ignores it.
              insMark.create({
                blockId: id,
                authorId: "claude",
                suggestionId: `rev:${id}`,
                status: "display",
              }),
            ]),
      );
    const para = schema.nodes.paragraph.create(
      { ...node.attrs, blockId: id },
      runs,
    );
    if (para.eq(node)) return; // already reconciled
    edits.push({ from, to, para });
  });

  if (edits.length === 0) return [];
  const tr = state.tr;
  for (const e of edits.sort((a, b) => b.from - a.from)) {
    tr.replaceWith(e.from, e.to, e.para);
  }
  tr.setMeta("rl-sync", true);
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
  return edits.map(() => "rev");
}
