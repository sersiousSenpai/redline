// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import * as Y from "yjs";

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
  serializeDocBlocks,
  type SerializedBlock,
} from "../editor/docModel";
import { commentsToBlockOverrides } from "../editor/changeLedger";
import { planMarkdownToDoc } from "../editor/markdown";
import { useTrackChangesSync } from "../editor/useTrackChangesSync";
import {
  clearStalePlanYDocs,
  persistPlanYDoc,
  seedPlanYDocIfEmpty,
} from "../editor/yjs/planYDoc";

interface PlanEditorProps {
  /** Sidecar-augmented markdown from the latest revision. */
  markdown: string;
  sections: Section[];
  diff?: ParagraphDiff;
  comments?: Comment[];
  /** Changes when a new revision/thread arrives → content fully reloads. */
  revisionKey: string;
  /** Enables crash-recovery persistence (IndexedDB) for this session's
   *  Y.Docs and scopes the stale-entry sweep. Omitted → in-memory only. */
  sessionId?: string;
  onAddComment?: (req: NewCommentRequest) => Promise<unknown>;
  onUpdateComment?: (id: string, u: UpdateCommentRequest) => Promise<unknown>;
  onDeleteComment?: (id: string) => Promise<unknown>;
  /** Bidirectional focus: when a highlight is clicked, fires with that
   *  comment's id so the parent can mirror focus in the sidebar. */
  onHighlightClick?: (commentId: string) => void;
  /** Drives the `--focused` modifier on the matching in-doc highlight (and
   *  scrolls it into view when set). Single source of truth for the App. */
  focusedCommentId?: string | null;
  /** Imperative escape hatch so the App-rendered SelectionMenu can drive
   *  editor commands (e.g. Strike) without owning the editor instance. */
  actionsRef?: MutableRefObject<PlanEditorActions | null>;
}

/** Editor actions the App can invoke imperatively (it renders the
 *  SelectionMenu but doesn't hold the Tiptap editor). */
