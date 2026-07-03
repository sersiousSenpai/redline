// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  DiffFile,
  DiffLine,
  ReviewAnnotation,
  ReviewAnnotationKind,
  ReviewQuestion,
} from "../types";
import {
  displayPath,
  fileHeaderIndex,
  flattenDiff,
  hunkSideIndices,
  type DiffViewMode,
  type ReviewRow,
} from "../lib/flattenDiff";
import { visibleRange } from "../lib/virtual";
import { pairHunkLines, wordDiff, type WordSpan } from "../lib/wordDiff";
import { composeLineSpans, type HlToken, type MatchRange } from "../lib/composeSpans";
import { EXPAND_STEP, type ExpandSlot } from "../lib/expandContext";
import { matchRowIndex, type DiffMatch } from "../lib/searchDiff";
import { useDiffHighlight, type FileHighlight } from "../hooks/useDiffHighlight";
import {
  dragRange,
  lineInRange,
  nextAnnotationId,
  nextQuestionId,
  quotedTextForRange,
  reduceGutterClick,
  type ReviewRange,
} from "../lib/reviewSelection";
import {
  ReviewAnnotationCard,
  ReviewAnnotationComposer,
} from "./ReviewAnnotationCard";
import { ReviewThread } from "./ReviewThread";

// Annotatable diff view (Code Review surface). Renders the flattened
// file/hunk/line rows at a fixed height and virtualizes with the same window
// math as CodeView — only visible rows are ever in the DOM, so a huge diff
// scrolls flat. Word-level change tint comes from `wordDiff` on paired
// del/add lines. Annotation: gutter click / shift-click selects a range
// (`reviewSelection.ts`), a floating menu offers Comment / Mark deletion /
// Suggest, and cards anchor under their range INSIDE the scroll content (they
// scroll with the code; fixed row height stays intact for the virtualizer).
const LINE_HEIGHT = 18; // px; must match the row styling below.
const OVERSCAN = 60;
const DEFAULT_VIEWPORT_H = 800;
const MIN_THUMB_H = 28; // px; keep the drag indicator grabbable on huge diffs.

const MONO = "var(--font-mono, ui-monospace, Menlo, monospace)";

/** In-diff search feed: `grouped` for per-row marks, `list` + `activeIndex`
 *  for active-match navigation. */
export interface DiffSearch {
  grouped: Map<string, { start: number; end: number; index: number }[]>;
  list: DiffMatch[];
  activeIndex: number;
}

export interface DiffViewHandle {
  /** Jump so `path`'s header row sits at the viewport top. */
  scrollToFile(path: string): void;
}

interface DiffViewProps {
  files: DiffFile[];
  /** Identity of the diff *coordinates* (repo|source|base|sha|round). Scroll
   *  resets only when this changes — a hide-viewed filter or context
   *  expansion recreates `files` without yanking the viewport to the top. */
  diffKey: string;
  /** Unified or side-by-side rows. */
  mode: DiffViewMode;
  /** Paths the reviewer marked viewed — their bodies collapse to the header. */
  viewed: ReadonlySet<string>;
  onToggleViewed: (filePath: string) => void;
  /** Review-session context; absent (null reviewId) = read-only browsing. */
  reviewId: string | null;
  round: number;
  annotations: ReviewAnnotation[];
  onAddAnnotation: (a: ReviewAnnotation) => void;
  onUpdateAnnotation: (a: ReviewAnnotation) => void;
  onDeleteAnnotation: (id: string) => void;
  /** Present = expander rows render; called on click (all = ⌥-click). */
  onExpandContext?: (filePath: string, slot: ExpandSlot, all: boolean) => void;
  /** Active in-diff search, or null when the bar is closed. */
  search?: DiffSearch | null;
  /** Ask-AI questions on this review (✦ markers + threads). */
  questions?: ReviewQuestion[];
  onAddQuestion?: (q: ReviewQuestion) => void;
  onDeleteQuestion?: (id: string) => void;
}

