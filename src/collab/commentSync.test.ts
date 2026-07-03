// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import type { Comment, NewCommentRequest } from "../types";
import {
  commentsMap,
  readComments,
  writeComments,
  SQLITE_MIRROR,
  upsertComment,
} from "./commentsYjs";
import { createCommentMirror } from "./useCommentMirror";
import { createYjsCommentBackend } from "./yjsCommentBackend";

function comment(id: string, body = "hello", createdAt = 1): Comment {
  return {
    id,
    type: "feedback",
    anchorId: "A",
    body,
    createdAt,
    status: "draft",
  };
}

/** Two in-memory docs relayed by Y.applyUpdate — the network, minus the
 *  network. Relayed transactions arrive with origin "relay", i.e. anything
 *  but SQLITE_MIRROR, exactly like a y-webrtc peer update. */
function wire(a: Y.Doc, b: Y.Doc): void {
  a.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== "relay") Y.applyUpdate(b, u, "relay");
  });
  b.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== "relay") Y.applyUpdate(a, u, "relay");
  });
}

function spyBackend() {
  return {
    addComment: vi.fn((_req: NewCommentRequest) => Promise.resolve()),
    updateComment: vi.fn(() => Promise.resolve()),
    deleteComment: vi.fn(() => Promise.resolve()),
  };
}

describe("commentsYjs write/read", () => {
  it("round-trips and orders by createdAt", () => {
    const ydoc = new Y.Doc();
    writeComments(ydoc, [comment("c-002", "b", 5), comment("c-001", "a", 2)]);
    expect(readComments(ydoc).map((c) => c.id)).toEqual(["c-001", "c-002"]);
  });

  it("is idempotent: an unchanged re-mirror emits zero ops", () => {
    const ydoc = new Y.Doc();
    const set = [comment("c-001"), comment("c-002")];
    expect(writeComments(ydoc, set)).toBe(2);
    expect(writeComments(ydoc, set)).toBe(0);
    expect(writeComments(ydoc, [{ ...set[0], body: "edited" }, set[1]])).toBe(
      1,
    );
  });

  it("sweeps map entries missing from the mirrored set", () => {
    const ydoc = new Y.Doc();
    writeComments(ydoc, [comment("c-001"), comment("c-002")]);
    expect(writeComments(ydoc, [comment("c-001")])).toBe(1);
    expect(readComments(ydoc).map((c) => c.id)).toEqual(["c-001"]);
  });
});

describe("owner mirror ⇄ collaborator backend (echo loop)", () => {
  it("lands a remote add exactly once, and the canonical re-mirror does not echo", async () => {
    const owner = new Y.Doc();
    const collab = new Y.Doc();
    wire(owner, collab);
    const backend = spyBackend();
    const mirror = createCommentMirror(owner, backend, []);
    const remote = createYjsCommentBackend(collab, 99);

    const minted = (
      await remote.addComment({
        type: "feedback",
        anchorId: "A",
        body: "from remote",
      })
    ).id;

    expect(backend.addComment).toHaveBeenCalledTimes(1);
    const req = backend.addComment.mock.calls[0][0];
    expect(req.id).toBe(minted);
    expect(req.id).toMatch(/^c-99-/);
    expect(req.body).toBe("from remote");

    // SQLite accepted it (normalizing createdAt) and reloaded → re-mirror.
    const canonical: Comment = { ...comment(minted, "from remote", 777) };
    mirror.mirror([canonical]);
    // The canonical write reached the collaborator...
    expect(commentsMap(collab).get(minted)?.createdAt).toBe(777);
    // ...and echoed into NO further backend ops on the owner.
    expect(backend.addComment).toHaveBeenCalledTimes(1);
    expect(backend.updateComment).not.toHaveBeenCalled();
    expect(backend.deleteComment).not.toHaveBeenCalled();
    // Re-mirroring the same state is a no-op.
    expect(mirror.mirror([canonical])).toBe(0);
  });

  it("applies remote updates and deletes through the backend exactly once", async () => {
    const owner = new Y.Doc();
    const collab = new Y.Doc();
    wire(owner, collab);
    const backend = spyBackend();
    const mirror = createCommentMirror(owner, backend, []);
    const remote = createYjsCommentBackend(collab, 7);

    const id = (
      await remote.addComment({ type: "feedback", anchorId: "A", body: "v1" })
    ).id;
    mirror.mirror([comment(id, "v1", 10)]);

    void remote.updateComment(id, { body: "v2" });
    expect(backend.updateComment).toHaveBeenCalledTimes(1);
    expect(backend.updateComment.mock.calls[0]).toEqual([
      id,
      expect.objectContaining({ body: "v2" }),
    ]);
    mirror.mirror([comment(id, "v2", 10)]);

    void remote.deleteComment(id);
    expect(backend.deleteComment).toHaveBeenCalledTimes(1);
    expect(backend.deleteComment).toHaveBeenCalledWith(id);
    // Owner reload confirms the delete; sweep no-ops (already gone).
    expect(mirror.mirror([])).toBe(0);
    expect(backend.addComment).toHaveBeenCalledTimes(1);
  });

  it("owner-originated comments flow to the collaborator without echoing back", () => {
    const owner = new Y.Doc();
    const collab = new Y.Doc();
    wire(owner, collab);
    const backend = spyBackend();
    const mirror = createCommentMirror(owner, backend, []);
    const remote = createYjsCommentBackend(collab, 3);

    mirror.mirror([comment("c-001", "owner wrote this", 42)]);
    expect(remote.list().map((c) => c.id)).toEqual(["c-001"]);
    expect(backend.addComment).not.toHaveBeenCalled();
    expect(backend.updateComment).not.toHaveBeenCalled();

    // Owner deletes it; the collaborator's copy goes away, still no echo.
    mirror.mirror([]);
    expect(remote.list()).toEqual([]);
    expect(backend.deleteComment).not.toHaveBeenCalled();
  });

  it("ignores replayed adds equal to the known snapshot (IndexedDB restore)", () => {
    const owner = new Y.Doc();
    const known = comment("c-001", "restored", 5);
    const backend = spyBackend();
    createCommentMirror(owner, backend, [known]);
    // A persistence layer replays the exact entry the mirror wrote last
    // session — same id, same value, non-mirror origin.
    upsertComment(owner, { ...known }, "indexeddb-restore");
    expect(backend.addComment).not.toHaveBeenCalled();
    expect(backend.updateComment).not.toHaveBeenCalled();
  });

  it("treats an update for an unknown id as an add (missed add convergence)", () => {
    const owner = new Y.Doc();
    const backend = spyBackend();
    createCommentMirror(owner, backend, []);
    upsertComment(owner, comment("c-5-1", "late joiner state", 9), "relay");
    expect(backend.addComment).toHaveBeenCalledTimes(1);
    expect(backend.addComment.mock.calls[0][0].id).toBe("c-5-1");
  });

  it("never reacts to its own SQLITE_MIRROR transactions", () => {
    const owner = new Y.Doc();
    const backend = spyBackend();
    const mirror = createCommentMirror(owner, backend, []);
    mirror.mirror([comment("c-001"), comment("c-002", "x", 2)]);
    mirror.mirror([comment("c-001")]);
    expect(backend.addComment).not.toHaveBeenCalled();
    expect(backend.updateComment).not.toHaveBeenCalled();
    expect(backend.deleteComment).not.toHaveBeenCalled();
    expect(SQLITE_MIRROR).toBeTruthy();
  });
});
