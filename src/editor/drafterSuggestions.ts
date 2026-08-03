// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Editor } from "@tiptap/react";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";

import { diffWords } from "./wordDiff";
import { planMarkdownToDoc, serializeBlockToMarkdown } from "./markdown";

/**
 * Agent write-suggestions in the Prompt Drafter — the drafter-side twin of
 * `suggestions.ts` (the plan editor's comment-driven machinery), but driven by
 * `draft_suggestions` rows arriving over the `drafter-suggestion` event / the
 * pending-queue drain instead of by sidebar comments.
 *
 * Semantics (the daemon's write contract):
 *  - `append` into an EMPTY doc applies directly — whole-cloth drafting.
 *  - every other op renders as pending tracked changes (`rl_ins`/`rl_del`
 *    marks stamped with the suggestion id) the user accepts or rejects.
 *  - `replace_block` on a paragraph→paragraph rewrite paints an inline
 *    word-diff; structured targets (lists/code/tables) fall back to "insert
 *    the new blocks after + strike the old one", accept deletes the old.
 */

export interface DraftSuggestionRow {
  id: string;
  draftId: string;
  op: string;
  blockId: string | null;
  original: string | null;
  markdown: string;
  agentId: string | null;
  body: string | null;
  status: string;
  createdAt: number;
}

function findBlock(
  editor: Editor,
  blockId: string,
): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  const bare = blockId.replace(/^blk-/, "");
  editor.state.doc.forEach((node, pos) => {
    const id = (node.attrs?.blockId as string | null)?.replace(/^blk-/, "");
    if (!found && id && id === bare) found = { node, pos };
  });
  return found;
}

/** True when the doc has no content worth preserving (empty / one blank para). */
export function docIsEmpty(editor: Editor): boolean {
  return editor.state.doc.textContent.trim().length === 0;
}

/** Mark every text leaf in [from, to) with a pending rl_ins for `s`. */
function markInserted(
  editor: Editor,
  tr: ReturnType<Editor["state"]["tr"]["delete"]>,
  from: number,
  to: number,
  s: DraftSuggestionRow,
) {
  const ins = editor.schema.marks.rl_ins;
  tr.addMark(
    from,
    to,
    ins.create({
      authorId: s.agentId ?? "draft-agent",
      suggestionId: s.id,
      status: "pending",
    }),
  );
}

/**
 * Apply an incoming suggestion to the document. Returns how it landed:
 *  - `"applied"` — content is in as settled text (empty-doc append); the
 *    caller resolves the row `applied` immediately.
 *  - `"proposed"` — rendered as pending tracked changes awaiting a verdict.
 *  - `"card-only"` — nothing markable in the doc (e.g. deleting a code block);
 *    the card alone carries the proposal, accept does the mutation.
 *  - `"stale"` — the target block no longer exists; the caller rejects the row.
 */
export function applyDraftSuggestion(
  editor: Editor,
  s: DraftSuggestionRow,
): "applied" | "proposed" | "card-only" | "stale" {
  const schema = editor.schema;
  const parsed =
    s.op === "delete_block" ? null : planMarkdownToDoc(s.markdown, schema);

  if (s.op === "append") {
    if (!parsed || parsed.childCount === 0) return "stale";
    if (docIsEmpty(editor)) {
      // Whole-cloth draft into an empty doc: applies directly.
      editor.commands.setContent(parsed.toJSON());
      return "applied";
    }
    const end = editor.state.doc.content.size;
    const tr = editor.state.tr;
    tr.insert(end, Fragment.fromArray(childArray(parsed)));
    markInserted(editor, tr, end, tr.doc.content.size, s);
    tr.setMeta("addToHistory", false);
    editor.view.dispatch(tr);
    return "proposed";
  }

  const at = s.blockId ? findBlock(editor, s.blockId) : null;
  if (!at) return "stale";
  const from = at.pos;
  const to = at.pos + at.node.nodeSize;

  if (s.op === "insert_after") {
    if (!parsed || parsed.childCount === 0) return "stale";
    const tr = editor.state.tr;
    tr.insert(to, Fragment.fromArray(childArray(parsed)));
    markInserted(editor, tr, to, to + insertedSize(parsed), s);
    tr.setMeta("addToHistory", false);
    editor.view.dispatch(tr);
    return "proposed";
  }

  if (s.op === "delete_block") {
    return strikeBlock(editor, at, s) ? "proposed" : "card-only";
  }

  if (s.op === "replace_block") {
    if (!parsed || parsed.childCount === 0) return "stale";
    const first = parsed.child(0);
    // The nice case: paragraph → paragraph rewrite as an inline word-diff.
    if (
      parsed.childCount === 1 &&
      first.type.name === "paragraph" &&
      at.node.type.name === "paragraph"
    ) {
      const insMark = schema.marks.rl_ins;
      const delMark = schema.marks.rl_del;
      const original = s.original ?? serializeBlockToMarkdown(at.node);
      const runs = diffWords(original, s.markdown)
        .filter((p) => p.text.length > 0)
        .map((p) =>
          p.kind === "equal"
            ? schema.text(p.text)
            : schema.text(p.text, [
                (p.kind === "insert" ? insMark : delMark).create({
                  blockId: at.node.attrs.blockId,
                  authorId: s.agentId ?? "draft-agent",
                  suggestionId: s.id,
                  status: "pending",
                }),
              ]),
        );
      const para = schema.nodes.paragraph.create({ ...at.node.attrs }, runs);
      const tr = editor.state.tr;
      tr.replaceWith(from, to, para);
      tr.setMeta("addToHistory", false);
      editor.view.dispatch(tr);
      return "proposed";
    }
    // Structured fallback: new blocks inserted after (marked), old block
    // struck where markable — accept deletes it either way.
    const tr = editor.state.tr;
    tr.insert(to, Fragment.fromArray(childArray(parsed)));
    markInserted(editor, tr, to, to + insertedSize(parsed), s);
    tr.setMeta("addToHistory", false);
    editor.view.dispatch(tr);
    const reAt = s.blockId ? findBlock(editor, s.blockId) : null;
    if (reAt) strikeBlock(editor, reAt, s);
    return "proposed";
  }

  return "stale";
}