const DiffView = forwardRef<DiffViewHandle, DiffViewProps>(function DiffView(
  {
    files,
    diffKey,
    mode,
    viewed,
    onToggleViewed,
    reviewId,
    round,
    annotations,
    onAddAnnotation,
    onUpdateAnnotation,
    onDeleteAnnotation,
    onExpandContext,
    search,
    questions,
    onAddQuestion,
    onDeleteQuestion,
  }: DiffViewProps,
  ref,
) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  const [selection, setSelection] = useState<ReviewRange | null>(null);
  // Id of the annotation being composed/edited; id of the one being viewed;
  // id of the open Ask-AI question thread.
  const [composerId, setComposerId] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [openQuestionId, setOpenQuestionId] = useState<string | null>(null);

  // X-key collapse is transient (unlike viewed, it isn't persisted) — both
  // fold a file to its header row.
  const [collapsedX, setCollapsedX] = useState<ReadonlySet<string>>(new Set());
  const hiddenPaths = useMemo(() => {
    if (collapsedX.size === 0) return viewed;
    const u = new Set(viewed);
    collapsedX.forEach((p) => u.add(p));
    return u;
  }, [viewed, collapsedX]);
  const canExpand = onExpandContext != null;
  const rows = useMemo(
    () => flattenDiff(files, hiddenPaths as Set<string>, mode, canExpand),
    [files, hiddenPaths, mode, canExpand],
  );

  // fileIndex:hunkIndex → del/add pairing for word-level tint. O(total lines),
  // rebuilt only when the diff itself changes.
  const pairs = useMemo(() => {
    const map = new Map<string, Map<number, number>>();
    files.forEach((f, fi) =>
      f.hunks.forEach((h, hi) => map.set(`${fi}:${hi}`, pairHunkLines(h))),
    );
    return map;
  }, [files]);

  // fileIndex:hunkIndex → per-line side-segment indices (highlight lookups).
  const sideIdx = useMemo(() => {
    const map = new Map<string, { oldIdx: number; newIdx: number }[]>();
    files.forEach((f, fi) =>
      f.hunks.forEach((h, hi) => map.set(`${fi}:${hi}`, hunkSideIndices(h))),
    );
    return map;
  }, [files]);

  // New diff *content* → transient UI state (selection, open overlays) may
  // point at lines that no longer exist; clear it. Scroll is NOT reset here —
  // a hide-viewed toggle or context expansion also recreates `files`.
  useLayoutEffect(() => {
    setSelection(null);
    setComposerId(null);
    setOpenCardId(null);
    setOpenQuestionId(null);
  }, [files]);

  // New diff *coordinates* (repo/source/base/sha/round) → back to the top,
  // and the transient X-collapse set no longer applies.
  useLayoutEffect(() => {
    setScrollTop(0);
    setCollapsedX(new Set());
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [diffKey]);

  // Jump-to-file for the sidebar tree.
  useImperativeHandle(
    ref,
    () => ({
      scrollToFile(path: string) {
        const idx = fileHeaderIndex(rows, path);
        if (idx >= 0 && scrollRef.current) scrollRef.current.scrollTop = idx * LINE_HEIGHT;
      },
    }),
    [rows],
  );

  // Active search match → center it in the viewport.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const viewportHRef = useRef(viewportH);
  viewportHRef.current = viewportH;
  useEffect(() => {
    if (!search || search.activeIndex < 0) return;
    const m = search.list[search.activeIndex];
    if (!m) return;
    const idx = matchRowIndex(rowsRef.current, m);
    if (idx < 0 || !scrollRef.current) return;
    const h = viewportHRef.current || DEFAULT_VIEWPORT_H;
    scrollRef.current.scrollTop = Math.max(0, idx * LINE_HEIGHT - h / 3);
  }, [search]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Coalesce scroll events to one state update per frame (CodeView pattern).
  const rafRef = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = scrollRef.current;
      if (el) setScrollTop(el.scrollTop);
    });
  }, []);
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // --- custom draggable scroll indicator ------------------------------------
  // The virtualized viewport uses a native (styled) scrollbar, but the thumb
  // is thin and easy to miss. This overlay indicator is always grabbable:
  // press it and drag to scrub the whole file, or click the track to jump.
  const totalH = rows.length * LINE_HEIGHT;
  const scrollable = totalH > viewportH + 1;
  const thumb = useMemo(() => {
    if (!scrollable || viewportH <= 0) return null;
    const trackH = viewportH;
    const thumbH = Math.max(MIN_THUMB_H, (trackH * viewportH) / totalH);
    const maxScroll = totalH - viewportH;
    const travel = trackH - thumbH;
    const top = maxScroll > 0 ? (scrollTop / maxScroll) * travel : 0;
    return { thumbH, top: Math.min(Math.max(0, top), travel), travel, maxScroll };
  }, [scrollable, viewportH, totalH, scrollTop]);

  // Map a pointer Y (relative to the track top) to a scrollTop, keeping the
  // grab offset so the thumb doesn't jump under the cursor.
  const thumbDragRef = useRef<{ grabOffset: number } | null>(null);
  const scrollToThumbTop = useCallback(
    (thumbTop: number) => {
      const el = scrollRef.current;
      if (!el || !thumb || thumb.travel <= 0) return;
      const clamped = Math.min(Math.max(0, thumbTop), thumb.travel);
      el.scrollTop = (clamped / thumb.travel) * thumb.maxScroll;
    },
    [thumb],
  );
  const onThumbPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!thumb) return;
      e.preventDefault();
      e.stopPropagation();
      const trackEl = e.currentTarget as HTMLElement;
      (trackEl as HTMLElement).setPointerCapture?.(e.pointerId);
      const trackTop = trackEl.getBoundingClientRect().top;
      const local = e.clientY - trackTop;
      // Grabbed the thumb body → preserve offset; grabbed the bare track →
      // center the thumb on the click, then drag from there.
      const onThumb = local >= thumb.top && local <= thumb.top + thumb.thumbH;
      const grabOffset = onThumb ? local - thumb.top : thumb.thumbH / 2;
      thumbDragRef.current = { grabOffset };
      scrollToThumbTop(local - grabOffset);
    },
    [thumb, scrollToThumbTop],
  );
  const onThumbPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = thumbDragRef.current;
      if (!d) return;
      e.preventDefault();
      const trackTop = (e.currentTarget as HTMLElement).getBoundingClientRect().top;
      scrollToThumbTop(e.clientY - trackTop - d.grabOffset);
    },
    [scrollToThumbTop],
  );
  const endThumbDrag = useCallback((e: React.PointerEvent) => {
    if (!thumbDragRef.current) return;
    thumbDragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  const canAnnotate = reviewId != null;

  // --- multi-line selection: click, shift-click, gutter drag, text drag ----
  // A press on the gutter/sign/+ column anchors a drag; rows entered while
  // the button is held extend the range live (the plan-review gesture applied
  // to diff lines). The click that fires after a real drag must not collapse
  // the range — it's suppressed once.
  const dragRef = useRef<{
    filePath: string;
    side: "old" | "new";
    anchorNo: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  // Click anywhere on a row (gutter, sign, or the code text itself) selects
  // it — the gutter-only surface proved undiscoverable in practice. A click
  // that ends a text drag-select is a copy/range gesture, not a line click.
  const handleSelectLine = useCallback(
    (filePath: string, line: DiffLine, shift: boolean, side?: "old" | "new") => {
      if (!canAnnotate) return;
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      setComposerId(null);
      setOpenCardId(null);
      setSelection((cur) => reduceGutterClick(cur, { filePath, line, shift, side }));
    },
    [canAnnotate],
  );

  const handleDragStart = useCallback(
    (filePath: string, line: DiffLine, side?: "old" | "new") => {
      if (!canAnnotate) return;
      const s = side ?? (line.kind === "del" ? "old" : "new");
      const no = s === "old" ? line.oldLine : line.newLine;
      if (no == null) return;
      dragRef.current = { filePath, side: s, anchorNo: no, moved: false };
      // The gutter mousedown preventDefault()s (to block native text
      // selection), which also skips focus — restore it so J/K keep working.
      scrollRef.current?.focus();
    },
    [canAnnotate],
  );

  const handleDragEnter = useCallback((filePath: string, line: DiffLine) => {
    const d = dragRef.current;
    if (!d || d.filePath !== filePath) return;
    const no = d.side === "old" ? line.oldLine : line.newLine;
    if (no != null && no !== d.anchorNo) d.moved = true;
    if (!d.moved) return;
    const range = dragRange(filePath, d.side, d.anchorNo, line);
    if (!range) return;
    setComposerId(null);
    setOpenCardId(null);
    setSelection(range);
  }, []);

  // Release anywhere ends the drag; a moved drag suppresses the trailing
  // click so the range survives.
  useEffect(() => {
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.moved) suppressClickRef.current = true;
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  // Text drag-select across lines = the plan-review gesture: on release, map
  // the DOM selection's endpoints to diff rows and select that line range.
  // The native selection is left intact, so copy still works.
  const handleTextSelectionRelease = useCallback(() => {
    if (!canAnnotate || dragRef.current) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const rowEl = (node: Node | null): HTMLElement | null => {
      const el = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
      return el?.closest<HTMLElement>("[data-path]") ?? null;
    };
    const a = rowEl(sel.anchorNode);
    const f = rowEl(sel.focusNode);
    if (!a || !f || !a.dataset.path || a.dataset.path !== f.dataset.path) return;
    // Split-view cells carry an explicit side; unified rows prefer the new
    // side and fall back to old (a selection ending on a del-only row).
    const sideOfEl = (el: HTMLElement): "old" | "new" | undefined =>
      el.closest<HTMLElement>("[data-cell-side]")?.dataset.cellSide as
        | "old"
        | "new"
        | undefined;
    const num = (el: HTMLElement, side: "old" | "new") => {
      const v = side === "old" ? el.dataset.old : el.dataset.new;
      return v ? Number(v) : null;
    };
    const trySide = (side: "old" | "new") => {
      const s = num(a, side);
      const e = num(f, side);
      return s != null && e != null
        ? { side, start: Math.min(s, e), end: Math.max(s, e) }
        : null;
    };
    const explicit = sideOfEl(a) ?? sideOfEl(f);
    const pick = explicit ? trySide(explicit) : (trySide("new") ?? trySide("old"));
    if (!pick || pick.start === pick.end) return; // single-line: click covers it
    setComposerId(null);
    setOpenCardId(null);
    setSelection({
      filePath: a.dataset.path,
      side: pick.side,
      startLine: pick.start,
      endLine: pick.end,
    });
  }, [canAnnotate]);

  /** Create the draft immediately (write-through crash persistence), then
   *  compose into it. */
  const startAnnotation = useCallback(
    (kind: ReviewAnnotationKind) => {
      if (!selection || !reviewId) return;
      const quotedText = quotedTextForRange(files, selection);
      if (!quotedText) return;
      const annotation: ReviewAnnotation = {
        id: nextAnnotationId(annotations),
        reviewId,
        round,
        filePath: selection.filePath,
        side: selection.side,
        startLine: selection.startLine,
        endLine: selection.endLine,
        kind,
        body: "",
        suggestionReplacement: kind === "suggestion" ? quotedText : undefined,
        quotedText,
        status: "draft",
        createdAt: Date.now(),
        scope: "line",
        source: "user",
      };
      onAddAnnotation(annotation);
      setSelection(null);
      setComposerId(annotation.id);
    },
    [selection, reviewId, round, files, annotations, onAddAnnotation],
  );

  /** Ask-AI about the selection: a question thread, never an annotation. */
  const startQuestion = useCallback(() => {
    if (!selection || !reviewId || !onAddQuestion) return;
    const quotedText = quotedTextForRange(files, selection);
    const question: ReviewQuestion = {
      id: nextQuestionId(questions ?? []),
      reviewId,
      filePath: selection.filePath,
      side: selection.side,
      startLine: selection.startLine,
      endLine: selection.endLine,
      quotedText,
      createdAt: Date.now(),
    };
    onAddQuestion(question);
    setSelection(null);
    setComposerId(null);
    setOpenCardId(null);
    setOpenQuestionId(question.id);
  }, [selection, reviewId, files, questions, onAddQuestion]);

  /** ✦ markers: questions anchored at this line (their start). */
  const questionsAt = useCallback(
    (filePath: string, line: DiffLine, cellSide?: "old" | "new") =>
      (questions ?? []).filter((q) => {
        if (q.filePath !== filePath) return false;
        if (cellSide && q.side !== cellSide) return false;
        const no = q.side === "old" ? line.oldLine : line.newLine;
        return no != null && no === q.startLine;
      }),
    [questions],
  );

  /** A whole-file note: anchored to the file, not a line range. */
  const startFileNote = useCallback(
    (filePath: string) => {
      if (!reviewId) return;
      const annotation: ReviewAnnotation = {
        id: nextAnnotationId(annotations),
        reviewId,
        round,
        filePath,
        side: "new",
        startLine: 0,
        endLine: 0,
        kind: "comment",
        body: "",
        quotedText: "",
        status: "draft",
        createdAt: Date.now(),
        scope: "file",
        source: "user",
      };
      onAddAnnotation(annotation);
      setSelection(null);
      setOpenCardId(null);
      setComposerId(annotation.id);
    },
    [reviewId, round, annotations, onAddAnnotation],
  );

  // Annotation lookup structures for row painting — small lists, rebuilt on
  // change; per-row checks stay O(annotations-for-file).
  const live = useMemo(
    () => annotations.filter((a) => a.status !== "orphaned"),
    [annotations],
  );
  // Per-file +N/−N for the sticky pin header. O(total lines), diff-keyed.
  const fileStats = useMemo(() => {
    const m = new Map<string, { adds: number; dels: number }>();
    files.forEach((f) => {
      let adds = 0;
      let dels = 0;
      f.hunks.forEach((h) =>
        h.lines.forEach((l) => {
          if (l.kind === "add") adds++;
          else if (l.kind === "del") dels++;
        }),
      );
      m.set(displayPath(f), { adds, dels });
    });
    return m;
  }, [files]);

  // The open card's range gets a binding ring on both the card and its rows.
  const openAnn = useMemo(
    () => (openCardId ? annotations.find((a) => a.id === openCardId) : undefined),
    [openCardId, annotations],
  );
  const ringAt = useCallback(
    (filePath: string, line: DiffLine, cellSide?: "old" | "new") => {
      if (!openAnn || openAnn.filePath !== filePath) return false;
      if (cellSide && openAnn.side !== cellSide) return false;
      const no = openAnn.side === "old" ? line.oldLine : line.newLine;
      return no != null && no >= openAnn.startLine && no <= openAnn.endLine;
    },
    [openAnn],
  );

  // `cellSide` (split view) restricts markers/tints to the cell that actually
  // owns the annotation's side — a context line exists in both cells.
  const markersAt = useCallback(
    (filePath: string, line: DiffLine, cellSide?: "old" | "new") =>
      live.filter((a) => {
        if (a.scope !== "line" || a.filePath !== filePath) return false;
        if (cellSide && a.side !== cellSide) return false;
        const no = a.side === "old" ? line.oldLine : line.newLine;
        return no != null && no === a.startLine;
      }),
    [live],
  );
  const lineAnnotated = useCallback(
    (filePath: string, line: DiffLine, cellSide?: "old" | "new") =>
      live.some((a) => {
        if (a.scope !== "line" || a.filePath !== filePath) return false;
        if (cellSide && a.side !== cellSide) return false;
        const no = a.side === "old" ? line.oldLine : line.newLine;
        return no != null && no >= a.startLine && no <= a.endLine;
      }),
    [live],
  );
  /** Whole-file notes anchored to `filePath` (rendered on its header row). */
  const fileNotesAt = useCallback(
    (filePath: string) =>
      live.filter((a) => a.scope === "file" && a.filePath === filePath),
    [live],
  );

  /** Row index of the line/pair row a range's END anchors to (cards hang
   *  there). -1 when the file is collapsed or the line isn't in this diff. */
  const anchorRowIndex = useCallback(
    (filePath: string, side: "old" | "new", lineNo: number) =>
      rows.findIndex((r) => {
        if (r.filePath !== filePath) return false;
        if (r.type === "line") {
          return (side === "old" ? r.line.oldLine : r.line.newLine) === lineNo;
        }
        if (r.type === "pair") {
          const cell = side === "old" ? r.left : r.right;
          return cell != null && (side === "old" ? cell.oldLine : cell.newLine) === lineNo;
        }
        return false;
      }),
    [rows],
  );

  const { start, end } = visibleRange(
    scrollTop,
    viewportH || DEFAULT_VIEWPORT_H,
    rows.length,
    LINE_HEIGHT,
    OVERSCAN,
  );

  // Files currently inside the window — the highlight request set. Stable
  // identity across scroll frames that show the same files, so the hook's
  // debounce isn't reset every frame.
  const windowPaths: string[] = [];
  for (let i = start; i < end && i < rows.length; i++) {
    const p = rows[i].filePath;
    if (windowPaths[windowPaths.length - 1] !== p) windowPaths.push(p);
  }
  const windowPathsKey = windowPaths.join(" ");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visiblePaths = useMemo(() => windowPaths, [windowPathsKey]);
  const highlights = useDiffHighlight(files, visiblePaths);

  /** Syntax tokens for one hunk line on one side, or null (plain). */
  const tokensFor = useCallback(
    (
      fileHl: FileHighlight | undefined,
      fileIndex: number,
      hunkIndex: number,
      lineIndex: number,
      side: "old" | "new",
    ): HlToken[] | null => {
      if (!fileHl || fileHl === "plain") return null;
      const seg = fileHl[hunkIndex * 2 + (side === "old" ? 0 : 1)];
      if (!seg) return null;
      const si = sideIdx.get(`${fileIndex}:${hunkIndex}`)?.[lineIndex];
      const idx = side === "old" ? si?.oldIdx : si?.newIdx;
      if (idx == null || idx < 0) return null;
      return seg[idx] ?? null;
    },
    [sideIdx],
  );

  // Keyboard file navigation (the classic review J/K/V set): J/K jump
  // to the next/previous file header, V toggles viewed on the file currently
  // at the top of the viewport. Scoped to the focused pane (tabIndex on the
  // scroll container), and never while typing in a composer.
  const fileRowIndices = useMemo(
    () =>
      rows.reduce<number[]>((acc, r, i) => {
        if (r.type === "file") acc.push(i);
        return acc;
      }, []),
    [rows],
  );
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;
      const key = e.key.toLowerCase();
      const el = scrollRef.current;
      if (!el) return;

      // [ / ] step between annotation anchors (their start rows).
      if (e.key === "[" || e.key === "]") {
        const anchors = live
          .map((a) => anchorRowIndex(a.filePath, a.side, a.startLine))
          .filter((i) => i >= 0)
          .sort((a, b) => a - b);
        if (anchors.length === 0) return;
        const topRow = Math.floor(el.scrollTop / LINE_HEIGHT) + 3;
        const next =
          e.key === "]"
            ? (anchors.find((i) => i > topRow) ?? anchors[0])
            : ([...anchors].reverse().find((i) => i < topRow) ??
              anchors[anchors.length - 1]);
        el.scrollTop = Math.max(0, next * LINE_HEIGHT - LINE_HEIGHT * 3);
        e.preventDefault();
        return;
      }

      if (key !== "j" && key !== "k" && key !== "v" && key !== "x" && key !== "c") return;
      if (fileRowIndices.length === 0) return;
      const topRow = Math.floor(el.scrollTop / LINE_HEIGHT);
      // The file whose section the viewport top is inside.
      let current = 0;
      for (let i = 0; i < fileRowIndices.length; i++) {
        if (fileRowIndices[i] <= topRow) current = i;
        else break;
      }
      if (key === "v" || key === "x" || key === "c") {
        const row = rows[fileRowIndices[current]];
        if (row.type === "file") {
          if (key === "c") {
            if (canAnnotate) startFileNote(row.filePath);
          } else if (key === "v") {
            onToggleViewed(row.filePath);
          } else {
            // X: transient collapse/expand — its own undo.
            setCollapsedX((cur) => {
              const next = new Set(cur);
              if (next.has(row.filePath)) next.delete(row.filePath);
              else next.add(row.filePath);
              return next;
            });
          }
        }
        e.preventDefault();
        return;
      }
      const next =
        key === "j"
          ? Math.min(current + 1, fileRowIndices.length - 1)
          : // K from mid-file goes to this file's top first, then the previous.
            el.scrollTop > fileRowIndices[current] * LINE_HEIGHT + 1
            ? current
            : Math.max(current - 1, 0);
      el.scrollTop = fileRowIndices[next] * LINE_HEIGHT;
      e.preventDefault();
    },
    [rows, fileRowIndices, onToggleViewed, live, anchorRowIndex, canAnnotate, startFileNote],
  );

  const visible: React.ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (row.type === "file") {
      const notes = fileNotesAt(row.filePath);
      visible.push(
        <FileRow
          key={i}
          row={row}
          isViewed={viewed.has(row.filePath)}
          onToggleViewed={onToggleViewed}
          noteCount={notes.length}
          onOpenNotes={
            notes.length ? () => setOpenCardId(notes[0].id) : undefined
          }
          onAddNote={canAnnotate ? startFileNote : undefined}
        />,
      );
    } else if (row.type === "hunk") {
      visible.push(<HunkRow key={i} header={row.hunk.header} row={row} />);
    } else if (row.type === "expand") {
      visible.push(<ExpandRow key={i} row={row} onExpand={onExpandContext} />);
    } else if (row.type === "line") {
      const pairing = pairs.get(`${row.fileIndex}:${row.hunkIndex}`);
      const pairedIdx = pairing?.get(row.lineIndex);
      const paired =
        pairedIdx != null
          ? files[row.fileIndex].hunks[row.hunkIndex].lines[pairedIdx]
          : undefined;
      const markers = markersAt(row.filePath, row.line);
      const rowQuestions = questionsAt(row.filePath, row.line);
      const side: "old" | "new" = row.line.kind === "del" ? "old" : "new";
      const lineHits = search?.grouped.get(
        `${row.fileIndex}:${row.hunkIndex}:${row.lineIndex}`,
      );
      visible.push(
        <LineRow
          key={i}
          filePath={row.filePath}
          line={row.line}
          paired={paired}
          matches={
            lineHits
              ? lineHits.map((m) => ({
                  start: m.start,
                  end: m.end,
                  active: m.index === search!.activeIndex,
                }))
              : null
          }
          hlTokens={tokensFor(
            highlights.get(row.filePath),
            row.fileIndex,
            row.hunkIndex,
            row.lineIndex,
            side,
          )}
          selected={lineInRange(selection, row.filePath, row.line)}
          annotated={lineAnnotated(row.filePath, row.line)}
          ringed={ringAt(row.filePath, row.line)}
          markerCount={markers.length}
          questionCount={rowQuestions.length}
          onSelectLine={canAnnotate ? handleSelectLine : undefined}
          onDragStartLine={canAnnotate ? handleDragStart : undefined}
          onDragEnterLine={canAnnotate ? handleDragEnter : undefined}
          onMarkerClick={
            markers.length ? () => setOpenCardId(markers[0].id) : undefined
          }
          onQuestionClick={
            rowQuestions.length
              ? () => setOpenQuestionId(rowQuestions[0].id)
              : undefined
          }
        />,
      );
    } else {
      const fileHl = highlights.get(row.filePath);
      const leftMarkers = row.left ? markersAt(row.filePath, row.left, "old") : [];
      const rightMarkers = row.right ? markersAt(row.filePath, row.right, "new") : [];
      const leftQuestions = row.left ? questionsAt(row.filePath, row.left, "old") : [];
      const rightQuestions = row.right ? questionsAt(row.filePath, row.right, "new") : [];
      const hitsFor = (lineIndex: number | null): MatchRange[] | null => {
        if (lineIndex == null || !search) return null;
        const hits = search.grouped.get(`${row.fileIndex}:${row.hunkIndex}:${lineIndex}`);
        return hits
          ? hits.map((m) => ({
              start: m.start,
              end: m.end,
              active: m.index === search.activeIndex,
            }))
          : null;
      };
      visible.push(
        <PairRow
          key={i}
          row={row}
          leftMatches={hitsFor(row.leftLineIndex)}
          rightMatches={hitsFor(row.rightLineIndex)}
          leftTokens={
            row.left && row.leftLineIndex != null
              ? tokensFor(fileHl, row.fileIndex, row.hunkIndex, row.leftLineIndex, "old")
              : null
          }
          rightTokens={
            row.right && row.rightLineIndex != null
              ? tokensFor(fileHl, row.fileIndex, row.hunkIndex, row.rightLineIndex, "new")
              : null
          }
          leftSelected={
            selection?.side === "old" && row.left
              ? lineInRange(selection, row.filePath, row.left)
              : false
          }
          rightSelected={
            selection?.side === "new" && row.right
              ? lineInRange(selection, row.filePath, row.right)
              : false
          }
          leftAnnotated={row.left ? lineAnnotated(row.filePath, row.left, "old") : false}
          rightAnnotated={row.right ? lineAnnotated(row.filePath, row.right, "new") : false}
          leftRinged={row.left ? ringAt(row.filePath, row.left, "old") : false}
          rightRinged={row.right ? ringAt(row.filePath, row.right, "new") : false}
          leftMarkerCount={leftMarkers.length}
          rightMarkerCount={rightMarkers.length}
          leftQuestionCount={leftQuestions.length}
          rightQuestionCount={rightQuestions.length}
          onLeftMarkerClick={
            leftMarkers.length ? () => setOpenCardId(leftMarkers[0].id) : undefined
          }
          onRightMarkerClick={
            rightMarkers.length ? () => setOpenCardId(rightMarkers[0].id) : undefined
          }
          onLeftQuestionClick={
            leftQuestions.length ? () => setOpenQuestionId(leftQuestions[0].id) : undefined
          }
          onRightQuestionClick={
            rightQuestions.length ? () => setOpenQuestionId(rightQuestions[0].id) : undefined
          }
          onSelectLine={canAnnotate ? handleSelectLine : undefined}
          onDragStartLine={canAnnotate ? handleDragStart : undefined}
          onDragEnterLine={canAnnotate ? handleDragEnter : undefined}
        />,
      );
    }
  }

  // --- floating overlays (inside the scroll content, so they scroll along) ---
  const overlays: React.ReactNode[] = [];
  const overlayAt = (idx: number, node: React.ReactNode, key: string) => {
    if (idx < 0) return;
    overlays.push(
      <div
        key={key}
        style={{
          position: "absolute",
          top: (idx + 1) * LINE_HEIGHT,
          left: 96,
          right: 16,
          maxWidth: 640,
          zIndex: 5,
        }}
      >
        {node}
      </div>,
    );
  };

  if (selection && !composerId) {
    // Anchor to the range end; fall back to the range start, then to the
    // viewport top — the menu must never silently fail to render.
    let menuIdx = anchorRowIndex(selection.filePath, selection.side, selection.endLine);
    if (menuIdx < 0) {
      menuIdx = anchorRowIndex(selection.filePath, selection.side, selection.startLine);
    }
    if (menuIdx < 0) menuIdx = Math.floor(scrollTop / LINE_HEIGHT) + 1;
    const rangeHint =
      selection.startLine === selection.endLine
        ? `L${selection.startLine}`
        : `L${selection.startLine}–${selection.endLine}`;
    overlayAt(
      menuIdx,
      <div className="rl-review-menu" role="menu" aria-label="Annotate selection">
        <span className="rl-review-menu-hint">
          {rangeHint}
          {selection.side === "old" ? " (old)" : ""}
        </span>
        <button type="button" className="rl-review-btn" onClick={() => startAnnotation("comment")}>
          💬 Comment
        </button>
        <button type="button" className="rl-review-btn" onClick={() => startAnnotation("deletion")}>
          ⌫ Mark deletion
        </button>
        <button type="button" className="rl-review-btn" onClick={() => startAnnotation("suggestion")}>
          ✎ Suggest
        </button>
        {onAddQuestion && (
          <button
            type="button"
            className="rl-review-btn"
            title="Ask the AI about these lines — a private question, not review feedback"
            onClick={startQuestion}
          >
            ✦ Ask AI
          </button>
        )}
        <button
          type="button"
          className="rl-review-btn"
          aria-label="Clear selection"
          onClick={() => setSelection(null)}
        >
          ✕
        </button>
      </div>,
      "menu",
    );
  }

  // Where an annotation's card/composer hangs: its range end for line scope,
  // the file header row for file scope. General notes never overlay the diff
  // (the panel's strip owns them).
  const overlayAnchor = (a: ReviewAnnotation): number => {
    if (a.scope === "general") return -1;
    if (a.scope === "file") return fileHeaderIndex(rows, a.filePath);
    return anchorRowIndex(a.filePath, a.side, a.endLine);
  };

  const composing = composerId ? annotations.find((a) => a.id === composerId) : undefined;
  if (composing && composing.scope !== "general") {
    overlayAt(
      overlayAnchor(composing),
      <ReviewAnnotationComposer
        annotation={composing}
        onChange={onUpdateAnnotation}
        onDone={() => setComposerId(null)}
        onDiscard={() => {
          onDeleteAnnotation(composing.id);
          setComposerId(null);
        }}
      />,
      `composer-${composing.id}`,
    );
  }

  const open = openCardId ? annotations.find((a) => a.id === openCardId) : undefined;
  if (open && !composing && open.scope !== "general") {
    const siblings = live.filter(
      (a) =>
        a.scope === open.scope &&
        a.filePath === open.filePath &&
        (open.scope === "file" ||
          (a.side === open.side && a.startLine === open.startLine)),
    );
    overlayAt(
      overlayAnchor(open),
      <div className="rl-review-ring">
        <ReviewAnnotationCard
          annotations={siblings.length ? siblings : [open]}
          onEdit={(a) => {
            setOpenCardId(null);
            setComposerId(a.id);
          }}
          onDelete={(id) => {
            onDeleteAnnotation(id);
            setOpenCardId(null);
          }}
          onClose={() => setOpenCardId(null)}
        />
      </div>,
      `card-${open.id}`,
    );
  }

  // Ask-AI question thread card — anchored like an annotation card, but a
  // private consultation (never in the payload).
  const openQuestion =
    openQuestionId && questions
      ? questions.find((q) => q.id === openQuestionId)
      : undefined;
  if (openQuestion && !composing && !open) {
    let qIdx = anchorRowIndex(
      openQuestion.filePath,
      openQuestion.side,
      openQuestion.endLine,
    );
    if (qIdx < 0) qIdx = Math.floor(scrollTop / LINE_HEIGHT) + 1;
    overlayAt(
      qIdx,
      <div className="rl-review-card" role="dialog" aria-label="Ask AI">
        <div className="rl-review-card-head">
          <span style={{ fontWeight: 600 }}>✦ Ask AI</span>
          <span style={{ color: "var(--color-ink-muted)" }}>
            {openQuestion.filePath}:{openQuestion.side} L{openQuestion.startLine}
            {openQuestion.endLine !== openQuestion.startLine
              ? `–${openQuestion.endLine}`
              : ""}
          </span>
        </div>
        {openQuestion.quotedText && (
          <pre className="rl-review-card-quote">{openQuestion.quotedText}</pre>
        )}
        {reviewId && (
          <ReviewThread
            reviewId={reviewId}
            annotationId={openQuestion.id}
            kind="question"
          />
        )}
        <div className="rl-review-card-actions">
          <button
            type="button"
            className="rl-review-btn"
            onClick={() => {
              onDeleteQuestion?.(openQuestion.id);
              setOpenQuestionId(null);
            }}
          >
            Delete
          </button>
          <button
            type="button"
            className="rl-review-btn"
            onClick={() => setOpenQuestionId(null)}
          >
            Close
          </button>
        </div>
      </div>,
      `question-${openQuestion.id}`,
    );
  }

  // Sticky file pin: the file whose section contains the viewport top,
  // shown once its own header row has scrolled past. Binary search — O(log
  // files) per scroll frame.
  let pinRow: Extract<ReviewRow, { type: "file" }> | null = null;
  {
    const topRow = scrollTop / LINE_HEIGHT;
    let lo = 0;
    let hi = fileRowIndices.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fileRowIndices[mid] < topRow) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found >= 0) {
      const r = rows[fileRowIndices[found]];
      if (r?.type === "file") pinRow = r;
    }
  }

  return (
    <div className="flex-1 relative flex flex-col" style={{ minHeight: 0 }}>
      {pinRow && (
        <FilePin
          row={pinRow}
          stats={fileStats.get(pinRow.filePath)}
          isViewed={viewed.has(pinRow.filePath)}
          onToggleViewed={onToggleViewed}
        />
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onKeyDown={handleKeyDown}
        onMouseUp={handleTextSelectionRelease}
        tabIndex={0}
        className="flex-1 overflow-auto rl-diff-view rl-review-scroll"
        style={{ outline: "none" }}
        aria-label="Diff (J/K next/previous file, V mark viewed)"
      >
        <div style={{ height: rows.length * LINE_HEIGHT, position: "relative" }}>
          <div
            style={{
              position: "absolute",
              top: start * LINE_HEIGHT,
              left: 0,
              right: 0,
            }}
          >
            {visible}
          </div>
          {overlays}
        </div>
      </div>
      {thumb && (
        <div
          className="rl-diff-scrollbar"
          role="scrollbar"
          aria-orientation="vertical"
          aria-label="Scroll the diff"
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={endThumbDrag}
          onPointerCancel={endThumbDrag}
        >
          <div
            className="rl-diff-scrollbar-thumb"
            style={{ height: thumb.thumbH, transform: `translateY(${thumb.top}px)` }}
          />
        </div>
      )}
    </div>
  );
});

