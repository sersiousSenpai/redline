// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";

import type { ParagraphDiff } from "../diff";
import type {
  Comment,
  NewCommentRequest,
  Section,
  UpdateCommentRequest,
} from "../types";
import { planExtensions } from "../editor/extensions/planExtensions";
import { RedlineDecorations } from "../editor/extensions/RedlineDecorations";
import {
  CommentHighlights,
  type CommentHighlightRange,
} from "../editor/extensions/CommentHighlights";
import {
  anchorByBlockId,
  applyAnchorIds,
  applyCommentOverridesToEditor,
  applyRevisionRedline,
  redlineStatusByBlockId,
  revisionEditByBlockId,
  serializeBlocks,
  type SerializedBlock,
} from "../editor/docModel";
import { commentsToBlockOverrides } from "../editor/changeLedger";
import { planMarkdownToDoc } from "../editor/markdown";
import { useTrackChangesSync } from "../editor/useTrackChangesSync";

interface PlanEditorProps {
  /** Sidecar-augmented markdown from the latest revision. */
  markdown: string;
  sections: Section[];
  diff?: ParagraphDiff;
  comments?: Comment[];
  /** Changes when a new revision/thread arrives → content fully reloads. */
  revisionKey: string;
  onAddComment?: (req: NewCommentRequest) => Promise<unknown>;
  onUpdateComment?: (id: string, u: UpdateCommentRequest) => Promise<unknown>;
  onDeleteComment?: (id: string) => Promise<unknown>;
  /** Bidirectional focus: when a highlight is clicked, fires with that
   *  comment's id so the parent can mirror focus in the sidebar. */
  onHighlightClick?: (commentId: string) => void;
  /** Drives the `--focused` modifier on the matching in-doc highlight (and
   *  scrolls it into view when set). Single source of truth for the App. */
  focusedCommentId?: string | null;
}

/**
 * The single cohesive Tiptap document — replacement for the per-block
 * `contentEditable` mosaic. One editing host ⇒ native drag-selection across
 * the whole document. Phase 2: editable, with the existing debounced
 * `changeLedger` doc↔comment sync wired on top (no inline marks yet).
 */
