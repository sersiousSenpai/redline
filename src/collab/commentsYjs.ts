// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * The shared comments map on a collab room's Y.Doc.
 *
 * Ownership model: the owner's SQLite stays writer-of-record; this map is
 * the wire. The owner mirrors SQLite→map after every `comments-changed`
 * reload (idempotent), and applies remote map writes back into SQLite via
 * the observer — with the mirror's own writes tagged `SQLITE_MIRROR` so the
 * echo loop breaks at the origin check, not by heuristics.
 */
import * as Y from "yjs";

import type { Comment } from "../types";

/** Transaction origin for owner mirror writes (SQLite → map). The owner's
 *  observer ignores transactions with this origin — that write IS SQLite
 *  state, applying it back would echo forever. */
export const SQLITE_MIRROR = "rl-sqlite-mirror";

/** The Y.Map field on the room doc: commentId → Comment JSON. */
export const COMMENTS_FIELD = "comments";

export function commentsMap(ydoc: Y.Doc): Y.Map<Comment> {
  return ydoc.getMap<Comment>(COMMENTS_FIELD);
}

export function readComments(ydoc: Y.Doc): Comment[] {
  const out: Comment[] = [];
  commentsMap(ydoc).forEach((c) => out.push(c));
  // Stable presentation order regardless of map iteration order.
  out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return out;
}

/**
 * Mirror a full comment set into the map (owner-side, SQLite → Yjs).
 * Idempotent by deep compare: unchanged entries produce no Yjs ops, so a
 * reload that changed nothing syncs nothing. Returns the op count so tests
 * (and callers) can assert the no-op case.
 *
 * The whole `Comment` rides through, `attachments` included — but the mesh
 * carries that field's JSON METADATA only, never the files. Attachment paths
 * are local to the machine that captured them, so a peer receives a comment
 * that names files it cannot open. That is deliberate: shipping bytes over the
 * mesh is a separate feature, and the payload transport (an absolute path read
 * by the author's own Claude Code session) only ever needs to work locally.
 */
export function writeComments(
  ydoc: Y.Doc,
  comments: Comment[],
  origin: unknown = SQLITE_MIRROR,
): number {
  const map = commentsMap(ydoc);
  let ops = 0;
  ydoc.transact(() => {
    const keep = new Set<string>();
    for (const comment of comments) {
      keep.add(comment.id);
      const existing = map.get(comment.id);
      if (existing && JSON.stringify(existing) === JSON.stringify(comment)) {
        continue;
      }
      map.set(comment.id, comment);
      ops++;
    }
    for (const key of Array.from(map.keys())) {
      if (!keep.has(key)) {
        map.delete(key);
        ops++;
      }
    }
  }, origin);
  return ops;
}

export function upsertComment(
  ydoc: Y.Doc,
  comment: Comment,
  origin?: unknown,
): void {
  ydoc.transact(() => {
    commentsMap(ydoc).set(comment.id, comment);
  }, origin);
}

export function removeComment(
  ydoc: Y.Doc,
  commentId: string,
  origin?: unknown,
): void {
  ydoc.transact(() => {
    commentsMap(ydoc).delete(commentId);
  }, origin);
}

export interface CommentChange {
  action: "add" | "update" | "delete";
  commentId: string;
  /** Present for add/update (the new value). */
  comment?: Comment;
}

/** Observe remote comment changes. The callback receives the decoded change
 *  list and the transaction origin — callers filter `SQLITE_MIRROR` (and
 *  anything else they originated) themselves. Returns an unsubscribe. */
export function observeComments(
  ydoc: Y.Doc,
  cb: (changes: CommentChange[], origin: unknown) => void,
): () => void {
  const map = commentsMap(ydoc);
  const handler = (event: Y.YMapEvent<Comment>) => {
    const changes: CommentChange[] = [];
    for (const [key, change] of event.changes.keys) {
      if (change.action === "delete") {
        changes.push({ action: "delete", commentId: key });
      } else {
        const comment = map.get(key);
        if (!comment) continue;
        changes.push({ action: change.action, commentId: key, comment });
      }
    }
    if (changes.length > 0) cb(changes, event.transaction.origin);
  };
  map.observe(handler);
  return () => map.unobserve(handler);
}
