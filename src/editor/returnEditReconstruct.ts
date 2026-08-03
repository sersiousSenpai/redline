// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";

import type {
  CommentSelection,
  EditPayload,
  NewCommentRequest,
} from "../types";
import { planMarkdownToDoc, serializeBlockToMarkdown } from "./markdown";
import { resolveRange } from "./resolveHighlightRange";

/**
 * Whole-block reconstruction of selection-scoped edits.
 *
 * The share viewer captures a proposed edit as a *selection-scoped* pair —
 * `edit.original` is the few words the reviewer selected (`quotedText`) and
 * `edit.revised` is what they typed over them, with offsets measured against
 * the block's rendered plaintext. The comment pipeline's contract, however,
 * is whole-block markdown, seed-vs-accept-all (see the module doc in
 * `suggestions.ts`): every downstream consumer — the fine-grained
 * `diffWords` materialization, the card preview, the Submit ORIGINAL/REVISED
 * payload — assumes it.
 *
 * This module bridges the two shapes at import time: locate the reviewer's
 * selected words inside the block (the same three-tier lookup that places
 * the selection highlights), splice their replacement in, and re-serialize —
 * yielding a normal whole-block `{original, revised}`. A snippet that cannot
 * be located returns `null`; the caller keeps the raw payload and the edit
 * stays card-only (never a false whole-paragraph strike).
 */

/** Mirror of `pmNodeTagName` in CommentHighlights — maps a top-level PM node
 *  to the DOM tag `blockKindForTag` keys on, so the locator picks the same
 *  addressing axis the editor highlight does. */
function blockTagName(node: PMNode): string {
  switch (node.type.name) {
    case "codeBlock":
      return "PRE";
    case "bulletList":
      return "UL";
    case "orderedList":
      return "OL";
    case "listItem":
      return "LI";
    case "blockquote":
      return "BLOCKQUOTE";
    case "table":
      return "TABLE";
    case "heading": {
      const level = (node.attrs?.level as number | undefined) ?? 1;
      return `H${level}`;
    }
    default:
      return "P";
  }
}

/** Locate the selection inside `blockText` via the shared three-tier
 *  resolver, hardened for repeated snippets: when the stored char range no
 *  longer matches (tier-3 `indexOf` self-heal returns the FIRST occurrence),
 *  prefer the occurrence nearest the originally captured `charStart`. */
function locateSnippet(
  blockText: string,
  tagName: string,
  selection: CommentSelection,
): { from: number; to: number } | null {
  const r = resolveRange(blockText, tagName, selection);
  if (!r) return null;
  const { charStart, quotedText } = selection;
  // Exact stored range (or validated sub-block range) — trust it.
  if (r.from === charStart || selection.subBlockId) return r;
  // Tier-3 self-heal picked the first occurrence; if the snippet repeats,
  // choose the occurrence nearest where the reviewer actually selected.
  let best = r.from;
  for (
    let idx = blockText.indexOf(quotedText);
    idx !== -1;
    idx = blockText.indexOf(quotedText, idx + 1)
  ) {
    if (Math.abs(idx - charStart) < Math.abs(best - charStart)) best = idx;
  }
  return { from: best, to: best + quotedText.length };
}

/** Map a plaintext offset (in `textContent` units — text nodes only, leaf
 *  nodes like hardBreak contribute nothing) to a ProseMirror position in
 *  `doc`. Plain base+offset arithmetic is not enough precisely because
 *  zero-width leaves still occupy positions. */
function plainOffsetToPos(doc: PMNode, offset: number): number | null {
  let acc = 0;
  let result: number | null = null;
  doc.descendants((node, pos) => {
    if (result !== null) return false;
    if (node.isText) {
      const len = node.text?.length ?? 0;
      if (offset <= acc + len) {
        result = pos + (offset - acc);
        return false;
      }
      acc += len;
    }
    return true;
  });
  return result;
}

/**
 * Rebuild a whole-block `{original, revised}` from a selection-scoped edit.
 *
 * `blockMarkdown` must be the block's published seed markdown (round-trip
 * space — the same bytes PlanEditor's `seedMap` holds). Returns `null` when
 * the reconstruction cannot be trusted: snippet not locatable, offsets not
 * mappable, the splice escaping the single-block shape, or a no-op result.
 */
export function reconstructWholeBlockEdit(
  blockMarkdown: string,
  selection: CommentSelection,
  edit: EditPayload,
): EditPayload | null {
  const doc = planMarkdownToDoc(blockMarkdown);
  if (doc.childCount !== 1) return null;
  const block = doc.child(0);
  // Same domain as the viewer's capture (`textBetween` without leaf text).
  const blockText = block.textContent;

  const range = locateSnippet(blockText, blockTagName(block), selection);
  if (!range) return null;

  const pmFrom = plainOffsetToPos(doc, range.from);
  const pmTo = plainOffsetToPos(doc, range.to);
  if (pmFrom === null || pmTo === null || pmTo < pmFrom) return null;
  if (doc.textBetween(pmFrom, pmTo) !== selection.quotedText) return null;

  const schema = doc.type.schema;
  const tr = new Transform(doc);
  if (edit.revised.length > 0) {
    // Word-like: the replacement inherits the marks of the first replaced
    // character, so editing inside bold stays bold. (`marks()` alone looks
    // left of the boundary and would drop the formatting when the selection
    // starts exactly at the marked span.)
    const $from = doc.resolve(pmFrom);
    const marks = $from.nodeAfter?.marks ?? $from.marks();
    tr.replaceWith(pmFrom, pmTo, schema.text(edit.revised, marks));
  } else {
    tr.delete(pmFrom, pmTo);
  }
  if (tr.doc.childCount !== 1) return null;

  const original = serializeBlockToMarkdown(block);
  const revised = serializeBlockToMarkdown(tr.doc.child(0));
  if (revised === original) return null;

  // Round-trip gate: the revised markdown must be a fixed point (reviewer
  // text can contain markdown-significant characters — a replacement that
  // re-parses into a different shape must not be persisted as whole-block).
  const reparsed = planMarkdownToDoc(revised);
  if (reparsed.childCount !== 1) return null;
  if (serializeBlockToMarkdown(reparsed.child(0)) !== revised) return null;

  return { original, revised };
}

/**
 * Normalize re-anchored viewer returns to the whole-block edit contract
 * before they are persisted. Only touches requests matching the viewer
 * invariant (`edit.original === selection.quotedText`, and not already
 * whole-block); everything else passes through untouched. On reconstruction
 * failure the raw request is kept — the edit stays card-only (see
 * `materializeSuggestions`), which is lossless.
 */
export function reconstructReturnEdits(
  placed: NewCommentRequest[],
  seed: ReadonlyMap<string, string>,
): NewCommentRequest[] {
  return placed.map((req) => {
    if (req.type !== "edit" || !req.edit || !req.selection || !req.blockId) {
      return req;
    }
    const base = seed.get(req.blockId);
    if (base === undefined) return req;
    if (req.edit.original === base) return req; // already whole-block
    if (req.edit.original !== req.selection.quotedText) return req;
    const rebuilt = reconstructWholeBlockEdit(base, req.selection, req.edit);
    return rebuilt ? { ...req, edit: rebuilt } : req;
  });
}