export default DiffView;

/** Split a display path into a dimmed directory and a bold filename. */
function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0
    ? { dir: "", name: path }
    : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

const STATUS_LETTER: Record<DiffFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  binary: "B",
};

/** The pinned (sticky) rich file header floating over the scroll viewport. */
const FilePin = memo(function FilePin({
  row,
  stats,
  isViewed,
  onToggleViewed,
}: {
  row: Extract<ReviewRow, { type: "file" }>;
  stats: { adds: number; dels: number } | undefined;
  isViewed: boolean;
  onToggleViewed: (filePath: string) => void;
}) {
  const { file, filePath } = row;
  const { dir, name } = splitPath(filePath);
  return (
    <div className="rl-review-file-pin" aria-hidden={false}>
      <span className="rl-review-pin-status" data-status={file.status}>
        {STATUS_LETTER[file.status]}
      </span>
      <span className="truncate" style={{ minWidth: 0 }}>
        {file.status === "renamed" ? (
          <span>
            <span style={{ color: "var(--color-ink-muted)" }}>{file.oldPath}</span>
            {" → "}
            <b>{file.newPath}</b>
          </span>
        ) : (
          <span>
            <span style={{ color: "var(--color-ink-muted)" }}>{dir}</span>
            <b>{name}</b>
          </span>
        )}
      </span>
      {stats && (
        <span className="rl-review-pin-counts">
          <span style={{ color: "var(--color-success)" }}>+{stats.adds}</span>{" "}
          <span style={{ color: "var(--color-warning)" }}>−{stats.dels}</span>
        </span>
      )}
      <label
        className="flex items-center gap-1 ml-auto"
        style={{ fontWeight: 400, fontSize: "11px", color: "var(--color-ink-muted)", cursor: "pointer" }}
      >
        <input
          type="checkbox"
          checked={isViewed}
          onChange={() => onToggleViewed(filePath)}
          style={{ accentColor: "var(--color-anchor-text)" }}
        />
        Viewed
      </label>
    </div>
  );
});

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  binary: "binary",
};

