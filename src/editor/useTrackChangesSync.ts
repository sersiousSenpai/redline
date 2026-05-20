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
  base: BaseBlock[];
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
 * On a quiet point after edits it recomputes the change set, diffs it against
 * the persisted draft comments keyed by blockId, and applies the minimal
 * add/update/delete operations. Idempotency lives in `diffToCommentOps`
 * (Vitest-gated), so re-entrancy from the resulting `comments-changed` event
 * simply produces zero ops and the loop terminates.
 */
export function useTrackChangesSync({
  base,
  comments,
  backend,
  readCurrent,
  debounceMs = 800,
  enabled,
}: Options) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest values without re-arming the debounce on every render.
  const live = useRef({ base, comments, backend, readCurrent });
  live.current = { base, comments, backend, readCurrent };

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const { base, comments, backend, readCurrent } = live.current;
    const changes = buildChangeSet(base, readCurrent());
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
