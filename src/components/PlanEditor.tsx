// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";

import type { ParagraphDiff, SubBlockDiffEntry } from "../diff";
import type {
  Comment,
  NewCommentRequest,
  Section,
  UpdateCommentRequest,
} from "../types";
import { planExtensions } from "../editor/extensions/planExtensions";
import { RedlineDecorations } from "../editor/extensions/RedlineDecorations";
import { CommentMarkers } from "../editor/extensions/CommentMarkers";
import {
  CommentHighlights,
  type CommentHighlightRange,
} from "../editor/extensions/CommentHighlights";
import { SearchHighlight } from "../editor/extensions/SearchHighlight";
import { PlanSearchBox } from "./PlanSearchBox";
import {
  anchorByBlockId,
  applyAnchorIds,
  applyCommentOverridesToEditor,
  applyRevisionRedline,
  blockIdByAnchorId,
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
    () => [
      ...planExtensions(),
      RedlineDecorations,
      CommentHighlights,
      CommentMarkers,
      SearchHighlight,
    ],
    [],
  );
  const initialDoc = useMemo(
    () => planMarkdownToDoc(markdown).toJSON(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revisionKey],
  );
  const anchors = useMemo(() => anchorByBlockId(sections), [sections]);

  // Immutable per-revision baseline (captured once the doc mounts) — the
  // diff/revert basis for the changeLedger engine. Tagged with the
  // `revisionKey` it was captured under so the reconcile effect can tell a
  // fresh baseline apart from a stale one left over from the prior revision.
  const [base, setBase] = useState<{ key: string; blocks: SerializedBlock[] }>(
    { key: "", blocks: [] },
  );
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
        setBase({
          key: revisionKey,
          blocks: serializeBlocks(editor, anchors),
        });
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
    base: base.blocks,
    comments: comments ?? [],
    backend,
    readCurrent,
    enabled: editable && base.blocks.length > 0,
  });
  scheduleRef.current = schedule;

  // Stamp data-anchor-id so useTextSelection + the Edit/Feedback/Question
  // SelectionMenu work over the single-document editor.
  useEffect(() => {
    if (!editor) return;
    applyAnchorIds(editor, anchors);
  }, [editor, anchors]);

  // Block-level decoration (covers headings/lists/code/tables + `moved`);
  // paragraph add/modify is additionally shown inline below. Sub-block
  // (sentence-level) decomposition rides along — when present, the gutter
  // bar paints against just the modified sentences inside a paragraph.
  useEffect(() => {
    if (!editor) return;
    editor.commands.setRedlineStatuses(redlineStatusByBlockId(sections, diff));
    const subBlocks = new Map<string, SubBlockDiffEntry[]>();
    if (diff) {
      const walk = (secs: typeof sections) => {
        for (const s of secs) {
          for (const p of s.paragraphs) {
            const info = diff.get(p.anchorId);
            if (p.blockId && info?.subBlocks && info.subBlocks.length > 0) {
              subBlocks.set(p.blockId, info.subBlocks);
            }
          }
          walk(s.children);
        }
      };
      walk(sections);
    }
    editor.commands.setRedlineSubBlocks(subBlocks);
  }, [editor, sections, diff]);

  // Unified reconcile (idempotent; caret/echo-guarded inside): first project
  // edit comments to inline ins/del marks, then fold the revision redline
  // into the same language for any paragraph an edit comment doesn't own.
  useEffect(() => {
    if (!editor || !editable || base.blocks.length === 0) return;
    // Stale-base guard. On revisionKey change the editor is recreated, but
    // Tiptap emits `create` on a deferred tick — so this effect can fire with
    // the *new* editor while `base` is still the snapshot from the previous
    // revision. Running `applyCommentOverridesToEditor` then would revert the
    // new revision's prose back to the stale base (and the deferred onCreate
    // would lock that revert into `base`). `base.key` is the `revisionKey` the
    // snapshot was captured under; bail until it matches the current revision
    // — the onCreate that follows captures the fresh base and re-runs this.
    if (base.key !== revisionKey) return;
    const baseMap = new Map(base.blocks.map((b) => [b.blockId, b.markdown]));
    applyCommentOverridesToEditor(editor, comments ?? [], baseMap);
    const overridden = new Set(
      commentsToBlockOverrides(comments ?? []).keys(),
    );
    applyRevisionRedline(
      editor,
      revisionEditByBlockId(sections, diff),
      overridden,
    );
  }, [editor, editable, comments, base, sections, diff, revisionKey]);

  // Resolve blockId from a comment's positional anchorId when the comment
  // itself carries none — covers comments persisted before blockId was
  // recorded on selection-originated comments.
  const blockByAnchor = useMemo(
    () => blockIdByAnchorId(sections),
    [sections],
  );

  // Mark blocks that carry at least one un-dismissed comment, so the gutter
  // can render a small dot next to them (CSS picks up `.rl-has-comments`).
  // Resolved/accepted comments don't count — those are visually muted in the
  // sidebar already and the gutter dot would be noise.
  useEffect(() => {
    if (!editor) return;
    const ids = new Set<string>();
    for (const c of comments ?? []) {
      if (c.status === "resolved" || c.status === "accepted") continue;
      const blockId = c.blockId ?? blockByAnchor.get(c.anchorId);
      if (blockId) ids.add(blockId);
    }
    editor.commands.setCommentedBlocks(ids);
  }, [editor, comments, blockByAnchor]);

  // Project selection-anchored comments to inline highlight decorations.
  // Skipped for comments without a stored `selection` (legacy / sidebar-only)
  // or with no resolvable blockId.
  useEffect(() => {
    if (!editor) return;
    const ranges: CommentHighlightRange[] = (comments ?? [])
      .flatMap<CommentHighlightRange>((c) => {
        const blockId = c.blockId ?? blockByAnchor.get(c.anchorId);
        if (!c.selection || !blockId) return [];
        const range: CommentHighlightRange = {
          commentId: c.id,
          blockId,
          charStart: c.selection.charStart,
          charEnd: c.selection.charEnd,
          quotedText: c.selection.quotedText,
          muted: c.status === "resolved" || c.status === "accepted",
        };
        if (c.selection.subBlockId) range.subBlockId = c.selection.subBlockId;
        return [range];
      });
    editor.commands.setCommentHighlights(ranges);
  }, [editor, comments, blockByAnchor]);

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

  // In-document find (Cmd/Ctrl+F). PlanEditor owns the query + match counters;
  // the SearchHighlight extension owns the decorations and match positions.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCount, setSearchCount] = useState(0);
  const [searchActive, setSearchActive] = useState(-1);

  const syncSearchState = useCallback(() => {
    if (!editor) return;
    const s = editor.storage.searchHighlight;
    setSearchCount(s.matches.length);
    setSearchActive(s.activeIndex);
  }, [editor]);

  const scrollToActiveMatch = useCallback(() => {
    if (!editor) return;
    const s = editor.storage.searchHighlight;
    const m = s.matches[s.activeIndex];
    if (!m) return;
    const at = editor.view.domAtPos(m.from);
    const el =
      at.node instanceof HTMLElement ? at.node : at.node.parentElement;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [editor]);

  const runSearch = useCallback(
    (q: string) => {
      setSearchQuery(q);
      editor?.commands.setSearchQuery(q);
      syncSearchState();
      scrollToActiveMatch();
    },
    [editor, syncSearchState, scrollToActiveMatch],
  );

  const stepSearch = useCallback(
    (dir: "next" | "prev") => {
      if (!editor) return;
      if (dir === "next") editor.commands.nextMatch();
      else editor.commands.prevMatch();
      syncSearchState();
      scrollToActiveMatch();
    },
    [editor, syncSearchState, scrollToActiveMatch],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    editor?.commands.clearSearch();
    syncSearchState();
    editor?.commands.focus();
  }, [editor, syncSearchState]);

  // Intercept Cmd/Ctrl+F while the plan editor is mounted and open the find
  // bar instead of the WebView's native find.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchOpen(true);
        // Re-run the prior query against the latest doc so the count is fresh.
        if (editor && searchQuery) {
          editor.commands.setSearchQuery(searchQuery);
          syncSearchState();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editor, searchQuery, syncSearchState]);

  return (
    <div className="rl-editor-host">
      {searchOpen && (
        <PlanSearchBox
          query={searchQuery}
          onQueryChange={runSearch}
          matchCount={searchCount}
          activeIndex={searchActive}
          onNext={() => stepSearch("next")}
          onPrev={() => stepSearch("prev")}
          onClose={closeSearch}
        />
      )}
      <EditorContent editor={editor} />
    </div>
  );
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