const FileRow = memo(function FileRow({
  row,
  isViewed,
  onToggleViewed,
  noteCount,
  onOpenNotes,
  onAddNote,
}: {
  row: Extract<ReviewRow, { type: "file" }>;
  isViewed: boolean;
  onToggleViewed: (filePath: string) => void;
  /** Whole-file notes on this file. */
  noteCount: number;
  onOpenNotes?: () => void;
  onAddNote?: (filePath: string) => void;
}) {
  const { file, filePath } = row;
  const renamed = file.status === "renamed";
  return (
    <div
      className="flex items-center gap-2 px-3"
      style={{
        height: LINE_HEIGHT,
        lineHeight: `${LINE_HEIGHT}px`,
        fontFamily: MONO,
        fontSize: "12px",
        fontWeight: 600,
        background: "var(--color-bg-elevated)",
        borderTop: "1px solid var(--color-rule)",
        borderBottom: "1px solid var(--color-rule)",
        color: "var(--color-ink)",
      }}
    >
      <span
        className="rl-diff-status"
        data-status={file.status}
        style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase" }}
      >
        {STATUS_LABEL[file.status]}
      </span>
      <span className="truncate" style={{ minWidth: 0 }}>
        {renamed ? (
          <span>
            <span style={{ color: "var(--color-ink-muted)", fontWeight: 400 }}>
              {file.oldPath}
              {" → "}
            </span>
            {file.newPath}
          </span>
        ) : (
          <span>
            <span style={{ color: "var(--color-ink-muted)", fontWeight: 400 }}>
              {splitPath(filePath).dir}
            </span>
            {splitPath(filePath).name}
          </span>
        )}
      </span>
      {file.binary && (
        <span style={{ color: "var(--color-ink-muted)", fontWeight: 400 }}>
          (binary — no preview)
        </span>
      )}
      {noteCount > 0 && (
        <button
          type="button"
          className="rl-diff-marker"
          title={`${noteCount} file ${noteCount === 1 ? "note" : "notes"}`}
          aria-label={`${noteCount} file notes`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenNotes?.();
          }}
        >
          💬{noteCount}
        </button>
      )}
      {onAddNote && (
        <button
          type="button"
          className="rl-review-btn"
          style={{ fontSize: "10.5px", padding: "1px 6px", minHeight: 0, fontWeight: 400 }}
          title="Comment on this file as a whole (C)"
          onClick={(e) => {
            e.stopPropagation();
            onAddNote(filePath);
          }}
        >
          + Note
        </button>
      )}
      <label
        className="flex items-center gap-1 ml-auto"
        style={{ fontWeight: 400, fontSize: "11px", color: "var(--color-ink-muted)", cursor: "pointer" }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={isViewed}
          onChange={() => onToggleViewed(filePath)}
          style={{ accentColor: "var(--color-anchor-text)" }}
        />
        Viewed
      </label>
    </div>
  );
});