function childArray(parsed: PMNode): PMNode[] {
  const out: PMNode[] = [];
  parsed.forEach((n) => out.push(n));
  return out;
}

function insertedSize(parsed: PMNode): number {
  return childArray(parsed).reduce((n, c) => n + c.nodeSize, 0);
}

/** Strike a block's text with a pending rl_del for `s`. False when the block
 *  can't carry marks (code blocks) — the card alone carries the proposal. */
function strikeBlock(
  editor: Editor,
  at: { node: PMNode; pos: number },
  s: DraftSuggestionRow,
): boolean {
  if (at.node.type.name === "codeBlock" || at.node.type.name === "horizontalRule") {
    return false;
  }
  const del = editor.schema.marks.rl_del;
  const tr = editor.state.tr;
  tr.addMark(
    at.pos,
    at.pos + at.node.nodeSize,
    del.create({
      blockId: at.node.attrs.blockId,
      authorId: s.agentId ?? "draft-agent",
      suggestionId: s.id,
      status: "pending",
    }),
  );
  if (tr.steps.length === 0) return false;
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
  return true;
}

/** Text leaves carrying a mark of `suggestionId`, absolute ranges. */
function suggestionLeaves(
  editor: Editor,
  suggestionId: string,
): { from: number; to: number; kind: "ins" | "del" }[] {
  const leaves: { from: number; to: number; kind: "ins" | "del" }[] = [];
  editor.state.doc.descendants((n, pos) => {
    if (!n.isText) return true;
    const mine = n.marks.filter(
      (m) =>
        (m.type.name === "rl_ins" || m.type.name === "rl_del") &&
        m.attrs.suggestionId === suggestionId &&
        (m.attrs.status ?? "pending") === "pending",
    );
    if (mine.length === 0) return true;
    const kind = mine.some((m) => m.type.name === "rl_ins") ? "ins" : "del";
    leaves.push({ from: pos, to: pos + n.nodeSize, kind });
    return true;
  });
  return leaves;
}

/**
 * Accept a suggestion: pending deletions are really deleted, pending
 * insertions settle in place (status flips to `accepted`). For a card-only
 * delete (unmarkable block) the row's `blockId` is deleted outright.
 */
export function acceptDraftSuggestion(
  editor: Editor,
  s: DraftSuggestionRow,
): boolean {
  const leaves = suggestionLeaves(editor, s.id);
  const schema = editor.schema;
  if (leaves.length === 0) {
    if (s.op === "delete_block" && s.blockId) {
      const at = findBlock(editor, s.blockId);
      if (!at) return false;
      const tr = editor.state.tr;
      tr.delete(at.pos, at.pos + at.node.nodeSize);
      editor.view.dispatch(tr);
      return true;
    }
    return false;
  }
  const tr = editor.state.tr;
  for (const leaf of leaves.sort((a, b) => b.from - a.from)) {
    if (leaf.kind === "del") {
      tr.delete(leaf.from, leaf.to);
    } else {
      tr.removeMark(leaf.from, leaf.to, schema.marks.rl_ins);
      tr.addMark(
        leaf.from,
        leaf.to,
        schema.marks.rl_ins.create({
          authorId: s.agentId ?? "draft-agent",
          suggestionId: s.id,
          status: "accepted",
        }),
      );
    }
  }
  // A structured replace struck the whole old block; accepting must remove it
  // even if some of its leaves carried no mark (mark boundaries).
  editor.view.dispatch(tr);
  return true;
}

/**
 * Reject a suggestion: pending insertions are removed, pending deletions
 * unstruck — the document reads as before the proposal.
 */
export function rejectDraftSuggestion(
  editor: Editor,
  s: DraftSuggestionRow,
): boolean {
  const leaves = suggestionLeaves(editor, s.id);
  if (leaves.length === 0) return s.op === "delete_block";
  const schema = editor.schema;
  const tr = editor.state.tr;
  for (const leaf of leaves.sort((a, b) => b.from - a.from)) {
    if (leaf.kind === "ins") tr.delete(leaf.from, leaf.to);
    else tr.removeMark(leaf.from, leaf.to, schema.marks.rl_del);
  }
  editor.view.dispatch(tr);
  return true;
}
