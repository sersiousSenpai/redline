// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Editor } from "@tiptap/react";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";

import type { Comment } from "../types";
import { isProseEditComment } from "./changeLedger";
import { diffWords } from "./wordDiff";
import { planMarkdownToDoc, serializeBlockToMarkdown } from "./markdown";
import {
  hasPendingSuggestions,
  isPendingSuggestionMark,
  USER_AUTHOR,
} from "./extensions/TrackChanges";

/**
 * M3 — suggestions live as marks in the (persisted) Y.Doc; the comment
 * sidebar is a projection over them. This module is the only place the
 * sidebar is allowed to write suggestions *into* the document, and it does
 * so exactly twice:
 *
 *  - {@link materializeSuggestions}: a one-shot IMPORT for blocks that don't
 *    carry the suggestion yet — reopened proposals landing on a fresh
 *    revision, and draft comments on a doc whose local Y.Doc copy was lost
 *    (IndexedDB cleared / new machine). A block that already carries pending
 *    marks, or that the user has diverged from the seed, is never rewritten:
 *    the document wins.
 *
 *  - {@link rejectBlockSuggestions}: the editor-side meaning of an explicit
 *    sidebar intent (draft comment deleted, or submitted away) — pending
 *    insertions are removed, pending deletions unstruck, i.e. the proposal
 *    is rejected and the block reads as the published revision again.
 *
 * Everything else flows the other way: marks → accept-all serialization →
 * changeLedger ops → comments. The wire payload {original, revised} is
 * always seed-vs-accept-all, byte-identical to the pre-M3 contract.
 */

/** Locate a top-level block node by blockId. */
function findBlock(
  editor: Editor,
  blockId: string,
): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  editor.state.doc.forEach((node, pos) => {
    if (!found && node.attrs?.blockId === blockId) found = { node, pos };
  });
  return found;
}

/** Block contains the focused caret — never rewrite under the user. */
function caretInside(editor: Editor, from: number, to: number): boolean {
  const sel = editor.state.selection;
  return editor.isFocused && sel.from >= from && sel.from <= to;
}

/**
 * Import sidebar proposals into blocks that don't carry them yet. Idempotent:
 * once materialized, the block carries pending marks and is skipped forever
 * after. `seed` is the revision's published per-block markdown.
 *
 * @returns the blockIds actually written (for tests/logging).
 */
export function materializeSuggestions(
  editor: Editor,
  comments: Comment[],
  seed: Map<string, string>,
): string[] {
  // Never rewrite the document mid-IME-composition (CJK/dead keys).
  if (editor.view.composing) return [];

  const schema = editor.schema;
  const insMark = schema.marks.rl_ins;
  const delMark = schema.marks.rl_del;

  const targets: { from: number; to: number; id: string; revised: string }[] =
    [];
  for (const c of comments) {
    if (!isProseEditComment(c) || !c.blockId || !c.edit) continue;
    const at = findBlock(editor, c.blockId);
    if (!at) continue;
    const base = seed.get(c.blockId);
    if (base === undefined) continue;
    // Doc is truth: only a pristine block (no open suggestions, accept-all
    // equal to the published seed) may receive an import.
    if (hasPendingSuggestions(at.node)) continue;
    if (serializeBlockToMarkdown(at.node) !== base) continue;
    if (c.edit.revised === base) continue; // nothing to propose
    const from = at.pos;
    const to = at.pos + at.node.nodeSize;
    if (caretInside(editor, from, to)) continue;
    targets.push({ from, to, id: c.blockId, revised: c.edit.revised });
  }
  if (targets.length === 0) return [];

  const tr = editor.state.tr;
  // High → low so earlier offsets stay valid as we splice.
  for (const t of targets.sort((a, b) => b.from - a.from)) {
    const parsed = planMarkdownToDoc(t.revised, schema);
    if (parsed.childCount === 0) continue;
    const first = parsed.child(0);
    const original = seed.get(t.id)!;
    const attrs = (markName: "rl_ins" | "rl_del") => ({
      blockId: t.id,
      authorId: USER_AUTHOR,
      // Deterministic per block+kind, so re-materializing after an undo
      // converges on the same identity.
      suggestionId: `cmt:${t.id}:${markName}`,
      status: "pending",
    });

    // Prose paragraph → Word-style inline tracked changes (struck deletions
    // kept in place, proposed insertions marked). Structured blocks
    // (headings/lists/code/tables) fall back to whole-block replacement.
    const blockNode = editor.state.doc.nodeAt(t.from);
    if (
      parsed.childCount === 1 &&
      first.type.name === "paragraph" &&
      blockNode?.type.name === "paragraph"
    ) {
      const runs = diffWords(original, t.revised)
        .filter((p) => p.text.length > 0)
        .map((p) =>
          p.kind === "equal"
            ? schema.text(p.text)
            : schema.text(p.text, [
                (p.kind === "insert" ? insMark : delMark).create(
                  attrs(p.kind === "insert" ? "rl_ins" : "rl_del"),
                ),
              ]),
        );
      const para = schema.nodes.paragraph.create(
        { ...blockNode.attrs, blockId: t.id },
        runs,
      );
      tr.replaceWith(t.from, t.to, para);
      continue;
    }

    const rebased = first.type.create(
      { ...first.attrs, blockId: t.id },
      first.content,
      first.marks,
    );
    const rest = [];
    for (let i = 1; i < parsed.childCount; i++) rest.push(parsed.child(i));
    tr.replaceWith(t.from, t.to, Fragment.fromArray([rebased, ...rest]));
  }
  if (tr.steps.length === 0) return [];
  tr.setMeta("rl-sync", true);
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
  return targets.map((t) => t.id);
}