export function PlanEditor({
  markdown,
  sections,
  diff,
  comments,
  revisionKey,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  onHighlightClick,
  focusedCommentId,
}: PlanEditorProps) {
  const editable =
    !!onAddComment && !!onUpdateComment && !!onDeleteComment;

  const extensions = useMemo(
    () => [...planExtensions(), RedlineDecorations, CommentHighlights],
    [],
  );
  const initialDoc = useMemo(
    () => planMarkdownToDoc(markdown).toJSON(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revisionKey],
  );
  const anchors = useMemo(() => anchorByBlockId(sections), [sections]);

  // Immutable per-revision baseline (captured once the doc mounts) — the
  // diff/revert basis for the changeLedger engine.
  const [base, setBase] = useState<SerializedBlock[]>([]);
  const scheduleRef = useRef<(() => void) | null>(null);

  const editor = useEditor(
    {
      extensions,
      editable,
      content: initialDoc,
      editorProps: {
        attributes: {
          class: "rl-prose font-serif",
          "aria-label": "Plan document",
        },
      },
      onCreate: ({ editor }) => {
        setBase(serializeBlocks(editor, anchors));
      },
      onUpdate: ({ editor, transaction }) => {
        // Ignore our own reverse-projection writes and pure selection moves.
        if (transaction.getMeta("rl-sync")) return;
        if (!transaction.docChanged) return;
        void editor; // keep signature stable
        scheduleRef.current?.();
      },
    },
    [revisionKey],
  );

  const readCurrent = useCallback(
    () => (editor ? serializeBlocks(editor, anchors) : []),
    [editor, anchors],
  );

  const backend = useMemo(
    () => ({
      addComment: (req: NewCommentRequest) =>
        onAddComment?.(req) ?? Promise.resolve(),
      updateComment: (id: string, u: UpdateCommentRequest) =>
        onUpdateComment?.(id, u) ?? Promise.resolve(),
      deleteComment: (id: string) =>
        onDeleteComment?.(id) ?? Promise.resolve(),
    }),
    [onAddComment, onUpdateComment, onDeleteComment],
  );

  const { schedule } = useTrackChangesSync({
    base,
    comments: comments ?? [],
    backend,
    readCurrent,
    enabled: editable && base.length > 0,
  });
  scheduleRef.current = schedule;

  // Stamp data-anchor-id so useTextSelection + the Edit/Feedback/Question
  // SelectionMenu work over the single-document editor.
  useEffect(() => {
    if (!editor) return;
    applyAnchorIds(editor, anchors);
  }, [editor, anchors]);

  // Block-level decoration (covers headings/lists/code/tables + `moved`);
  // paragraph add/modify is additionally shown inline below.
  useEffect(() => {
    if (!editor) return;
    editor.commands.setRedlineStatuses(redlineStatusByBlockId(sections, diff));
  }, [editor, sections, diff]);

  // Unified reconcile (idempotent; caret/echo-guarded inside): first project
  // edit comments to inline ins/del marks, then fold the revision redline
  // into the same language for any paragraph an edit comment doesn't own.
  useEffect(() => {
    if (!editor || !editable || base.length === 0) return;
    // Stale-base guard. On revisionKey change the editor is recreated and a
    // new `base` is captured in onCreate, but there's a render gap during
    // which this effect can fire with the *new* editor and the *old* base
    // (from v_{n-1}). When that happens, baseMap lookups miss for every
    // current block, `applyRevisionRedline`'s baseline is wrong, and the
    // revision redline silently fails to render. Bail out; the follow-up
    // render with the fresh base will retry.
    const liveBlockIds = new Set<string>();
    editor.state.doc.forEach((node) => {
      const id = node.attrs?.blockId as string | undefined;
      if (id) liveBlockIds.add(id);
    });
    if (!base.some((b) => liveBlockIds.has(b.blockId))) return;
    const baseMap = new Map(base.map((b) => [b.blockId, b.markdown]));
    applyCommentOverridesToEditor(editor, comments ?? [], baseMap);
    const overridden = new Set(
      commentsToBlockOverrides(comments ?? []).keys(),
    );
    applyRevisionRedline(
      editor,
      revisionEditByBlockId(sections, diff),
      overridden,
    );
  }, [editor, editable, comments, base, sections, diff]);

  // Project selection-anchored comments to inline highlight decorations.
  // Skipped for comments without a stored `selection` (legacy / sidebar-only).
  useEffect(() => {
    if (!editor) return;
    const ranges: CommentHighlightRange[] = (comments ?? [])
      .filter((c) => !!c.selection && !!c.blockId)
      .map((c) => ({
        commentId: c.id,
        blockId: c.blockId as string,
        charStart: c.selection!.charStart,
        charEnd: c.selection!.charEnd,
        quotedText: c.selection!.quotedText,
        muted: c.status === "resolved" || c.status === "accepted",
      }));
    editor.commands.setCommentHighlights(ranges);
  }, [editor, comments]);

  // Mirror the external focused-comment state into the extension storage so
  // the matching decoration gets the `--focused` modifier (and scroll the
  // highlight into view). Falls back to scrolling the comment's *block* when
  // there's no in-doc highlight to scroll to — covers comments without a
  // stored selection and comments whose `blockId` no longer matches any
  // block in the current revision (orphan case).
  useEffect(() => {
    if (!editor) return;
    editor.commands.focusCommentHighlight(focusedCommentId ?? null);
    if (!focusedCommentId) return;
    const dom = editor.view.dom.querySelector(
      `[data-comment-id="${cssEscape(focusedCommentId)}"]`,
    );
    if (dom instanceof HTMLElement) {
      dom.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const target = (comments ?? []).find((c) => c.id === focusedCommentId);
    const targetBlockId = target?.blockId;
    if (!targetBlockId) return;
    let scrolled = false;
    editor.state.doc.forEach((node, pos) => {
      if (scrolled) return;
      if (node.attrs?.blockId !== targetBlockId) return;
      const dom = editor.view.nodeDOM(pos);
      if (dom instanceof HTMLElement) {
        dom.scrollIntoView({ block: "center", behavior: "smooth" });
        scrolled = true;
      }
    });
  }, [editor, focusedCommentId, comments]);

  // Click on any highlight → fire the parent's callback. Re-binds when the
  // parent's handler identity changes so a stale closure can't capture an
  // old focused-id state.
  useEffect(() => {
    if (!editor) return;
    editor.commands.bindHighlightClick(onHighlightClick ?? null);
  }, [editor, onHighlightClick]);

  return <EditorContent editor={editor} />;
}

/** Minimal CSS.escape polyfill — Tauri WebViews support it but TS lib defs
 *  may flag it as `any`. Comment ids are `c-NNN`, so plain concatenation is
 *  safe; this keeps the query bulletproof if the id format ever changes. */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/["\\\n]/g, "\\$&");
}
