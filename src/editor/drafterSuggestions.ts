// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Editor } from "@tiptap/react";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import type { Step } from "@tiptap/pm/transform";
import type { Transaction } from "@tiptap/pm/state";

import { diffWords } from "./wordDiff";
import { planMarkdownToDoc, serializeBlockToMarkdown } from "./markdown";
import {
  isPendingSuggestionMark,
  USER_AUTHOR,
} from "./extensions/TrackChanges";

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
 *
 * Every transaction dispatched here carries `rl-sync` meta: these are derived
 * writes (suggestion materialization + verdicts), and with TrackChangesInput
 * registered in the drafter that meta is what keeps them from being repainted
 * as user insertions in Suggesting mode and from being rejected by the
 * pending-suggestion block lock.
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

/** True when the doc has no content worth preserving.
 *
 *  ONE emptiness predicate, shared with the launch gate — they disagreed, and
 *  the disagreement destroyed documents. `canSend` asks `editor.isEmpty` (a
 *  horizontal rule, a table, a heading with no words all count as content),
 *  while this asked `textContent.trim()` (all of those count as empty). So an
 *  agent `append` into a structure-only document took the wholesale
 *  `setContent` branch and REPLACED the document, reporting `"applied"` with no
 *  Accept/Reject card. Recoverable — that branch is the only one not marked
 *  `addToHistory: false`, so ⌘Z works — but still wrong. With `isEmpty` here
 *  the same append takes the `proposed` branch: a tracked insert with a card. */
export function docIsEmpty(editor: Editor): boolean {
  return editor.isEmpty;
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
      // Whole-cloth draft into an empty doc: applies directly. Chained so the
      // rl-sync meta rides the same transaction as the content swap.
      editor.chain().setMeta("rl-sync", true).setContent(parsed.toJSON()).run();
      return "applied";
    }
    const end = editor.state.doc.content.size;
    const tr = editor.state.tr;
    tr.insert(end, Fragment.fromArray(childArray(parsed)));
    markInserted(editor, tr, end, tr.doc.content.size, s);
    tr.setMeta("addToHistory", false);
    tr.setMeta("rl-sync", true);
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
    tr.setMeta("rl-sync", true);
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
      tr.setMeta("rl-sync", true);
      editor.view.dispatch(tr);
      return "proposed";
    }
    // Structured fallback: new blocks inserted after (marked), old block
    // struck where markable — accept deletes it either way.
    const tr = editor.state.tr;
    tr.insert(to, Fragment.fromArray(childArray(parsed)));
    markInserted(editor, tr, to, to + insertedSize(parsed), s);
    tr.setMeta("addToHistory", false);
    tr.setMeta("rl-sync", true);
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
  tr.setMeta("rl-sync", true);
  editor.view.dispatch(tr);
  return true;
}

/** Text leaves carrying a pending mark of `suggestionId`, absolute ranges.
 *  Exported for the drafter's re-drain guard: a persisted doc already carries
 *  the marks of an unresolved suggestion, so a mount must not re-apply it. */
