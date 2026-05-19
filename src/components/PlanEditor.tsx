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
}: PlanEditorProps) {
  const editable =
    !!onAddComment && !!onUpdateComment && !!onDeleteComment;

  const extensions = useMemo(
    () => [...planExtensions(), RedlineDecorations],
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

  return <EditorContent editor={editor} />;
}
