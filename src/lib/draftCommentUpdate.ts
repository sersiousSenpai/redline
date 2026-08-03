// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Comment, UpdateCommentRequest } from "../types";

/**
 * Build the update payload for editing a still-draft comment's text in the
 * pane. Deliberately narrow: only `body` (and, for edit-kind comments,
 * `edit.revised`) are ever sent. `selection` / `blockId` / `scope` /
 * `structural` are always omitted — an absent Option on the backend means
 * "keep", which is exactly the anchor-unchanged contract this composer needs
 * (the highlight was placed by `original` + selection, and neither may move).
 */
export function buildDraftCommentUpdate(
  comment: Comment,
  bodyDraft: string,
  revisedDraft?: string,
): UpdateCommentRequest {
  const body = bodyDraft.trim();
  const update: UpdateCommentRequest = {
    // Edit comments use "(edit)" as the canonical empty-note placeholder —
    // restore it rather than persisting an empty string.
    body: body || (comment.type === "edit" ? "(edit)" : comment.body),
  };
  if (comment.type === "edit" && comment.edit && revisedDraft !== undefined) {
    const revised = revisedDraft.trim();
    if (revised) {
      update.edit = { original: comment.edit.original, revised };
    }
  }
  return update;
}