export function suggestionLeaves(
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

/** Build (don't dispatch) the accept transaction for a suggestion, or null
 *  when there is nothing to accept. Shared by the plain accept and the
 *  undoable accept so the two can never drift. */
function buildAcceptTr(editor: Editor, s: DraftSuggestionRow): Transaction | null {
  const leaves = suggestionLeaves(editor, s.id);
  const schema = editor.schema;
  if (leaves.length === 0) {
    if (s.op === "delete_block" && s.blockId) {
      const at = findBlock(editor, s.blockId);
      if (!at) return null;
      const tr = editor.state.tr;
      tr.delete(at.pos, at.pos + at.node.nodeSize);
      tr.setMeta("rl-sync", true);
      return tr;
    }
    return null;
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
  tr.setMeta("rl-sync", true);
  return tr;
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
  const tr = buildAcceptTr(editor, s);
  if (!tr) return false;
  editor.view.dispatch(tr);
  return true;
}

/** What an accept must remember to be reversible: the exact inverse of its
 *  steps, valid against the document as it stood right after the accept.
 *  The token dies with the next foreign doc change — the CALLER owns that
 *  invalidation, because only it can tell its own dispatches apart. */
export interface SuggestionUndoToken {
  suggestionId: string;
  inverted: Step[];
}

/**
 * Accept, remembering how to undo (A3's "Undo next to Accept"): same
 * transaction as `acceptDraftSuggestion`, but each step's inverse is captured
 * before dispatch. `undoAcceptedSuggestion` replays those inverses to return
 * the suggestion to its exact PENDING presentation — marks, struck text and
 * all — after which the un-resolved row re-grows its card.
 */
export function acceptDraftSuggestionUndoable(
  editor: Editor,
  s: DraftSuggestionRow,
): SuggestionUndoToken | null {
  const tr = buildAcceptTr(editor, s);
  if (!tr) return null;
  const inverted = tr.steps.map((st, i) => st.invert(tr.docs[i]));
  editor.view.dispatch(tr);
  return { suggestionId: s.id, inverted };
}

/** Replay an accept's inverted steps (newest first). Only valid while the
 *  document still reads exactly as the accept left it; a stale token fails
 *  cleanly on the first step that no longer fits, changing nothing. */
export function undoAcceptedSuggestion(
  editor: Editor,
  token: SuggestionUndoToken,
): boolean {
  const tr = editor.state.tr;
  for (let i = token.inverted.length - 1; i >= 0; i--) {
    // maybeStep reports a content misfit as `.failed` but THROWS a RangeError
    // when the step's positions fall outside the current doc — both just mean
    // "stale", and neither may dispatch a half-applied undo.
    try {
      if (tr.maybeStep(token.inverted[i]).failed) return false;
    } catch {
      return false;
    }
  }
  tr.setMeta("rl-sync", true);
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
  return revertLeaves(editor, leaves);
}

/** Reject's shared mechanics: pending insertions removed, pending deletions
 *  unstruck — the document reads as before the proposal. */
function revertLeaves(
  editor: Editor,
  leaves: { from: number; to: number; kind: "ins" | "del" }[],
): boolean {
  const schema = editor.schema;
  const tr = editor.state.tr;
  for (const leaf of leaves.sort((a, b) => b.from - a.from)) {
    if (leaf.kind === "ins") tr.delete(leaf.from, leaf.to);
    else tr.removeMark(leaf.from, leaf.to, schema.marks.rl_del);
  }
  tr.setMeta("rl-sync", true);
  editor.view.dispatch(tr);
  return true;
}

/** Keep's shared mechanics: struck text really deleted, inserted text turned
 *  plain — a kept user edit is just ordinary typing (unlike agent accepts,
 *  which keep `accepted` provenance). */
function settleLeaves(
  editor: Editor,
  leaves: { from: number; to: number; kind: "ins" | "del" }[],
): boolean {
  const schema = editor.schema;
  const tr = editor.state.tr;
  for (const leaf of leaves.sort((a, b) => b.from - a.from)) {
    if (leaf.kind === "del") tr.delete(leaf.from, leaf.to);
    else tr.removeMark(leaf.from, leaf.to, schema.marks.rl_ins);
  }
  tr.setMeta("rl-sync", true);
  editor.view.dispatch(tr);
  return true;
}

/**
 * Settle the user's OWN pending tracked run (Suggesting-mode typing). No DB
 * row exists for user runs — this is pure document surgery.
 */
export function acceptUserSuggestion(
  editor: Editor,
  suggestionId: string,
): boolean {
  const leaves = suggestionLeaves(editor, suggestionId);
  if (leaves.length === 0) return false;
  return settleLeaves(editor, leaves);
}

/** Revert the user's OWN pending tracked run: insertions removed, strikes
 *  lifted — the document reads as before the edit. */
export function rejectUserSuggestion(
  editor: Editor,
  suggestionId: string,
): boolean {
  const leaves = suggestionLeaves(editor, suggestionId);
  if (leaves.length === 0) return false;
  return revertLeaves(editor, leaves);
}

/** Every text leaf carrying a pending USER-authored run, absolute ranges. */
function userPendingLeaves(
  editor: Editor,
): { from: number; to: number; kind: "ins" | "del" }[] {
  const leaves: { from: number; to: number; kind: "ins" | "del" }[] = [];
  editor.state.doc.descendants((n, pos) => {
    if (!n.isText) return true;
    const mine = n.marks.filter(
      (m) =>
        isPendingSuggestionMark(m) &&
        (m.attrs.authorId ?? USER_AUTHOR) === USER_AUTHOR,
    );
    if (mine.length === 0) return true;
    const kind = mine.some((m) => m.type.name === "rl_ins") ? "ins" : "del";
    leaves.push({ from: pos, to: pos + n.nodeSize, kind });
    return true;
  });
  return leaves;
}

/** The Review menu's "Keep all my changes": settle every pending user run. */
export function acceptAllUserSuggestions(editor: Editor): boolean {
  const leaves = userPendingLeaves(editor);
  if (leaves.length === 0) return false;
  return settleLeaves(editor, leaves);
}

/** The Review menu's "Revert all my changes". */
export function rejectAllUserSuggestions(editor: Editor): boolean {
  const leaves = userPendingLeaves(editor);
  if (leaves.length === 0) return false;
  return revertLeaves(editor, leaves);
}

/** Whether any pending user-authored run exists (gates the Review rows).
 *
 *  A short-circuiting walk, not `userPendingLeaves(...).length > 0`: this runs
 *  in a per-transaction selector, and collecting an array of EVERY pending leaf
 *  in the document only to ask whether there is at least one is pure waste —
 *  the answer is usually decided by the first marked text node. */
export function hasPendingUserSuggestions(editor: Editor): boolean {
  let found = false;
  editor.state.doc.descendants((n) => {
    if (found) return false; // stop descending; the answer is settled
    if (!n.isText) return true;
    if (
      n.marks.some(
        (m) =>
          isPendingSuggestionMark(m) &&
          (m.attrs.authorId ?? USER_AUTHOR) === USER_AUTHOR,
      )
    ) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}