export interface PlanEditorActions {
  /** Strike the current selection in place, identical to the Delete key. */
  strikeSelection: () => void;
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
  sessionId,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  onHighlightClick,
  focusedCommentId,
  actionsRef,
}: PlanEditorProps) {
  const editable =
    !!onAddComment && !!onUpdateComment && !!onDeleteComment;

  const anchors = useMemo(() => anchorByBlockId(sections), [sections]);

  // Per-revision CRDT document — the editor's source of truth (M2). Content
  // arrives via hydration below (IndexedDB restore, else markdown seed),
  // never via useEditor `content`, so a restored doc is never double-seeded.
  const ydoc = useMemo(() => new Y.Doc(), [revisionKey]);

  // `hydrated` ⇔ this revision's Y.Doc is ready (restored and/or seeded).
  // Stored as the key it was hydrated under, so a revision change flips it
  // back to false with no reset effect.
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const hydrated = hydratedKey === revisionKey;

  // Immutable per-revision baseline — the diff/revert basis for the
  // changeLedger engine. Captured by the hydration effect below (see the
  // comment there for why it is headless AND state). `key` tags the revision
  // it belongs to so consumers can tell a fresh baseline from a stale one.
  const [base, setBase] = useState<{ key: string; blocks: SerializedBlock[] }>(
    { key: "", blocks: [] },
  );

  useEffect(() => {
    let cancelled = false;
    const persistence = sessionId ? persistPlanYDoc(revisionKey, ydoc) : null;
    const ready = persistence?.whenSynced ?? Promise.resolve();
    void ready.then(() => {
      if (cancelled) return;
      // Reconciliation rule: a persisted copy of the SAME revision wins (it
      // is this exact seed plus any uncommitted edits) — only an empty doc
      // gets seeded. A newer revision never reuses an old key, and its
      // superseded entries are swept here, so crash recovery can never
      // resurrect edits against an outdated plan version.
      seedPlanYDocIfEmpty(ydoc, markdown);
      if (sessionId) void clearStalePlanYDocs(sessionId, revisionKey);
      // Baseline + readiness land in ONE commit. The base is computed
      // headlessly from the revision markdown (byte-identical to the seed by
      // the round-trip fixed point) — never from the editor: a restored doc
      // may already carry uncommitted edits, which must not become the
      // diff/revert basis. And it stays STATE rather than a render-time
      // memo, deliberately: useTrackChangesSync flushes on unmount/disable,
      // and a memo would let a revision bump pair the NEW base with the OLD
      // editor content in that flush — phantom edit comments. As state it
      // lags until this revision's doc is actually live, same as the old
      // onCreate capture.
      setBase({
        key: revisionKey,
        blocks: serializeDocBlocks(planMarkdownToDoc(markdown), anchors),
      });
      setHydratedKey(revisionKey);
    });
    return () => {
      cancelled = true;
      void persistence?.destroy();
      // No explicit ydoc.destroy(): the editor bound to it tears down in a
      // separate effect whose order isn't guaranteed; dropping all refs and
      // letting GC reclaim it is safe and avoids destroy-order races.
    };
    // `markdown`/`anchors` deliberately omitted: content reloads only on
    // revisionKey change — the same contract the old initialDoc memo had.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisionKey, ydoc, sessionId]);

  const extensions = useMemo(
    () => [
      ...planExtensions({ document: ydoc }),
      RedlineDecorations,
      CommentHighlights,
      CommentMarkers,
      SearchHighlight,
    ],
    [ydoc],
  );
  const scheduleRef = useRef<(() => void) | null>(null);

  const editor = useEditor(
    {
      extensions,
      // Read-only until hydration so a keystroke can't land in the Y.Doc
      // before the seed/restore decision is made (a pre-seed keystroke would
      // make the doc non-empty and suppress seeding entirely).
      editable: editable && hydrated,
      editorProps: {
        attributes: {
          class: "rl-prose font-serif",
          "aria-label": "Plan document",
        },
      },
      onUpdate: ({ editor, transaction }) => {
        // Pre-hydration instance: ignore the Y.Doc binding's restore/seed
        // writes — they are content arriving, not edits to sync.
        if (!hydrated) return;
        // Ignore our own reverse-projection writes and pure selection moves.
        if (transaction.getMeta("rl-sync")) return;
        if (!transaction.docChanged) return;
        void editor; // keep signature stable
        scheduleRef.current?.();
      },
    },
    // Recreated when hydration completes, so every downstream [editor]
    // effect re-runs against the populated document and the post-hydration
    // sync semantics above hold. The first ySync transaction on the new
    // instance (ydoc → fresh PM state) replays restored content; if it
    // contains uncommitted pre-crash edits, the scheduled flush re-derives
    // their comments against the clean base — that IS the crash recovery.
    [revisionKey, hydrated],
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
    enabled:
      editable &&
      hydrated &&
      base.key === revisionKey &&
      base.blocks.length > 0,
  });
  scheduleRef.current = schedule;

  // Publish imperative actions for the App-rendered SelectionMenu.
  useEffect(() => {
    if (!actionsRef) return;
    actionsRef.current = editor
      ? {
          strikeSelection: () => {
            editor.commands.strikeSelection();
          },
        }
      : null;
    return () => {
      actionsRef.current = null;
    };
  }, [editor, actionsRef]);

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
    // Stale-base guard, hydration edition: bail until this revision's Y.Doc
    // content is actually live in the editor AND the baseline was captured
    // under this same revision — so the projection never runs over an empty,
    // still-restoring, or cross-revision doc/base pairing (which would
    // revert fresh prose to a stale baseline).
    if (!editor || !editable || !hydrated || base.key !== revisionKey) return;
    if (base.blocks.length === 0) return;
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
  }, [editor, editable, hydrated, comments, base, sections, diff, revisionKey]);

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
