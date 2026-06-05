// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { Comment } from "../types";
import {
  buildChangeSet,
  commentsToBlockOverrides,
  diffToCommentOps,
  type BaseBlock,
  type SyncOp,
} from "./changeLedger";

const base: BaseBlock[] = [
  { blockId: "blk-1", anchorId: "A.p1", markdown: "Original one." },
  { blockId: "blk-2", anchorId: "A.p2", markdown: "Original two." },
];

function cur(over: Partial<Record<string, string>> = {}) {
  return base.map((b) => ({
    blockId: b.blockId,
    anchorId: b.anchorId,
    markdown: over[b.blockId] ?? b.markdown,
  }));
}

/** Minimal in-memory backend: applies sync ops to a comment list the way
 *  state.rs would, so we can assert the reconcile loop converges. */
function applyOps(comments: Comment[], ops: SyncOp[]): Comment[] {
  let next = [...comments];
  let n =
    next
      .map((c) => parseInt(c.id.replace("c-", ""), 10))
      .reduce((a, b) => Math.max(a, b), 0) + 1;
  for (const op of ops) {
    if (op.op === "add") {
      next.push({
        id: `c-${String(n++).padStart(3, "0")}`,
        type: op.request.type,
        anchorId: op.request.anchorId,
        blockId: op.request.blockId,
        body: op.request.body,
        edit: op.request.edit,
        structural: op.request.structural,
        createdAt: 0,
        status: "draft",
      });
    } else if (op.op === "update") {
      next = next.map((c) =>
        c.id === op.id
          ? {
              ...c,
              ...(op.update.edit ? { edit: op.update.edit } : {}),
              ...(op.update.structural
                ? { structural: op.update.structural }
                : {}),
            }
          : c,
      );
    } else {
      next = next.filter((c) => c.id !== op.id);
    }
  }
  return next;
}

describe("buildChangeSet", () => {
  it("classifies unchanged / edited / inserted / deleted", () => {
    const cs = buildChangeSet(base, [
      { blockId: "blk-1", anchorId: "A.p1", markdown: "Edited one." },
      { blockId: "blk-new", anchorId: "A.p3", markdown: "Brand new." },
    ]);
    const byId = new Map(cs.map((c) => [c.blockId, c]));
    expect(byId.get("blk-1")!.kind).toBe("edited");
    expect(byId.get("blk-new")!.kind).toBe("block-inserted");
    expect(byId.get("blk-2")!.kind).toBe("block-deleted");
  });
});

describe("diffToCommentOps reconcile loop", () => {
  it("adds an edit comment for an edited block, then is idempotent", () => {
    const changes = buildChangeSet(base, cur({ "blk-1": "Edited one." }));
    const ops1 = diffToCommentOps(changes, []);
    expect(ops1).toEqual([
      {
        op: "add",
        request: {
          type: "edit",
          anchorId: "A.p1",
          blockId: "blk-1",
          body: "(edit)",
          edit: { original: "Original one.", revised: "Edited one." },
        },
      },
    ]);
    const after = applyOps([], ops1);
    // Second pass over the same document state must produce nothing.
    expect(diffToCommentOps(changes, after)).toEqual([]);
  });

  it("updates the edit payload when the block changes again", () => {
    const c1 = buildChangeSet(base, cur({ "blk-1": "Edited one." }));
    const comments = applyOps([], diffToCommentOps(c1, []));
    const c2 = buildChangeSet(base, cur({ "blk-1": "Edited one more." }));
    const ops = diffToCommentOps(c2, comments);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "update" });
    const after = applyOps(comments, ops);
    expect(diffToCommentOps(c2, after)).toEqual([]);
  });

  it("deletes the editor comment when the block is reverted", () => {
    const c1 = buildChangeSet(base, cur({ "blk-1": "Edited one." }));
    const comments = applyOps([], diffToCommentOps(c1, []));
    const reverted = buildChangeSet(base, cur());
    const ops = diffToCommentOps(reverted, comments);
    expect(ops).toEqual([{ op: "delete", id: comments[0].id }]);
    expect(diffToCommentOps(reverted, applyOps(comments, ops))).toEqual([]);
  });

  it("never touches sidebar-only / feedback / submitted comments", () => {
    const foreign: Comment[] = [
      { id: "c-001", type: "feedback", anchorId: "A", body: "x", createdAt: 0, status: "draft" },
      { id: "c-002", type: "edit", anchorId: "A.p1", body: "y", createdAt: 0, status: "draft" },
      {
        id: "c-003",
        type: "edit",
        anchorId: "A.p2",
        blockId: "blk-2",
        body: "z",
        edit: { original: "Original two.", revised: "old" },
        createdAt: 0,
        status: "submitted",
      },
    ];
    const changes = buildChangeSet(base, cur({ "blk-1": "Edited one." }));
    const ops = diffToCommentOps(changes, foreign);
    // Only the new add for blk-1; the foreign comments are inert.
    expect(ops).toEqual([
      {
        op: "add",
        request: {
          type: "edit",
          anchorId: "A.p1",
          blockId: "blk-1",
          body: "(edit)",
          edit: { original: "Original one.", revised: "Edited one." },
        },
      },
    ]);
  });
});

