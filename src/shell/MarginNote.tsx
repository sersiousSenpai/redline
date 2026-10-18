// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The margin note (board 4c): a mark's comment, set under the block it
//! marks — r10, 13px sans on the serif page, the author's initials in an
//! amber disc, indented 24px.
//!
//! The plan body is the stage's (a Tiptap document), so this ships two
//! shapes of one look: `MarginNote` for React, and `marginNoteElement` for a
//! ProseMirror widget decoration, which takes a DOM node. Both carry the same
//! classes, so `feedback.css` is the single source of how a note looks.

import "./feedback.css";

import type { ReactNode } from "react";

export interface MarginNoteProps {
  /** The author's initials ("IM"): `noteInitials(comment, ownerName)`. */
  initials: string;
  /** The note. */
  children: ReactNode;
  /** The note's comment id, for the highlight ↔ thread bridge. */
  commentId?: string;
  /** Opens the note's thread (the Feedback tab). Makes the note a button. */
  onOpen?: () => void;
}

export function MarginNote({ initials, children, commentId, onOpen }: MarginNoteProps) {
  const inner = (
    <>
      <span className="rl-margin-note-avatar" aria-hidden>
        {initials}
      </span>
      <span className="rl-margin-note-body">{children}</span>
    </>
  );
  if (onOpen) {
    return (
      <button type="button" className="rl-margin-note" data-comment-id={commentId} onClick={onOpen}>
        {inner}
      </button>
    );
  }
  return (
    <div className="rl-margin-note" role="note" data-comment-id={commentId}>
      {inner}
    </div>
  );
}

/** The same note as a DOM node, for `Decoration.widget(pos, () => …)` after
 *  the marked block. Text only — a widget re-renders from scratch, so the
 *  note's markdown is shown as its words. */
export function marginNoteElement(args: { initials: string; text: string; commentId?: string }): HTMLElement {
  const note = document.createElement("div");
  note.className = "rl-margin-note";
  note.setAttribute("role", "note");
  note.contentEditable = "false";
  if (args.commentId) note.dataset.commentId = args.commentId;
  const avatar = document.createElement("span");
  avatar.className = "rl-margin-note-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = args.initials;
  const body = document.createElement("span");
  body.className = "rl-margin-note-body";
  body.textContent = args.text;
  note.append(avatar, body);
  return note;
}
