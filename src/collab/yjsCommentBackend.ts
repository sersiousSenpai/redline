// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Collaborator-side comment backend: implements the editor's `SyncBackend`
 * shape as direct writes to the room doc's comments map — no Tauri, no
 * SQLite. The owner's mirror observes the map and lands these in SQLite
 * (writer-of-record), then re-mirrors the canonical row back, which is why
 * ids are minted here as `c-{client}-{ts}-{n}`: never colliding with the
 * owner's `c-NNN` sequence and stable across the round-trip.
 */
import type * as Y from "yjs";

import type {
  Comment,
  NewCommentRequest,
  UpdateCommentRequest,
} from "../types";
import {
  commentsMap,
  observeComments,
  readComments,
  removeComment,
  upsertComment,
} from "./commentsYjs";

export interface YjsCommentBackend {
  addComment(req: NewCommentRequest): Promise<Comment>;
  updateComment(id: string, u: UpdateCommentRequest): Promise<unknown>;
  deleteComment(id: string): Promise<unknown>;
  /** Current comment set, presentation-ordered. */
  list(): Comment[];
  /** Re-render signal on any map change (local or remote). */
  observe(cb: () => void): () => void;
}

export function createYjsCommentBackend(
  ydoc: Y.Doc,
  clientId: number | string,
  /** This collaborator's display name — stamped as `reviewer` so the owner
   *  side persists attribution ("who wrote this comment"). */
  reviewerName?: string,
): YjsCommentBackend {
  const origin = `rl-collab-${clientId}`;
  let seq = 0;

  return {
    addComment(req: NewCommentRequest): Promise<Comment> {
      const comment: Comment = {
        id: req.id ?? `c-${clientId}-${Date.now()}-${seq++}`,
        type: req.type,
        ...(req.scope ? { scope: req.scope } : {}),
        anchorId: req.anchorId,
        ...(req.blockId ? { blockId: req.blockId } : {}),
        body: req.body,
        ...(req.edit ? { edit: req.edit } : {}),
        ...(req.structural ? { structural: req.structural } : {}),
        createdAt: Date.now(),
        status: "draft",
        ...(req.selection ? { selection: req.selection } : {}),
        ...(reviewerName ? { reviewer: reviewerName } : {}),
      };
      upsertComment(ydoc, comment, origin);
      return Promise.resolve(comment);
    },

    updateComment(id: string, u: UpdateCommentRequest): Promise<unknown> {
      const existing = commentsMap(ydoc).get(id);
      if (!existing) return Promise.resolve(null);
      const next: Comment = {
        ...existing,
        ...(u.body !== undefined ? { body: u.body } : {}),
        ...(u.scope !== undefined ? { scope: u.scope } : {}),
        ...(u.blockId !== undefined ? { blockId: u.blockId } : {}),
        ...(u.edit !== undefined ? { edit: u.edit } : {}),
        ...(u.structural !== undefined ? { structural: u.structural } : {}),
        ...(u.selection !== undefined ? { selection: u.selection } : {}),
      };
      upsertComment(ydoc, next, origin);
      return Promise.resolve(next);
    },

    deleteComment(id: string): Promise<unknown> {
      removeComment(ydoc, id, origin);
      return Promise.resolve(true);
    },

    list(): Comment[] {
      return readComments(ydoc);
    },

    observe(cb: () => void): () => void {
      return observeComments(ydoc, () => cb());
    },
  };
}