describe("structural change detection", () => {
  it("emits a block-delete structural comment, then is idempotent", () => {
    // blk-2 removed from the document.
    const changes = buildChangeSet(base, [
      { blockId: "blk-1", anchorId: "A.p1", markdown: "Original one." },
    ]);
    expect(changes.find((c) => c.blockId === "blk-2")!.kind).toBe(
      "block-deleted",
    );
    const ops = diffToCommentOps(changes, []);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "add",
      request: {
        type: "block-delete",
        blockId: "blk-2",
        structural: { op: "delete", blockId: "blk-2", markdown: "Original two." },
      },
    });
    const after = applyOps([], ops);
    expect(diffToCommentOps(changes, after)).toEqual([]);
  });

  it("emits a block-insert for a brand-new block", () => {
    const changes = buildChangeSet(base, [
      ...cur(),
      { blockId: "blk-9", anchorId: "A.p3", markdown: "Inserted." },
    ]);
    const ops = diffToCommentOps(changes, []);
    expect(ops).toEqual([
      {
        op: "add",
        request: {
          type: "block-insert",
          anchorId: "A.p3",
          blockId: "blk-9",
          body: "(structural)",
          structural: {
            op: "insert",
            blockId: "blk-9",
            toAnchor: "A.p3",
            markdown: "Inserted.",
          },
        },
      },
    ]);
    expect(diffToCommentOps(changes, applyOps([], ops))).toEqual([]);
  });

  it("detects a reorder as block-moved and is idempotent", () => {
    // Swap order, content unchanged.
    const reordered = [
      { blockId: "blk-2", anchorId: "A.p1", markdown: "Original two." },
      { blockId: "blk-1", anchorId: "A.p2", markdown: "Original one." },
    ];
    const changes = buildChangeSet(base, reordered);
    const moved = changes.filter((c) => c.kind === "block-moved");
    expect(moved.length).toBeGreaterThanOrEqual(1);
    const ops = diffToCommentOps(
      changes,
      [],
      new Map([
        ["blk-1", "A.p1"],
        ["blk-2", "A.p2"],
      ]),
    );
    expect(ops.every((o) => o.op === "add")).toBe(true);
    const after = applyOps([], ops);
    expect(
      diffToCommentOps(
        changes,
        after,
        new Map([
          ["blk-1", "A.p1"],
          ["blk-2", "A.p2"],
        ]),
      ),
    ).toEqual([]);
  });

  it("drops the structural comment when the block is restored", () => {
    const del = buildChangeSet(base, [
      { blockId: "blk-1", anchorId: "A.p1", markdown: "Original one." },
    ]);
    const comments = applyOps([], diffToCommentOps(del, []));
    const restored = buildChangeSet(base, cur());
    const ops = diffToCommentOps(restored, comments);
    expect(ops).toEqual([{ op: "delete", id: comments[0].id }]);
  });
});

describe("commentsToBlockOverrides", () => {
  it("projects editor comments back to per-block revised markdown", () => {
    const comments: Comment[] = [
      {
        id: "c-001",
        type: "edit",
        anchorId: "A.p1",
        blockId: "blk-1",
        body: "(edit)",
        edit: { original: "Original one.", revised: "Reconciled." },
        createdAt: 0,
        status: "draft",
      },
    ];
    expect(commentsToBlockOverrides(comments)).toEqual(
      new Map([["blk-1", "Reconciled."]]),
    );
  });

  // Resolved / accepted / submitted edits must NOT survive into the override
  // map — once Claude has rewritten the block, the user's old draft proposal
  // is no longer the source of truth and `applyRevisionRedline` needs the
  // block freed up so its precise diff lands. Regression for the
  // "accept-and-continue" loop: a resolved thread's block should be paintable
  // by the revision redline on the next round.
  it("omits non-draft/non-reopened editor comments", () => {
    const base: Comment = {
      id: "c-001",
      type: "edit",
      anchorId: "A.p1",
      blockId: "blk-1",
      body: "(edit)",
      edit: { original: "Original.", revised: "Reconciled." },
      createdAt: 0,
      status: "draft",
    };
    for (const status of [
      "submitted",
      "resolved",
      "accepted",
      "withdrawn",
    ] as const) {
      expect(
        commentsToBlockOverrides([{ ...base, status }]),
        `status=${status} must not contribute to overrides`,
      ).toEqual(new Map());
    }
    // Reopened comments stay in the override map — the reviewer has explicitly
    // revived the proposal for the next round.
    expect(
      commentsToBlockOverrides([{ ...base, status: "reopened" }]),
    ).toEqual(new Map([["blk-1", "Reconciled."]]));
  });
});
