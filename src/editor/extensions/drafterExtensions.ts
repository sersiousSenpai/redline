// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";

/**
 * Extension set for the standalone Prompt Drafter — a Word-style document
 * editor used to author a prompt before launching a Claude Code plan session.
 *
 * Deliberately decoupled from `planExtensions`: the drafter is a throwaway
 * authoring surface with no review semantics, so it drops everything tied to
 * track-changes and the plan-review pipeline — Collaboration (Yjs CRDT),
 * BlockId/AnchorId attributes, the Insertion/Deletion marks, TrackChangesInput,
 * and the rich code-block NodeView (StarterKit's plain code block suffices).
 *
 * What it keeps is the everyday Word toolset: headings, bold/italic/strike,
 * lists, blockquote, code/code block, hr, undo/redo (StarterKit), plus inline
 * links, underline, and paragraph/heading text alignment.
 *
 * The prompt is serialized to markdown only at send time via
 * `planDocToMarkdown` (which ignores the `underline` mark and never reads
 * `textAlign`, so those two are intentionally dropped from the sent prompt —
 * they're for the human drafter, not semantic content for Claude).
 */
export function drafterExtensions(): Extensions {
  return [
    // StarterKit ships history ON by default (no Collaboration here), giving
    // native Cmd/Ctrl+Z undo. Its bundled `code`/`codeBlock` are fine in this
    // editor — there are no track-change marks for the `code` mark's
    // `excludes: '_'` to silently block.
    StarterKit,
    Link.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: false,
    }),
    Underline,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
  ];
}
