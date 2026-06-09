// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { DocLine, DocMeta, DocOpen } from "../types";
import { useLiveFile } from "../hooks/useFsWatch";
import { visibleRange, chunksForRange } from "../lib/virtual";

// Read-only source viewer. Normal-sized files arrive whole from `open_doc` (one
// round-trip, `inlineLines` set) and paint instantly; genuinely huge files come
// back without inline lines and are paged per scroll-window via `doc_lines`
// (syntect runs off the UI thread, cached by path+mtime) so a 57k-line file never
// freezes the app. Either way only the visible rows are ever in the DOM.
const LINE_HEIGHT = 18; // px; must match the line styling below.
const CHUNK = 300; // lines fetched per request (paged path only).
const OVERSCAN = 60; // extra lines rendered/fetched above & below the viewport.

// Fallback viewport height used for the very first window, before the scroll
// container has been measured — so content paints immediately instead of waiting
// a frame for the ResizeObserver. Refined to the real height once measured.
const DEFAULT_VIEWPORT_H = 800;

// Don't flash any loading affordance for loads faster than this; near-all normal
// files resolve well under it, so opening one shows no notice at all.
const LOADING_DELAY_MS = 120;

// Below this size an unhighlighted file is just an ordinary plain-text file (no
// grammar); at or above it, "not highlighted" means we turned coloring off for
// performance — only then is the notice worth showing.
const HIGHLIGHT_NOTICE_BYTES = 1024 * 1024;

interface CodeViewProps {
  /** Absolute path of the file to display. */
  path: string;
}

/** The currently-displayed document. `inlineLines` is present for normal-sized
 *  files (render straight from it); absent for paged (huge) files, which pull
 *  windows into `chunks`. `path` records which file this is, so a stale async
 *  resolution from a file we've navigated away from is easy to ignore. */
interface LoadedDoc {
  path: string;
  meta: DocMeta;
  inlineLines?: DocLine[];
  /** True once `inlineLines` hold the highlighted (colored) version, so we don't
   *  request highlighting again. */
  highlighted?: boolean;
}

