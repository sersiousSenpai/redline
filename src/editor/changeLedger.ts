import type { Comment, NewCommentRequest, UpdateCommentRequest } from "../types";

/**
 * Normalized, engine-agnostic view of how the editor document differs from
 * its immutable base (each block's baseline plain text, captured when the
 * editable block first mounts).
 *
 * Prose edits populate `edited`; the structural kinds are part of the
 * wire/sync contract and may be emitted when blocks are added/removed.
 */
export type BlockChangeKind =
  | "unchanged"
  | "edited"
  | "block-inserted"
  | "block-deleted"
  | "block-moved";

export interface BlockChange {
  blockId: string;
  anchorId: string;
  kind: BlockChangeKind;
  /** Verbatim base markdown (immutable). */
  original: string;
  /** Current editor markdown for the block. */
  revised: string;
}

export type DocumentChangeSet = BlockChange[];

export interface BaseBlock {
  blockId: string;
  anchorId: string;
  markdown: string;
}

/** Length of the longest common subsequence of two id arrays — the set of
 *  blocks that did NOT move relative to each other. */
function stableIds(baseIds: string[], curIds: string[]): Set<string> {
  const n = baseIds.length;
  const m = curIds.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        baseIds[i] === curIds[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keep = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (baseIds[i] === curIds[j]) {
      keep.add(baseIds[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return keep;
}

/**
 * Derive the change set from the immutable base and the editor's current
 * per-block markdown. Order follows the current document so a structural
 * move (D5: an explicit drag gesture that reorders the doc) surfaces as
 * `block-moved`; deletions are appended in base order.
 */
export function buildChangeSet(
  base: BaseBlock[],
  current: { blockId: string; anchorId: string; markdown: string }[],
): DocumentChangeSet {
  const baseById = new Map(base.map((b) => [b.blockId, b]));
  const seen = new Set<string>();

  // Relative-order stability is computed over blocks common to both sides.
  const commonBaseIds = base
    .filter((b) => current.some((c) => c.blockId === b.blockId))
    .map((b) => b.blockId);
  const commonCurIds = current
    .filter((c) => baseById.has(c.blockId))
    .map((c) => c.blockId);
  const stable = stableIds(commonBaseIds, commonCurIds);

  const out: DocumentChangeSet = [];
  for (const cur of current) {
    seen.add(cur.blockId);
    const b = baseById.get(cur.blockId);
    if (!b) {
      out.push({
        blockId: cur.blockId,
        anchorId: cur.anchorId,
        kind: "block-inserted",
        original: "",
        revised: cur.markdown,
      });
      continue;
    }
    if (b.markdown !== cur.markdown) {
      out.push({
        blockId: cur.blockId,
        anchorId: cur.anchorId,
        kind: "edited",
        original: b.markdown,
        revised: cur.markdown,
      });
    } else if (!stable.has(cur.blockId)) {
      out.push({
        blockId: cur.blockId,
        anchorId: cur.anchorId,
        kind: "block-moved",
        original: b.markdown,
        revised: cur.markdown,
      });
    } else {
      out.push({
        blockId: cur.blockId,
        anchorId: cur.anchorId,
        kind: "unchanged",
        original: b.markdown,
        revised: cur.markdown,
      });
    }
  }
  for (const b of base) {
    if (!seen.has(b.blockId)) {
      out.push({
        blockId: b.blockId,
        anchorId: b.anchorId,
        kind: "block-deleted",
        original: b.markdown,
        revised: "",
      });
    }
  }
  return out;
}

const EDITOR_TYPES: ReadonlySet<string> = new Set([
  "edit",
  "block-insert",
  "block-delete",
  "block-move",
]);

/** A comment is owned by the in-document editor iff it is a draft/reopened
 *  edit/structural comment carrying a blockId. Sidebar-only edits, feedback,
 *  questions, and submitted/resolved comments are never touched by sync. */
export function isEditorComment(c: Comment): boolean {
  return (
    EDITOR_TYPES.has(c.type) &&
    !!c.blockId &&
    (c.status === "draft" || c.status === "reopened")
  );
}

/** Editor comments that are prose edits (vs. structural). */
export function isProseEditComment(c: Comment): boolean {
  return isEditorComment(c) && c.type === "edit";
}

type StructuralKind = "block-inserted" | "block-deleted" | "block-moved";

const KIND_TO_TYPE: Record<StructuralKind, Comment["type"]> = {
  "block-inserted": "block-insert",
  "block-deleted": "block-delete",
  "block-moved": "block-move",
};

export type SyncOp =
  | { op: "add"; request: NewCommentRequest }
  | { op: "update"; id: string; update: UpdateCommentRequest }
  | { op: "delete"; id: string };

/**
 * Diff the change set against the current draft comments (keyed by blockId)
 * and emit the minimal add/update/delete operations to make the persisted
 * comment set mirror the document.
 *
 * Invariant: applying these ops and recomputing yields **no** ops — this is
 * the idempotency the reconcile Vitest asserts (and what makes the
 * editor↔sidebar echo loop terminate).
 */
export function diffToCommentOps(
  changes: DocumentChangeSet,
  comments: Comment[],
  baseAnchorById?: Map<string, string>,
): SyncOp[] {
  const editorComments = comments.filter(isEditorComment);
  const byBlock = new Map<string, Comment>();
  for (const c of editorComments) {
    if (c.blockId && !byBlock.has(c.blockId)) byBlock.set(c.blockId, c);
  }

  const ops: SyncOp[] = [];
  const liveBlocks = new Set<string>();

  for (const ch of changes) {
    if (ch.kind === "unchanged") continue;
    liveBlocks.add(ch.blockId);
    const existing = byBlock.get(ch.blockId);

    if (ch.kind === "edited") {
      if (!existing) {
        ops.push({
          op: "add",
          request: {
            type: "edit",
            anchorId: ch.anchorId,
            blockId: ch.blockId,
            body: "(edit)",
            edit: { original: ch.original, revised: ch.revised },
          },
        });
      } else if (
        existing.edit?.original !== ch.original ||
        existing.edit?.revised !== ch.revised
      ) {
        ops.push({
          op: "update",
          id: existing.id,
          update: { edit: { original: ch.original, revised: ch.revised } },
        });
      }
      continue;
    }

    // Structural: block-inserted / block-deleted / block-moved.
    const type = KIND_TO_TYPE[ch.kind as StructuralKind];
    const fromAnchor = baseAnchorById?.get(ch.blockId);
    const structural = {
      op:
        ch.kind === "block-inserted"
          ? "insert"
          : ch.kind === "block-deleted"
            ? "delete"
            : "move",
      blockId: ch.blockId,
      ...(ch.kind === "block-deleted" || ch.kind === "block-moved"
        ? { fromAnchor: fromAnchor ?? ch.anchorId }
        : {}),
      ...(ch.kind === "block-inserted" || ch.kind === "block-moved"
        ? { toAnchor: ch.anchorId }
        : {}),
      ...(ch.kind === "block-deleted"
        ? { markdown: ch.original }
        : ch.kind === "block-inserted"
          ? { markdown: ch.revised }
          : {}),
    };
    if (!existing) {
      ops.push({
        op: "add",
        request: {
          type,
          anchorId: ch.anchorId,
          blockId: ch.blockId,
          body: "(structural)",
          structural,
        },
      });
    } else if (
      existing.type !== type ||
      JSON.stringify(existing.structural ?? null) !== JSON.stringify(structural)
    ) {
      ops.push({ op: "update", id: existing.id, update: { structural } });
    }
  }

  // A block that is back to unchanged (reverted / un-moved) drops its
  // editor-owned comment.
  for (const c of editorComments) {
    if (c.blockId && !liveBlocks.has(c.blockId)) {
      ops.push({ op: "delete", id: c.id });
    }
  }
  return ops;
}

/**
 * Reverse projection: the per-block markdown the document should show given
 * the persisted comments. Used by `applyCommentsToDoc` to reconcile the
 * editor when a comment changes from the sidebar. Idempotent — a block whose
 * current markdown already equals the target is omitted by the caller.
 */
export function commentsToBlockOverrides(
  comments: Comment[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of comments) {
    if (isProseEditComment(c) && c.blockId && c.edit) {
      out.set(c.blockId, c.edit.revised);
    }
  }
  return out;
}
