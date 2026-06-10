// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef } from "react";

import type { Comment, UpdateCommentRequest, NewCommentRequest } from "../types";
import {
  buildChangeSet,
  diffToCommentOps,
  type BaseBlock,
} from "./changeLedger";

export interface SyncBackend {
  addComment: (req: NewCommentRequest) => Promise<unknown>;
  updateComment: (id: string, update: UpdateCommentRequest) => Promise<unknown>;
  deleteComment: (id: string) => Promise<unknown>;
}

/** Current per-block markdown as the editor sees it right now. */
export type ReadCurrentBlocks = () => {
  blockId: string;
  anchorId: string;
  markdown: string;
}[];

interface Options {
  /** The revision's published per-block markdown — a pure function of the
   *  revision markdown (NOT a captured editor snapshot; M3 dropped that). */
  seed: BaseBlock[];
  /** Revision the seed was derived for. */
  seedKey: string;
  /** Revision whose content is actually live in the editor (hydratedKey).
   *  Flush is a no-op while these disagree — at a revision flip the new seed
   *  must never be diffed against the outgoing editor's blocks. */
  editorKey: string | null;
  comments: Comment[];
  backend: SyncBackend;
  readCurrent: ReadCurrentBlocks;
  /** Debounce window; flushed early on blur / mode-toggle. */
  debounceMs?: number;
  enabled: boolean;
}

/**
 * Debounced doc→sidebar projection (D3: batched, not streamed to Claude).
 *
 * M3: one-way. Suggestion marks in the document are the source of truth; on
 * a quiet point after edits this recomputes the accept-all change set against
 * the revision seed, diffs it against the persisted draft comments keyed by
 * blockId, and applies the minimal add/update/delete operations. Idempotency
 * lives in `diffToCommentOps` (Vitest-gated), so re-entrancy from the
 * resulting `comments-changed` event simply produces zero ops.
 */
export function useTrackChangesSync({
  seed,
  seedKey,
  editorKey,
  comments,
  backend,
  readCurrent,
  debounceMs = 800,
  enabled,
}: Options) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest values without re-arming the debounce on every render.
  const live = useRef({ seed, seedKey, editorKey, comments, backend, readCurrent });
  live.current = { seed, seedKey, editorKey, comments, backend, readCurrent };

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const { seed, seedKey, editorKey, comments, backend, readCurrent } =
      live.current;
    // Coherence guard: only diff a seed against editor content of the SAME
    // revision. (Sub-debounce edits made in the instant a new revision lands
    // are dropped rather than phantom-flushed against the wrong baseline.)
    if (seedKey !== editorKey) return;
    const changes = buildChangeSet(seed, readCurrent());
    const ops = diffToCommentOps(changes, comments);
    for (const op of ops) {
      try {
        if (op.op === "add") await backend.addComment(op.request);
        else if (op.op === "update")
          await backend.updateComment(op.id, op.update);
        else await backend.deleteComment(op.id);
      } catch (err) {
        console.error("track-changes sync op failed", op, err);
      }
    }
  }, []);

  const schedule = useCallback(() => {
    if (!enabled) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), debounceMs);
  }, [enabled, debounceMs, flush]);

  // Flush pending edits when leaving the editor or toggling modes.
  useEffect(() => {
    if (!enabled) return;
    const onBlur = () => void flush();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      // Mode-toggle / unmount: don't lose in-flight edits.
      void flush();
    };
  }, [enabled, flush]);

  return { schedule, flush };
}