const HunkRow = memo(function HunkRow({
  header,
  row,
}: {
  header: string;
  row: Extract<ReviewRow, { type: "hunk" }>;
}) {
  const { hunk } = row;
  return (
    <div
      className="px-3"
      style={{
        height: LINE_HEIGHT,
        lineHeight: `${LINE_HEIGHT}px`,
        fontFamily: MONO,
        fontSize: "11.5px",
        color: "var(--color-ink-muted)",
        background: "color-mix(in srgb, var(--color-anchor-bg) 55%, transparent)",
        whiteSpace: "pre",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${header ? ` ${header}` : ""}`}
    </div>
  );
});

/** An unchanged-lines expander (top / between hunks / bottom). Click reveals
 *  `EXPAND_STEP` lines; ⌥-click reveals the whole gap. */
const ExpandRow = memo(function ExpandRow({
  row,
  onExpand,
}: {
  row: Extract<ReviewRow, { type: "expand" }>;
  onExpand?: (filePath: string, slot: ExpandSlot, all: boolean) => void;
}) {
  const { slot } = row;
  const label =
    slot.gap != null
      ? `expand ${Math.min(EXPAND_STEP, slot.gap)} of ${slot.gap} unchanged ${slot.gap === 1 ? "line" : "lines"}`
      : "expand below";
  return (
    <div className="rl-diff-expand" style={{ height: LINE_HEIGHT }}>
      <button
        type="button"
        onClick={(e) => onExpand?.(row.filePath, slot, e.altKey)}
        title="Click: reveal 20 lines · ⌥-click: reveal all"
      >
        {slot.edge === "up" ? "⇡" : "⇣"} {label}
      </button>
    </div>
  );
});

/** Gutter width holds five digits — files past 99,999 lines wrap ugly rather
 *  than break the fixed row height. */
const GUTTER_W = 44;

type SelectLineFn = (
  filePath: string,
  line: DiffLine,
  shift: boolean,
  side?: "old" | "new",
) => void;

type DragStartFn = (filePath: string, line: DiffLine, side?: "old" | "new") => void;
type DragEnterFn = (filePath: string, line: DiffLine) => void;

/** Render composed spans (syntax × word-diff × search) as classed <span>s. */
function renderSpans(spans: ReturnType<typeof composeLineSpans>): React.ReactNode {
  return spans.map((s, i) => {
    const cls = [
      s.cls,
      s.word && (s.word === "add" ? "rl-diff-word-add" : "rl-diff-word-del"),
      s.match &&
        (s.match === "active"
          ? "rl-search-match rl-search-match--active"
          : "rl-search-match"),
    ]
      .filter(Boolean)
      .join(" ");
    return cls ? (
      <span key={i} className={cls}>
        {s.text}
      </span>
    ) : (
      <span key={i}>{s.text}</span>
    );
  });
}

const LineRow = memo(function LineRow({
  filePath,
  line,
  paired,
  hlTokens,
  matches,
  selected,
  annotated,
  ringed,
  markerCount,
  questionCount = 0,
  onSelectLine,
  onDragStartLine,
  onDragEnterLine,
  onMarkerClick,
  onQuestionClick,
}: {
  filePath: string;
  line: DiffLine;
  /** The del/add partner line when this line is half of a change pair —
   *  enables word-level tint. */
  paired: DiffLine | undefined;
  /** Syntax tokens for this line (null = plain). */
  hlTokens: HlToken[] | null;
  /** Search hits on this line (null = none). */
  matches: MatchRange[] | null;
  selected: boolean;
  annotated: boolean;
  /** In the open annotation card's range — binds card ↔ lines visually. */
  ringed: boolean;
  markerCount: number;
  /** Ask-AI questions anchored here (✦; annotations' 💬 takes the column). */
  questionCount?: number;
  onSelectLine?: SelectLineFn;
  /** Gutter/sign/+ mousedown anchors a multi-line drag. */
  onDragStartLine?: DragStartFn;
  /** Rows entered while a drag is live extend the range. */
  onDragEnterLine?: DragEnterFn;
  onMarkerClick?: () => void;
  onQuestionClick?: () => void;
}) {
  const changed = line.kind !== "context";
  const rowClass = [
    "rl-diff-row",
    line.kind === "add" ? "rl-diff-add" : line.kind === "del" ? "rl-diff-del" : "",
    selected ? "rl-diff-selected" : "",
    annotated ? "rl-diff-annotated" : "",
    ringed ? "rl-diff-ring-row" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";

  // Word-diff on paired change lines, composed with the syntax layer.
  const spans = useMemo(() => {
    let word: { spans: WordSpan[]; kind: "add" | "del" } | null = null;
    if (paired) {
      const { del, add } =
        line.kind === "del"
          ? wordDiff(line.text, paired.text)
          : wordDiff(paired.text, line.text);
      word =
        line.kind === "del"
          ? { spans: del, kind: "del" }
          : { spans: add, kind: "add" };
    }
    return composeLineSpans(line.text, hlTokens, word, matches ?? []);
  }, [line, paired, hlTokens, matches]);

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.shiftKey || !onDragStartLine) return;
    // Block the browser starting a native text selection from the gutter,
    // so the drag reads as a clean line-range sweep.
    e.preventDefault();
    onDragStartLine(filePath, line);
  };
  return (
    <div
      className={`flex ${rowClass}`}
      data-path={filePath}
      data-old={line.oldLine ?? undefined}
      data-new={line.newLine ?? undefined}
      style={{
        position: "relative",
        height: LINE_HEIGHT,
        lineHeight: `${LINE_HEIGHT}px`,
        fontFamily: MONO,
        fontSize: "12.5px",
        whiteSpace: "pre",
      }}
      onClick={(e) => onSelectLine?.(filePath, line, e.shiftKey)}
      onMouseEnter={onDragEnterLine ? () => onDragEnterLine(filePath, line) : undefined}
    >
      {/* Gutters keep the selectable affordance; the whole row is the click
          surface (the handler skips clicks that end a text drag-select), and
          a press-and-drag from the gutter/sign sweeps a multi-line range. */}
      <span
        className="rl-diff-gutter"
        data-selectable={onSelectLine ? "" : undefined}
        style={{ width: GUTTER_W }}
        onMouseDown={startDrag}
      >
        {line.oldLine ?? ""}
      </span>
      <span
        className="rl-diff-gutter"
        data-selectable={onSelectLine ? "" : undefined}
        style={{ width: GUTTER_W }}
        onMouseDown={startDrag}
      >
        {line.newLine ?? ""}
      </span>
      <span
        style={{
          width: 18,
          textAlign: "center",
          flexShrink: 0,
          color: changed ? "inherit" : "var(--color-ink-muted)",
          userSelect: "none",
        }}
        onMouseDown={startDrag}
      >
        {markerCount > 0 ? (
          <button
            type="button"
            className="rl-diff-marker"
            title={`${markerCount} annotation${markerCount === 1 ? "" : "s"}`}
            aria-label={`${markerCount} annotation${markerCount === 1 ? "" : "s"}`}
            onClick={(e) => {
              e.stopPropagation();
              onMarkerClick?.();
            }}
          >
            💬
          </button>
        ) : questionCount > 0 ? (
          <button
            type="button"
            className="rl-diff-marker rl-diff-marker-question"
            title={`${questionCount} Ask-AI question${questionCount === 1 ? "" : "s"}`}
            aria-label={`${questionCount} Ask-AI question${questionCount === 1 ? "" : "s"}`}
            onClick={(e) => {
              e.stopPropagation();
              onQuestionClick?.();
            }}
          >
            ✦
          </button>
        ) : (
          sign
        )}
      </span>
      {/* Hover affordance: the + invites annotation (GitHub gesture). Pure
          CSS reveal — always rendered, zero re-render cost, row height
          untouched. Hidden when a marker already occupies the column. */}
      {onSelectLine && markerCount === 0 && questionCount === 0 && (
        <button
          type="button"
          className="rl-diff-plus"
          title="Annotate this line — drag or shift-click to select more"
          aria-label="Annotate this line"
          tabIndex={-1}
          onMouseDown={startDrag}
          onClick={(e) => {
            e.stopPropagation();
            onSelectLine(filePath, line, e.shiftKey);
          }}
        >
          +
        </button>
      )}
      <span style={{ flex: 1, overflow: "hidden" }}>{renderSpans(spans)}</span>
    </div>
  );
});

/** One split-view cell: [gutter | sign/marker | text] for one side. `line`
 *  null = the other side has no partner here (hatched filler). */
function PairCell({
  side,
  filePath,
  line,
  tokens,
  wordSpans,
  matches,
  selected,
  annotated,
  ringed,
  markerCount,
  questionCount = 0,
  onMarkerClick,
  onQuestionClick,
  onSelectLine,
  onDragStartLine,
  onDragEnterLine,
  divider,
}: {
  side: "old" | "new";
  filePath: string;
  line: DiffLine | null;
  tokens: HlToken[] | null;
  wordSpans: WordSpan[] | null;
  matches: MatchRange[] | null;
  selected: boolean;
  annotated: boolean;
  ringed: boolean;
  markerCount: number;
  questionCount?: number;
  onMarkerClick?: () => void;
  onQuestionClick?: () => void;
  onSelectLine?: SelectLineFn;
  onDragStartLine?: DragStartFn;
  onDragEnterLine?: DragEnterFn;
  divider?: boolean;
}) {
  const cellClass = [
    "rl-diff-cell",
    line
      ? line.kind === "add"
        ? "rl-diff-add"
        : line.kind === "del"
          ? "rl-diff-del"
          : ""
      : "rl-diff-empty",
    selected ? "rl-diff-selected" : "",
    annotated ? "rl-diff-annotated" : "",
    ringed ? "rl-diff-ring-row" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const spans = useMemo(() => {
    if (!line) return [];
    const word = wordSpans
      ? { spans: wordSpans, kind: (side === "old" ? "del" : "add") as "del" | "add" }
      : null;
    return composeLineSpans(line.text, tokens, word, matches ?? []);
  }, [line, tokens, wordSpans, matches, side]);

  const sign = !line ? " " : line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.shiftKey || !line || !onDragStartLine) return;
    e.preventDefault();
    onDragStartLine(filePath, line, side);
  };
  return (
    <div
      className={`flex ${cellClass}`}
      data-path={line ? filePath : undefined}
      data-cell-side={side}
      data-old={line?.oldLine ?? undefined}
      data-new={line?.newLine ?? undefined}
      style={{
        width: "50%",
        position: "relative",
        overflow: "hidden",
        borderLeft: divider ? "1px solid var(--color-rule)" : undefined,
      }}
      onClick={
        line && onSelectLine
          ? (e) => onSelectLine(filePath, line, e.shiftKey, side)
          : undefined
      }
      onMouseEnter={
        line && onDragEnterLine ? () => onDragEnterLine(filePath, line) : undefined
      }
    >
      <span
        className="rl-diff-gutter"
        data-selectable={line && onSelectLine ? "" : undefined}
        style={{ width: GUTTER_W }}
        onMouseDown={startDrag}
      >
        {line ? ((side === "old" ? line.oldLine : line.newLine) ?? "") : ""}
      </span>
      <span
        style={{
          width: 18,
          textAlign: "center",
          flexShrink: 0,
          color: line && line.kind !== "context" ? "inherit" : "var(--color-ink-muted)",
          userSelect: "none",
        }}
        onMouseDown={startDrag}
      >
        {markerCount > 0 ? (
          <button
            type="button"
            className="rl-diff-marker"
            title={`${markerCount} annotation${markerCount === 1 ? "" : "s"}`}
            aria-label={`${markerCount} annotation${markerCount === 1 ? "" : "s"}`}
            onClick={(e) => {
              e.stopPropagation();
              onMarkerClick?.();
            }}
          >
            💬
          </button>
        ) : questionCount > 0 ? (
          <button
            type="button"
            className="rl-diff-marker rl-diff-marker-question"
            title={`${questionCount} Ask-AI question${questionCount === 1 ? "" : "s"}`}
            aria-label={`${questionCount} Ask-AI question${questionCount === 1 ? "" : "s"}`}
            onClick={(e) => {
              e.stopPropagation();
              onQuestionClick?.();
            }}
          >
            ✦
          </button>
        ) : (
          sign
        )}
      </span>
      {line && onSelectLine && markerCount === 0 && questionCount === 0 && (
        <button
          type="button"
          className="rl-diff-plus"
          style={{ left: GUTTER_W }}
          title="Annotate this line — drag or shift-click to select more"
          aria-label="Annotate this line"
          tabIndex={-1}
          onMouseDown={startDrag}
          onClick={(e) => {
            e.stopPropagation();
            onSelectLine(filePath, line, e.shiftKey, side);
          }}
        >
          +
        </button>
      )}
      <span style={{ flex: 1, overflow: "hidden" }}>{renderSpans(spans)}</span>
    </div>
  );
}

const PairRow = memo(function PairRow({
  row,
  leftTokens,
  rightTokens,
  leftMatches,
  rightMatches,
  leftSelected,
  rightSelected,
  leftAnnotated,
  rightAnnotated,
  leftRinged,
  rightRinged,
  leftMarkerCount,
  rightMarkerCount,
  leftQuestionCount = 0,
  rightQuestionCount = 0,
  onLeftMarkerClick,
  onRightMarkerClick,
  onLeftQuestionClick,
  onRightQuestionClick,
  onSelectLine,
  onDragStartLine,
  onDragEnterLine,
}: {
  row: Extract<ReviewRow, { type: "pair" }>;
  leftTokens: HlToken[] | null;
  rightTokens: HlToken[] | null;
  leftMatches: MatchRange[] | null;
  rightMatches: MatchRange[] | null;
  leftSelected: boolean;
  rightSelected: boolean;
  leftAnnotated: boolean;
  rightAnnotated: boolean;
  leftRinged: boolean;
  rightRinged: boolean;
  leftMarkerCount: number;
  rightMarkerCount: number;
  leftQuestionCount?: number;
  rightQuestionCount?: number;
  onLeftMarkerClick?: () => void;
  onRightMarkerClick?: () => void;
  onLeftQuestionClick?: () => void;
  onRightQuestionClick?: () => void;
  onSelectLine?: SelectLineFn;
  onDragStartLine?: DragStartFn;
  onDragEnterLine?: DragEnterFn;
}) {
  const { left, right, filePath } = row;

  // A del/add pair is the word-diff input; context mirrors carry no tint.
  const word = useMemo(() => {
    if (left && right && left.kind === "del" && right.kind === "add") {
      return wordDiff(left.text, right.text);
    }
    return null;
  }, [left, right]);

  return (
    <div
      className="flex rl-diff-row"
      style={{
        height: LINE_HEIGHT,
        lineHeight: `${LINE_HEIGHT}px`,
        fontFamily: MONO,
        fontSize: "12.5px",
        whiteSpace: "pre",
      }}
    >
      <PairCell
        side="old"
        filePath={filePath}
        line={left}
        tokens={leftTokens}
        wordSpans={word?.del ?? null}
        matches={leftMatches}
        selected={leftSelected}
        annotated={leftAnnotated}
        ringed={leftRinged}
        markerCount={leftMarkerCount}
        questionCount={leftQuestionCount}
        onMarkerClick={onLeftMarkerClick}
        onQuestionClick={onLeftQuestionClick}
        onSelectLine={onSelectLine}
        onDragStartLine={onDragStartLine}
        onDragEnterLine={onDragEnterLine}
      />
      <PairCell
        side="new"
        filePath={filePath}
        line={right}
        tokens={rightTokens}
        wordSpans={word?.add ?? null}
        matches={rightMatches}
        selected={rightSelected}
        annotated={rightAnnotated}
        ringed={rightRinged}
        markerCount={rightMarkerCount}
        questionCount={rightQuestionCount}
        onMarkerClick={onRightMarkerClick}
        onQuestionClick={onRightQuestionClick}
        onSelectLine={onSelectLine}
        onDragStartLine={onDragStartLine}
        onDragEnterLine={onDragEnterLine}
        divider
      />
    </div>
  );
});