export default function CodeView({ path }: CodeViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Paged windows, keyed by chunk index (lineIndex / CHUNK). Only used when the
  // displayed doc has no `inlineLines`.
  const [chunks, setChunks] = useState<Map<number, DocLine[]>>(new Map());
  const requested = useRef<Set<number>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  // Armed on a file switch; shows a neutral "Loading…" only if the new file is
  // still not ready after LOADING_DELAY_MS (so fast opens never flash it).
  const [showLoading, setShowLoading] = useState(false);
  // The most recently requested path — guards against a slow `open_doc` for a
  // file the user already navigated away from clobbering the current one.
  const latestPath = useRef(path);

  // A new path is stale-while-revalidate: keep the prior file's content on screen
  // and only swap when the new file resolves. We deliberately do NOT blank `doc`
  // here — that blank-then-pop is exactly the regression we're removing.
  useEffect(() => {
    latestPath.current = path;
    setError(null);
  }, [path]);

  // (Re)load the file. On success, swap in the new doc (ignoring stale resolves)
  // and reset the paged caches. Used for both initial open and live reload.
  const reload = useCallback(() => {
    let cancelled = false;
    void invoke<DocOpen>("open_doc", { path })
      .then((d) => {
        if (cancelled || latestPath.current !== path) return;
        setDoc({ path, meta: d.meta, inlineLines: d.lines });
        setChunks(new Map());
        requested.current = new Set();
        setError(null);
      })
      .catch((e) => {
        if (!cancelled && latestPath.current === path) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => reload(), [reload]);
  useLiveFile(path, reload);

  // Whether the displayed doc is the current file (fresh) vs. a held-over prior
  // file during a switch (stale).
  const fresh = !!doc && doc.path === path;

  // The window math runs off the displayed `doc` (not a nulled-out view) so the
  // scroll container stays mounted and chunk-fetching/measuring keep working even
  // while a loading overlay is up — otherwise the first paged window could never
  // load. A fallback height fills the first window before the container is
  // measured.
  const lineCount = doc?.meta.lineCount ?? 0;
  const { start, end } = visibleRange(
    scrollTop,
    viewportH || DEFAULT_VIEWPORT_H,
    lineCount,
    LINE_HEIGHT,
    OVERSCAN,
  );

  // Is the current file's *visible* content ready to paint? Inline docs are ready
  // the instant they arrive; a paged (huge) doc isn't ready until its first
  // visible chunk has been fetched + tokenized — that wait is what needs an
  // indicator. Notices (too-large/binary) and empty docs count as ready.
  const firstVisibleChunk = Math.floor(start / CHUNK);
  const currentReady =
    fresh &&
    !!doc &&
    (!!doc.inlineLines ||
      doc.meta.tooLarge ||
      doc.meta.isBinary ||
      lineCount === 0 ||
      chunks.has(firstVisibleChunk));
  const waiting = !currentReady;

  // Arm the delayed loading indicator whenever the current file isn't ready yet —
  // covers both a slow `open_doc` and a paged doc's first-window tokenize. Fast
  // (inline) opens flip ready before the timer fires, so it never shows for them.
  useEffect(() => {
    if (!waiting) {
      setShowLoading(false);
      return;
    }
    setShowLoading(false);
    const t = setTimeout(() => setShowLoading(true), LOADING_DELAY_MS);
    return () => clearTimeout(t);
  }, [waiting]);

  // New file → start at the top (a live reload of the same file keeps position).
  useLayoutEffect(() => {
    setScrollTop(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [doc?.path]);

  // A body (scroll container) is rendered for any non-notice doc; the measure
  // effect re-runs when that flips so it always observes the live element.
  const rendersBody = !!doc && !(fresh && (doc.meta.tooLarge || doc.meta.isBinary));

  // Measure the scroll viewport so the window math knows how many lines fit.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rendersBody]);

  // Coalesce scroll events to one state update per frame.
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

  // Paged docs only: fetch the chunks the visible window needs. Gated on `fresh`
  // so we never fetch for a file we've navigated away from. (Inline docs already
  // hold every line, so this is a no-op for them.)
  const pagedPath =
    fresh && doc && !doc.inlineLines && !doc.meta.tooLarge && !doc.meta.isBinary
      ? doc.path
      : null;
  useEffect(() => {
    if (!pagedPath || lineCount === 0) return;
    const needed = chunksForRange(start, end, CHUNK).filter(
      (c) => !chunks.has(c) && !requested.current.has(c),
    );
    if (needed.length === 0) return;
    for (const c of needed) {
      requested.current.add(c);
      const from = c * CHUNK;
      void invoke<DocLine[]>("doc_lines", { path: pagedPath, start: from, end: from + CHUNK })
        .then((lines) => {
          setChunks((prev) => {
            const next = new Map(prev);
            next.set(c, lines);
            return next;
          });
        })
        .catch(() => {
          // Allow a later pass to retry this chunk.
          requested.current.delete(c);
        });
    }
  }, [pagedPath, lineCount, start, end, chunks]);

  // Progressive highlight: an inline doc paints plain instantly (above); once
  // it's on screen, fetch tokens and swap them in. Instant when the grammar is
  // already warmed, a beat later on the first cold open of a language — but it
  // NEVER blocks first paint, so a small file is never gated on tokenization.
  useEffect(() => {
    if (!fresh || !doc || !doc.inlineLines || doc.highlighted || !doc.meta.highlightable) {
      return;
    }
    const target = doc.path;
    let cancelled = false;
    void invoke<DocLine[] | null>("doc_highlight", { path: target })
      .then((lines) => {
        if (cancelled || latestPath.current !== target || !lines) return;
        setDoc((d) =>
          d && d.path === target && d.inlineLines
            ? { ...d, inlineLines: lines, highlighted: true }
            : d,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fresh, doc]);

  // Nothing to show yet (very first open, before any doc resolves). Hold blank
  // until the short delay elapses, then a neutral "Loading…" — never a size-based
  // or "large file" message (we don't yet know the size).
  if (!doc) {
    if (showLoading) {
      return <Notice>{error ? "Couldn’t read this file." : "Loading…"}</Notice>;
    }
    if (error) return <Notice>Couldn’t read this file.</Notice>;
    return <div className="h-full w-full" style={{ background: "var(--color-paper)" }} />;
  }

  // Size/binary notices reflect the *current* file only (not a stale held-over).
  if (fresh && doc.meta.tooLarge) {
    return (
      <Notice>File is too large to preview ({Math.round(doc.meta.size / 1024 / 1024)} MB).</Notice>
    );
  }
  if (fresh && doc.meta.isBinary) return <Notice>Binary file — no preview.</Notice>;

  const showNotice = fresh && !doc.meta.highlightable && doc.meta.size >= HIGHLIGHT_NOTICE_BYTES;
  const inline = doc.inlineLines;
  const lineAt = (i: number): DocLine | undefined => {
    if (inline) return inline[i];
    const chunk = chunks.get(Math.floor(i / CHUNK));
    return chunk?.[i - Math.floor(i / CHUNK) * CHUNK];
  };

  const rows: React.ReactNode[] = [];
  for (let i = start; i < end; i++) {
    rows.push(<Line key={i} line={lineAt(i)} />);
  }

  return (
    <div className="h-full flex flex-col" style={{ position: "relative" }}>
      {showNotice && (
        <div
          className="px-6 py-2 italic shrink-0"
          style={{
            fontSize: "12px",
            color: "var(--color-ink-muted)",
            borderBottom: "1px solid var(--color-rule)",
          }}
        >
          Large file — syntax highlighting off for performance.
        </div>
      )}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto">
        <div style={{ height: lineCount * LINE_HEIGHT, position: "relative" }}>
          <pre
            className="hljs rl-code-view"
            style={{
              position: "absolute",
              top: start * LINE_HEIGHT,
              left: 0,
              right: 0,
              margin: 0,
            }}
          >
            <code>{rows}</code>
          </pre>
        </div>
      </div>
      {waiting && showLoading && (
        // Opaque overlay so a paged (huge) file shows a clean "Loading…" instead
        // of a blank scroll area while its first window tokenizes. Removed the
        // instant the first visible chunk lands. Pointer-events off so it never
        // blocks interaction.
        <div
          aria-live="polite"
          className="italic"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--color-paper)",
            color: "var(--color-ink-muted)",
            fontSize: "13px",
            pointerEvents: "none",
          }}
        >
          Loading…
        </div>
      )}
    </div>
  );
}

// One source line, rendered at a fixed height so the virtualizer's math holds.
// Highlighted lines render classed token spans; others render raw text. An
// not-yet-fetched line renders as blank space (its height is already reserved).
function Line({ line }: { line: DocLine | undefined }) {
  return (
    <div
      style={{
        height: LINE_HEIGHT,
        lineHeight: `${LINE_HEIGHT}px`,
        whiteSpace: "pre",
        fontFamily: "var(--font-mono, ui-monospace, Menlo, monospace)",
        fontSize: "12.5px",
        paddingLeft: "16px",
        paddingRight: "16px",
      }}
    >
      {line?.tokens
        ? line.tokens.map((t, i) =>
            t.c ? (
              <span key={i} className={t.c}>
                {t.t}
              </span>
            ) : (
              <span key={i}>{t.t}</span>
            ),
          )
        : (line?.text ?? "")}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="px-6 py-6 italic"
      style={{ fontSize: "13px", color: "var(--color-ink-muted)" }}
    >
      {children}
    </div>
  );
}
