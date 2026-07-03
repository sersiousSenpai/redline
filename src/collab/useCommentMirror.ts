// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * Owner-side comment mirror: SQLite stays writer-of-record, the room doc's
 * comments map is the wire.
 *
 * SQLite → map: `mirror(comments)` on every `comments-changed` reload —
 * idempotent (unchanged entries emit no ops), tagged `SQLITE_MIRROR`.
 * map → SQLite: the observer applies remote writes through the normal Tauri
 * comment commands, IGNORING transactions tagged `SQLITE_MIRROR` — that
 * single origin check is what breaks the echo loop.
 *
 * The core is a plain object (`createCommentMirror`) so the echo-loop
 * behavior is testable with two in-memory Y.Docs; the hook is a thin
 * lifecycle wrapper.
 */
import { useEffect, useRef } from "react";
import type * as Y from "yjs";

import type {
  Comment,
  NewCommentRequest,
  UpdateCommentRequest,
} from "../types";
import { observeComments, writeComments, SQLITE_MIRROR } from "./commentsYjs";

export interface CommentMirrorBackend {
  addComment(req: NewCommentRequest): Promise<unknown>;
  updateComment(id: string, u: UpdateCommentRequest): Promise<unknown>;
  deleteComment(id: string): Promise<unknown>;
}

export interface CommentMirror {
  /** Push the current SQLite comment set into the map. Returns Yjs op
   *  count — 0 when nothing changed (re-mirror no-op). */
  mirror(comments: Comment[]): number;
  destroy(): void;
}

function toNewCommentRequest(c: Comment): NewCommentRequest {
  return {
    id: c.id,
    type: c.type,
    ...(c.scope ? { scope: c.scope } : {}),
    anchorId: c.anchorId,
    ...(c.blockId ? { blockId: c.blockId } : {}),
    body: c.body,
    ...(c.edit ? { edit: c.edit } : {}),
    ...(c.structural ? { structural: c.structural } : {}),
    ...(c.selection ? { selection: c.selection } : {}),
  };
}

function toUpdateRequest(c: Comment): UpdateCommentRequest {
  return {
    body: c.body,
    ...(c.scope ? { scope: c.scope } : {}),
    ...(c.blockId ? { blockId: c.blockId } : {}),
    ...(c.edit ? { edit: c.edit } : {}),
    ...(c.structural ? { structural: c.structural } : {}),
    ...(c.selection ? { selection: c.selection } : {}),
  };
}

export function createCommentMirror(
  ydoc: Y.Doc,
  backend: CommentMirrorBackend,
  initialComments: Comment[] = [],
): CommentMirror {
  // The last SQLite snapshot, by id — the basis for classifying a remote
  // write as add vs update and for ignoring deletes of unknown ids. Seeded
  // at creation so map entries replayed by IndexedDB restore (which arrive
  // before the first `mirror()` call) don't read as fresh adds.
  let known = new Map<string, Comment>(initialComments.map((c) => [c.id, c]));

  const unobserve = observeComments(ydoc, (changes, origin) => {
    if (origin === SQLITE_MIRROR) return;
    for (const change of changes) {
      if (change.action === "delete") {
        if (known.has(change.commentId)) {
          known.delete(change.commentId);
          void backend.deleteComment(change.commentId);
        }
        continue;
      }
      const comment = change.comment;
      if (!comment) continue;
      const existing = known.get(comment.id);
      if (!existing) {
        // Also covers an "update" for an id we never saw (missed add):
        // add_comment with an explicit id is idempotent, so this converges.
        known.set(comment.id, comment);
        void backend.addComment(toNewCommentRequest(comment));
      } else if (JSON.stringify(existing) !== JSON.stringify(comment)) {
        known.set(comment.id, comment);
        void backend.updateComment(comment.id, toUpdateRequest(comment));
      }
    }
  });

  return {
    mirror(comments: Comment[]): number {
      known = new Map(comments.map((c) => [c.id, c]));
      return writeComments(ydoc, comments, SQLITE_MIRROR);
    },
    destroy: unobserve,
  };
}

export interface UseCommentMirrorOptions {
  /** The live room doc (from the provider handle); null detaches. */
  ydoc: Y.Doc | null;
  /** Owner-only: mirror runs on the SQLite side of the bridge. */
  enabled: boolean;
  /** Current SQLite comment set (the `comments-changed` reload output). */
  comments: Comment[];
  backend: CommentMirrorBackend;
}

export function useCommentMirror({
  ydoc,
  enabled,
  comments,
  backend,
}: UseCommentMirrorOptions): void {
  // Backend identity is read at call time so parent re-renders don't
  // recreate the mirror (and re-observe the map).
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const mirrorRef = useRef<CommentMirror | null>(null);

  useEffect(() => {
    if (!enabled || !ydoc) return;
    const mirror = createCommentMirror(
      ydoc,
      {
        addComment: (req) => backendRef.current.addComment(req),
        updateComment: (id, u) => backendRef.current.updateComment(id, u),
        deleteComment: (id) => backendRef.current.deleteComment(id),
      },
      commentsRef.current,
    );
    mirrorRef.current = mirror;
    // Publish the current set immediately so a joiner who synced before the
    // next comments-changed reload still hydrates the full comment state.
    mirror.mirror(commentsRef.current);
    return () => {
      mirrorRef.current = null;
      mirror.destroy();
    };
  }, [ydoc, enabled]);

  useEffect(() => {
    mirrorRef.current?.mirror(comments);
  }, [comments]);
}