/**
 * Reject a block's open suggestions in place: pending insertions are deleted,
 * pending deletions unstruck — the block reads as the published revision
 * again. For an edit that left no marks (e.g. a formatting toggle), falls
 * back to restoring the block body from `seedMarkdown`.
 *
 * @returns true if the document changed.
 */
export function rejectBlockSuggestions(
  editor: Editor,
  blockId: string,
  seedMarkdown?: string,
): boolean {
  if (editor.view.composing) return false;
  const at = findBlock(editor, blockId);
  if (!at) return false;
  const schema = editor.schema;

  if (hasPendingSuggestions(at.node)) {
    // Collect absolute leaf ranges first; apply high → low so positions hold.
    const leaves: { from: number; to: number; kind: "ins" | "del" }[] = [];
    at.node.descendants((n, rel) => {
      if (!n.isText) return true;
      const pending = n.marks.filter(isPendingSuggestionMark);
      if (pending.length === 0) return true;
      const from = at.pos + 1 + rel;
      const to = from + n.nodeSize;
      // Text that is itself a pending insertion goes away entirely (and any
      // del mark riding on it goes with it); otherwise unstrike.
      const kind = pending.some((m) => m.type.name === "rl_ins")
        ? "ins"
        : "del";
      leaves.push({ from, to, kind });
      return true;
    });
    if (leaves.length === 0) return false;
    const tr = editor.state.tr;
    for (const leaf of leaves.sort((a, b) => b.from - a.from)) {
      if (leaf.kind === "ins") tr.delete(leaf.from, leaf.to);
      else tr.removeMark(leaf.from, leaf.to, schema.marks.rl_del);
    }
    tr.setMeta("rl-sync", true);
    tr.setMeta("addToHistory", false);
    editor.view.dispatch(tr);
    return true;
  }

  // Mark-less edit (formatting toggle, structured-block override): restore
  // the published seed body wholesale.
  if (seedMarkdown === undefined) return false;
  if (serializeBlockToMarkdown(at.node) === seedMarkdown) return false;
  const parsed = planMarkdownToDoc(seedMarkdown, schema);
  if (parsed.childCount === 0) return false;
  const first = parsed.child(0);
  const rebased = first.type.create(
    { ...first.attrs, blockId },
    first.content,
    first.marks,
  );
  const rest = [];
  for (let i = 1; i < parsed.childCount; i++) rest.push(parsed.child(i));
  const tr = editor.state.tr;
  tr.replaceWith(
    at.pos,
    at.pos + at.node.nodeSize,
    Fragment.fromArray([rebased, ...rest]),
  );
  tr.setMeta("rl-sync", true);
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
  return true;
}
