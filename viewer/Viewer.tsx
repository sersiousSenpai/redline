// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * The Review Request browser viewer — how someone who never installs
 * Redline reviews a plan, and why they'll want to.
 *
 * The encrypted snapshot arrives in the URL #fragment (it never reaches the
 * server hosting this page) or is pasted as a bare code. The plan renders
 * through the SAME TipTap schema/markdown parser the app uses, so `rl:blk-`
 * block identity survives; annotations are comment/suggest-only (this is a
 * fork the owner reconciles, not a live CRDT peer) and anchor by blockId +
 * character range. "Send back" signs the annotation set with the
 * per-request HMAC key embedded in the snapshot.
 *
 * Beyond reading, the viewer surfaces the plan's DEPTH carried in the enriched
 * payload — a revision timeline, prior discussion, resolved decisions, and
 * stats — and lets the reader re-theme the whole page from Redline's own
 * design system. The whole point: it should read as a rich slice of the real
 * product, and make "Open in Redline" irresistible.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";

import { planExtensions } from "../src/editor/extensions/planExtensions";
import {
  CommentHighlights,
  type CommentHighlightRange,
} from "../src/editor/extensions/CommentHighlights";
import { planMarkdownToDoc } from "../src/editor/markdown";
import { decodeSnapshot, type SnapshotPayload } from "../src/collab/snapshot";
import {
  signReturn,
  type ReturnComment,
  type ReturnPayload,
} from "../src/collab/returnBlob";
import type { CommentSelection } from "../src/types";
import {
  applyTheme,
  applyFont,
  readStoredTheme,
  readStoredFont,
  storeTheme,
  storeFont,
} from "../src/theme/applyTheme";
import { THEMES, type ThemeName } from "../src/theme/themes";
import { FONTS, type FontName } from "../src/theme/fonts";

/* ───────────────────────────  small utilities  ─────────────────────────── */

/** "2 days ago" / "in 3 hours" — compact, human relative time. */
function relTime(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  const fmt = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"}`;
  let label: string;
  if (abs < min) label = "moments";
  else if (abs < hr) label = fmt(Math.round(abs / min), "min");
  else if (abs < day) label = fmt(Math.round(abs / hr), "hour");
  else if (abs < 30 * day) label = fmt(Math.round(abs / day), "day");
  else label = fmt(Math.round(abs / (30 * day)), "month");
  return diff < 0 ? `${label} ago` : `in ${label}`;
}

/** Up-to-two-letter monogram from a name. */
function monogram(name?: string): string {
  if (!name) return "·";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Decode failures are almost never "bad token" — they're the browser
 *  environment. Name the actual blocker so the reviewer can act on it. */
function explainDecodeFailure(raw: string): string {
  const token = raw.replace(/\s+/g, "").replace(/^.*#/, "");
  if (!token.startsWith("RLS1.")) {
    return "That doesn’t look like a Redline snapshot code — it should start with RLS1.";
  }
  if (!globalThis.crypto?.subtle) {
    return (
      "This page isn’t running in a secure context, so the browser disables " +
      "the crypto needed to decrypt the snapshot. Open the viewer via " +
      "http://localhost or an https:// address — a plain http:// IP or " +
      "hostname won’t work."
    );
  }
  if (typeof DecompressionStream === "undefined") {
    return (
      "This browser is missing DecompressionStream, which the snapshot " +
      "needs — use a current Chrome, Edge, Firefox, or Safari."
    );
  }
  if (token.split(".")[1] === "z") {
    try {
      new DecompressionStream("deflate-raw");
    } catch {
      return (
        "This browser can’t read this link’s compression format — ask the " +
        "sender to regenerate the link (their updated Redline mints a " +
        "compatible one)."
      );
    }
  }
  return (
    "That code didn’t decode — it may be incomplete (make sure the whole " +
    "thing was copied) or corrupted in transit."
  );
}

interface Annotation {
  id: string;
  type: "feedback" | "question" | "edit";
  blockId: string;
  body: string;
  revised?: string;
  selection: CommentSelection;
}

/** Minimal shape of the TipTap doc JSON we walk for the fallback TOC. */
interface DocNode {
  type?: string;
  text?: string;
  attrs?: { level?: number; blockId?: string };
  content?: DocNode[];
}

interface TocEntry {
  blockId: string;
  title: string;
  level: number;
}

function nodeText(node: DocNode): string {
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(nodeText).join("");
}

/** Fallback TOC from the doc JSON when the payload carries no `toc`
 *  (old-format links). Top-level headings with a stable blockId. */
function docHeadings(doc: DocNode): TocEntry[] {
  const out: TocEntry[] = [];
  for (const node of doc.content ?? []) {
    if (node.type !== "heading") continue;
    const blockId = node.attrs?.blockId;
    if (!blockId) continue;
    const title = nodeText(node).trim();
    if (!title) continue;
    out.push({ level: node.attrs?.level ?? 1, title, blockId });
  }
  return out;
}

interface Capture {
  blockId: string;
  selection: CommentSelection;
  rect: { top: number; left: number; bottom: number };
}

function storageKey(requestId: string): string {
  return `rl-viewer.${requestId}`;
}
function loadAnnotations(requestId: string): Annotation[] {
  try {
    const raw = localStorage.getItem(storageKey(requestId));
    const parsed = raw ? (JSON.parse(raw) as Annotation[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveAnnotations(requestId: string, annotations: Annotation[]): void {
  try {
    localStorage.setItem(storageKey(requestId), JSON.stringify(annotations));
  } catch {
    /* private mode — annotations survive the tab, not a reload */
  }
}

/** Resolve the current editor selection to a single block + char range. */
function captureSelection(editor: Editor): Capture | null {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const $from = state.doc.resolve(from);
  for (let depth = $from.depth; depth >= 1; depth--) {
    const node = $from.node(depth);
    const blockId = node.attrs?.blockId as string | undefined;
    if (!blockId) continue;
    const start = $from.start(depth);
    const end = start + node.content.size;
    if (to > end) return null;
    const charStart = state.doc.textBetween(start, from).length;
    const quotedText = state.doc.textBetween(from, to);
    if (!quotedText.trim()) return null;
    const domSel = window.getSelection();
    let rect = { top: 0, left: 0, bottom: 0 };
    if (domSel && domSel.rangeCount > 0) {
      const r = domSel.getRangeAt(0).getBoundingClientRect();
      rect = { top: r.top, left: r.left + r.width / 2, bottom: r.bottom };
    }
    return {
      blockId,
      selection: {
        charStart,
        charEnd: charStart + quotedText.length,
        quotedText,
      },
      rect,
    };
  }
  return null;
}

/* ───────────────────────────  phase machine  ───────────────────────────── */

type ViewerPhase =
  | { kind: "paste"; error?: string }
  | { kind: "invalid"; message: string }
  | { kind: "ready"; payload: SnapshotPayload; expired: boolean; token: string };

export function Viewer() {
  const [phase, setPhase] = useState<ViewerPhase>({ kind: "paste" });

  useEffect(() => {
    const fromHash = async () => {
      const token = window.location.hash.slice(1);
      if (!token) {
        setPhase({ kind: "paste" });
        return;
      }
      const clean = decodeURIComponent(token);
      const payload = await decodeSnapshot(clean);
      if (!payload) {
        setPhase({ kind: "invalid", message: explainDecodeFailure(clean) });
        return;
      }
      setPhase({
        kind: "ready",
        payload,
        token: clean,
        expired: !!payload.expiresAt && Date.now() > payload.expiresAt,
      });
    };
    void fromHash();
    window.addEventListener("hashchange", () => void fromHash());
  }, []);

  const pasteToken = async (raw: string) => {
    const token = raw.replace(/\s+/g, "").replace(/^.*#/, "");
    const payload = await decodeSnapshot(token);
    if (!payload) {
      setPhase({ kind: "paste", error: explainDecodeFailure(raw) });
      return;
    }
    setPhase({
      kind: "ready",
      payload,
      token,
      expired: !!payload.expiresAt && Date.now() > payload.expiresAt,
    });
  };

  if (phase.kind === "paste") {
    return <PasteScreen error={phase.error} onSubmit={pasteToken} />;
  }
  if (phase.kind === "invalid") {
    return (
      <div className="rlv-shell rlv-center">
        <div className="rlv-card">
          <h1>Couldn’t open this review</h1>
          <p>{phase.message}</p>
        </div>
      </div>
    );
  }
  return (
    <ReviewScreen
      payload={phase.payload}
      expired={phase.expired}
      token={phase.token}
    />
  );
}

function PasteScreen({
  error,
  onSubmit,
}: {
  error?: string;
  onSubmit: (raw: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="rlv-shell rlv-center">
      <div className="rlv-card">
        <div className="rlv-paste-hero">
          <div className="rlv-paste-badge">
            <span className="rlv-brand-dot" /> Redline
          </div>
        </div>
        <h1>Open a plan review</h1>
        <p>
          Paste the review link or snapshot code you were sent. Everything
          decrypts locally in your browser — the plan never touches a server.
        </p>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={4}
          placeholder="RLS1.…"
          className="rlv-mono"
        />
        {error && <p className="rlv-error">{error}</p>}
        <div className="rlv-row rlv-end">
          <button
            className="rlv-btn rlv-primary"
            disabled={!value.trim()}
            onClick={() => onSubmit(value)}
          >
            Open review
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────  review screen  ───────────────────────────── */

type InspectorTab = "review" | "discussion" | "revisions" | "about";

function ReviewScreen({
  payload,
  expired,
  token,
}: {
  payload: SnapshotPayload;
  expired: boolean;
  token: string;
}) {
  const [annotations, setAnnotations] = useState<Annotation[]>(() =>
    loadAnnotations(payload.requestId),
  );
  const [capture, setCapture] = useState<Capture | null>(null);
  const [composing, setComposing] = useState<{
    capture: Capture;
    type: Annotation["type"];
    editingId?: string;
  } | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [tab, setTab] = useState<InspectorTab>(
    payload.discussion?.length ? "discussion" : "review",
  );
  const [tocOpen, setTocOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const seq = useRef(annotations.length);
  const paneRef = useRef<HTMLElement | null>(null);

  const docJson = useMemo(
    () => planMarkdownToDoc(payload.markdown).toJSON() as DocNode,
    [payload.markdown],
  );

  // Prefer the payload's pruned (nested) TOC; fall back to a doc-JSON walk for
  // old-format links that don't carry one.
  const toc: TocEntry[] = useMemo(() => {
    if (payload.toc?.length) {
      return payload.toc.map((n) => ({
        blockId: n.blockId,
        title: n.title,
        level: n.level,
      }));
    }
    return docHeadings(docJson);
  }, [payload.toc, docJson]);

  const extensions = useMemo(() => [...planExtensions(), CommentHighlights], []);

  const editor = useEditor({
    extensions,
    content: docJson,
    editable: false,
    editorProps: {
      attributes: { class: "rl-prose rlv-doc", "aria-label": "Plan document" },
    },
    onSelectionUpdate: ({ editor }) => {
      if (expired) return;
      setCapture(captureSelection(editor as Editor));
    },
  });

  useEffect(() => {
    if (!editor) return;
    const ranges: CommentHighlightRange[] = annotations.map((a) => ({
      commentId: a.id,
      blockId: a.blockId,
      charStart: a.selection.charStart,
      charEnd: a.selection.charEnd,
      quotedText: a.selection.quotedText,
      muted: false,
    }));
    editor.commands.setCommentHighlights(ranges);
  }, [editor, annotations]);

  // Reading-progress bar + active-heading scrollspy both drive off the pane.
  const [activeBlock, setActiveBlock] = useState<string | null>(null);
  const lockedRef = useRef(false);
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const max = pane.scrollHeight - pane.clientHeight;
      setProgress(max > 0 ? Math.min(1, pane.scrollTop / max) : 0);
      if (lockedRef.current || toc.length === 0) return;
      const paneTop = pane.getBoundingClientRect().top;
      const line = paneTop + 96;
      const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4;
      if (atBottom) {
        setActiveBlock(toc[toc.length - 1].blockId);
        return;
      }
      let active = toc[0].blockId;
      for (const h of toc) {
        const el = pane.querySelector<HTMLElement>(
          `.rlv-doc [data-block-id="${cssEscape(h.blockId)}"]`,
        );
        if (el && el.getBoundingClientRect().top <= line) active = h.blockId;
      }
      setActiveBlock(active);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    pane.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    compute();
    return () => {
      pane.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [toc, editor]);

  const scrollToBlock = useCallback(
    (blockId: string, flash = false) => {
      const pane = paneRef.current;
      const el = pane?.querySelector<HTMLElement>(
        `.rlv-doc [data-block-id="${cssEscape(blockId)}"]`,
      );
      if (!el) return;
      setActiveBlock(blockId);
      lockedRef.current = true;
      window.setTimeout(() => (lockedRef.current = false), 700);
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      if (flash) {
        el.classList.remove("rlv-flash");
        void el.offsetWidth; // reflow so the animation re-triggers
        el.classList.add("rlv-flash");
      }
      setTocOpen(false);
      setRailOpen(false);
    },
    [],
  );

  const persist = useCallback(
    (next: Annotation[]) => {
      setAnnotations(next);
      saveAnnotations(payload.requestId, next);
    },
    [payload.requestId],
  );

  const saveAnnotation = (
    type: Annotation["type"],
    body: string,
    revised?: string,
  ) => {
    if (!composing) return;
    const { capture, editingId } = composing;
    if (editingId) {
      persist(
        annotations.map((a) =>
          a.id === editingId
            ? {
                ...a,
                type,
                body,
                ...(type === "edit" ? { revised } : { revised: undefined }),
              }
            : a,
        ),
      );
    } else {
      persist([
        ...annotations,
        {
          id: `v-${Date.now()}-${seq.current++}`,
          type,
          blockId: capture.blockId,
          body,
          ...(type === "edit" && revised !== undefined ? { revised } : {}),
          selection: capture.selection,
        },
      ]);
    }
    setComposing(null);
    setCapture(null);
  };

  const editAnnotation = (a: Annotation) => {
    setComposing({
      capture: {
        blockId: a.blockId,
        selection: a.selection,
        rect: { top: 0, left: 0, bottom: 0 },
      },
      type: a.type,
      editingId: a.id,
    });
  };

  return (
    <div className="rlv-shell">
      <HeroHeader
        payload={payload}
        token={token}
        annotationCount={annotations.length}
        onSend={() => setSendOpen(true)}
        onToggleToc={() => setTocOpen((o) => !o)}
        onToggleRail={() => setRailOpen((o) => !o)}
        hasToc={toc.length >= 2}
      />
      <div className="rlv-progress">
        <div
          className="rlv-progress-fill"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      {expired && (
        <div className="rlv-banner">
          This review link has expired — you can read the plan, but returns will
          be rejected. Ask for a fresh link.
        </div>
      )}

      <div className="rlv-body">
        {tocOpen && (
          <div
            className="rlv-drawer-backdrop rlv-drawer-backdrop--show rlv-mobile-only"
            onClick={() => setTocOpen(false)}
          />
        )}
        {toc.length >= 2 && (
          <RichToc
            items={toc}
            activeBlock={activeBlock}
            onJump={(b) => scrollToBlock(b)}
            open={tocOpen}
          />
        )}

        <main className="rlv-doc-pane" ref={paneRef}>
          <EditorContent editor={editor} />
        </main>

        {railOpen && (
          <div
            className="rlv-drawer-backdrop rlv-drawer-backdrop--show rlv-mobile-only"
            onClick={() => setRailOpen(false)}
          />
        )}
        <InspectorRail
          payload={payload}
          annotations={annotations}
          tab={tab}
          onTab={setTab}
          expired={expired}
          open={railOpen}
          token={token}
          onEditAnnotation={editAnnotation}
          onDeleteAnnotation={(id) =>
            persist(annotations.filter((x) => x.id !== id))
          }
          onJumpBlock={(b) => scrollToBlock(b, true)}
        />
      </div>

      {capture && !composing && !expired && (
        <div
          className="rlv-menu"
          style={{
            top: Math.max(8, capture.rect.top - 46),
            left: capture.rect.left,
          }}
        >
          <button onClick={() => setComposing({ capture, type: "feedback" })}>
            💬 Comment
          </button>
          <button onClick={() => setComposing({ capture, type: "edit" })}>
            ✎ Suggest
          </button>
          <button onClick={() => setComposing({ capture, type: "question" })}>
            ？ Question
          </button>
        </div>
      )}
      {composing && (
        <Composer
          type={composing.type}
          editing={!!composing.editingId}
          quotedText={composing.capture.selection.quotedText}
          initialBody={
            composing.editingId
              ? annotations.find((a) => a.id === composing.editingId)?.body ?? ""
              : ""
          }
          initialRevised={
            composing.editingId
              ? annotations.find((a) => a.id === composing.editingId)?.revised
              : undefined
          }
          onSave={saveAnnotation}
          onCancel={() => setComposing(null)}
        />
      )}
      {sendOpen && (
        <SendBack
          payload={payload}
          annotations={annotations}
          onClose={() => setSendOpen(false)}
        />
      )}
    </div>
  );
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/["\\\n]/g, "\\$&");
}

/* ───────────────────────────  hero header  ─────────────────────────────── */

function HeroHeader({
  payload,
  token,
  annotationCount,
  onSend,
  onToggleToc,
  onToggleRail,
  hasToc,
}: {
  payload: SnapshotPayload;
  token: string;
  annotationCount: number;
  onSend: () => void;
  onToggleToc: () => void;
  onToggleRail: () => void;
  hasToc: boolean;
}) {
  const title = payload.planTitle || payload.projectName || "Plan review";
  const expiresLabel =
    payload.expiresAt && Date.now() < payload.expiresAt
      ? `expires ${relTime(payload.expiresAt)}`
      : null;
  return (
    <header className="rlv-header">
      <div className="rlv-header-top">
        <div style={{ minWidth: 0 }}>
          <div className="rlv-brand">
            <span className="rlv-brand-dot" /> Redline · Shared plan
          </div>
          <h1 className="rlv-title">{title}</h1>
          <div className="rlv-meta-row">
            {payload.ownerName && (
              <span className="rlv-pill">
                <span className="rlv-avatar">{monogram(payload.ownerName)}</span>
                {payload.ownerName}
              </span>
            )}
            {payload.projectName && (
              <span className="rlv-pill rlv-pill-muted">
                {payload.projectName}
              </span>
            )}
            <span className="rlv-pill rlv-pill-muted">v{payload.baseVersion}</span>
            {payload.createdAt && (
              <span className="rlv-pill rlv-pill-muted">
                shared {relTime(payload.createdAt)}
              </span>
            )}
            {payload.reviewerName && (
              <span className="rlv-pill rlv-pill-muted">
                for {payload.reviewerName}
              </span>
            )}
            {expiresLabel && (
              <span className="rlv-pill rlv-pill-warn">{expiresLabel}</span>
            )}
          </div>
          {payload.note && <div className="rlv-note">“{payload.note}”</div>}
        </div>

        <div className="rlv-header-actions">
          {hasToc && (
            <button
              className="rlv-icon-round rlv-mobile-only"
              title="Contents"
              onClick={onToggleToc}
            >
              ☰
            </button>
          )}
          <button
            className="rlv-icon-round rlv-mobile-only"
            title="Details"
            onClick={onToggleRail}
          >
            ⋯
          </button>
          <AppearanceMenu />
          <OpenInRedline token={token} />
          <button
            className="rlv-btn rlv-primary"
            disabled={annotationCount === 0}
            onClick={onSend}
          >
            Send back{annotationCount > 0 ? ` (${annotationCount})` : ""}
          </button>
        </div>
      </div>

      {payload.stats && <StatsStrip stats={payload.stats} payload={payload} />}
    </header>
  );
}

function StatsStrip({
  stats,
  payload,
}: {
  stats: NonNullable<SnapshotPayload["stats"]>;
  payload: SnapshotPayload;
}) {
  const items: Array<[number | string, string]> = [
    [`${stats.readingMinutes}`, stats.readingMinutes === 1 ? "min read" : "min read"],
    [stats.sectionCount, stats.sectionCount === 1 ? "section" : "sections"],
    [stats.versionCount, stats.versionCount === 1 ? "version" : "versions"],
  ];
  if (payload.discussion?.length) {
    items.push([payload.discussion.length, "comments"]);
  }
  if (payload.decisions?.length) {
    items.push([payload.decisions.length, "decisions"]);
  }
  items.push([stats.wordCount.toLocaleString(), "words"]);
  return (
    <div className="rlv-stats">
      {items.map(([n, l], i) => (
        <div className="rlv-stat" key={i}>
          <span className="rlv-stat-n">{n}</span>
          <span className="rlv-stat-l">{l}</span>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────────  table of contents  ───────────────────────── */

function RichToc({
  items,
  activeBlock,
  onJump,
  open,
}: {
  items: TocEntry[];
  activeBlock: string | null;
  onJump: (blockId: string) => void;
  open: boolean;
}) {
  const top = Math.min(...items.map((h) => h.level));
  return (
    <nav
      className={`rlv-toc${open ? " rlv-toc--open" : ""}`}
      aria-label="Table of contents"
    >
      <div className="rlv-rail-heading">Contents</div>
      <ul className="rlv-toc-list">
        {items.map((h) => (
          <li key={h.blockId}>
            <button
              type="button"
              className={`rlv-toc-link${
                activeBlock === h.blockId ? " rlv-toc-link--active" : ""
              }`}
              style={{ paddingLeft: `${8 + (h.level - top) * 13}px` }}
              onClick={() => onJump(h.blockId)}
              title={h.title}
            >
              {h.title}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ───────────────────────────  inspector rail  ──────────────────────────── */

function InspectorRail({
  payload,
  annotations,
  tab,
  onTab,
  expired,
  open,
  token,
  onEditAnnotation,
  onDeleteAnnotation,
  onJumpBlock,
}: {
  payload: SnapshotPayload;
  annotations: Annotation[];
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  expired: boolean;
  open: boolean;
  token: string;
  onEditAnnotation: (a: Annotation) => void;
  onDeleteAnnotation: (id: string) => void;
  onJumpBlock: (blockId: string) => void;
}) {
  const discussionCount = payload.discussion?.length ?? 0;
  const revisionCount = payload.revisionTimeline?.length ?? 0;
  const tabs: Array<{ id: InspectorTab; label: string; count?: number }> = [
    { id: "review", label: "Review", count: annotations.length || undefined },
    { id: "discussion", label: "Discussion", count: discussionCount || undefined },
    { id: "revisions", label: "History", count: revisionCount || undefined },
    { id: "about", label: "About" },
  ];
  return (
    <aside className={`rlv-rail${open ? " rlv-rail--open" : ""}`}>
      <div className="rlv-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`rlv-tab${tab === t.id ? " rlv-tab--active" : ""}`}
            onClick={() => onTab(t.id)}
          >
            {t.label}
            {t.count != null && <span className="rlv-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>
      <div className="rlv-tab-body">
        {tab === "review" && (
          <ReviewTab
            annotations={annotations}
            expired={expired}
            onEdit={onEditAnnotation}
            onDelete={onDeleteAnnotation}
          />
        )}
        {tab === "discussion" && (
          <DiscussionTab payload={payload} onJumpBlock={onJumpBlock} token={token} />
        )}
        {tab === "revisions" && (
          <RevisionsTab payload={payload} token={token} />
        )}
        {tab === "about" && <AboutTab payload={payload} />}
      </div>
    </aside>
  );
}

function ReviewTab({
  annotations,
  expired,
  onEdit,
  onDelete,
}: {
  annotations: Annotation[];
  expired: boolean;
  onEdit: (a: Annotation) => void;
  onDelete: (id: string) => void;
}) {
  if (annotations.length === 0) {
    return (
      <p className="rlv-hint">
        {expired
          ? "This link has expired, so new annotations can’t be sent back."
          : "Select any text in the plan to leave a comment, suggest an edit, or ask a question. Your notes stay in this browser until you send them back."}
      </p>
    );
  }
  return (
    <ul className="rlv-list">
      {annotations.map((a) => (
        <li key={a.id} className="rlv-item">
          <div className="rlv-item-head">
            <span className={`rlv-chip rlv-chip-${a.type}`}>
              {a.type === "edit" ? "suggestion" : a.type}
            </span>
            <div className="rlv-item-tools">
              <button
                className="rlv-icon-btn"
                title="Edit"
                onClick={() => onEdit(a)}
              >
                ✎
              </button>
              <button
                className="rlv-icon-btn"
                title="Delete"
                onClick={() => onDelete(a.id)}
              >
                ✕
              </button>
            </div>
          </div>
          <div className="rlv-quote">“{a.selection.quotedText}”</div>
          {a.type === "edit" ? (
            <div className="rlv-item-body">
              <span className="rlv-strike">{a.selection.quotedText}</span> →{" "}
              <strong>{a.revised || "(delete)"}</strong>
              {a.body && <div style={{ marginTop: 4 }}>{a.body}</div>}
            </div>
          ) : (
            <div className="rlv-item-body">{a.body}</div>
          )}
        </li>
      ))}
    </ul>
  );
}

function DiscussionTab({
  payload,
  onJumpBlock,
  token,
}: {
  payload: SnapshotPayload;
  onJumpBlock: (blockId: string) => void;
  token: string;
}) {
  const discussion = payload.discussion ?? [];
  if (discussion.length === 0) {
    return (
      <>
        <p className="rlv-hint">No prior discussion was shared on this plan.</p>
        <div className="rlv-unlock">
          Live, threaded discussion — with an AI collaborator you can talk to
          about any section — happens in <b>Redline</b>.{" "}
          <OpenInRedlineInline token={token} />
        </div>
      </>
    );
  }
  return (
    <>
      {discussion.map((c, i) => (
        <div className="rlv-thread" key={i}>
          <div className="rlv-thread-head">
            <span className={`rlv-chip rlv-chip-${chipFor(c.type)}`}>
              {c.type === "edit" ? "suggestion" : c.type.replace("block-", "")}
            </span>
            <span className={`rlv-chip rlv-chip-${c.resolved ? "resolved" : "open"}`}>
              {c.resolved ? "resolved" : "open"}
            </span>
            <span className="rlv-thread-when">{relTime(c.createdAt)}</span>
          </div>
          {c.author && <div className="rlv-thread-who">{c.author}</div>}
          <div className="rlv-thread-body">{c.body}</div>
          {c.resolution && (
            <div className="rlv-thread-resolution">
              <b>Resolved:</b> {c.resolution}
            </div>
          )}
          {c.blockId && (
            <button className="rlv-jump" onClick={() => onJumpBlock(c.blockId!)}>
              Jump to this block ↦
            </button>
          )}
        </div>
      ))}
      <div className="rlv-unlock">
        This is a read-only slice. In <b>Redline</b>, every thread is live — reopen
        it, reply, or spin up an AI discussion on the spot.{" "}
        <OpenInRedlineInline token={token} />
      </div>
    </>
  );
}

function chipFor(type: string): string {
  if (type === "edit") return "edit";
  if (type === "question") return "question";
  return "feedback";
}

function RevisionsTab({
  payload,
  token,
}: {
  payload: SnapshotPayload;
  token: string;
}) {
  const timeline = payload.revisionTimeline ?? [];
  const decisions = payload.decisions ?? [];
  if (timeline.length === 0) {
    return <p className="rlv-hint">No revision history was shared.</p>;
  }
  const current = payload.baseVersion;
  return (
    <>
      <div className="rlv-rail-heading" style={{ padding: 0 }}>
        Revision history
      </div>
      <ul className="rlv-timeline" style={{ marginTop: 12 }}>
        {[...timeline]
          .sort((a, b) => b.version - a.version)
          .map((r) => (
            <li
              key={r.version}
              className={`rlv-tl-item${
                r.version === current ? " rlv-tl-item--current" : ""
              }`}
            >
              <span className="rlv-tl-dot" />
              <div>
                <span className="rlv-tl-v">v{r.version}</span>{" "}
                <span className="rlv-tl-when">{relTime(r.createdAt)}</span>
                {r.threadStart && <span className="rlv-tl-badge">new plan</span>}
                {r.version === current && (
                  <span className="rlv-tl-badge">you’re viewing</span>
                )}
              </div>
              {r.title && <div className="rlv-tl-title">{r.title}</div>}
              {r.version !== current && (
                <div className="rlv-tl-locked">
                  Open in Redline to step through the full diff.
                </div>
              )}
            </li>
          ))}
      </ul>

      {decisions.length > 0 && (
        <>
          <div className="rlv-rail-heading" style={{ padding: 0, marginTop: 18 }}>
            Decisions
          </div>
          <div style={{ marginTop: 8 }}>
            {decisions.map((d, i) => (
              <div className="rlv-decision" key={i}>
                <span className="rlv-decision-mark">✓</span>
                <div>
                  <div className="rlv-decision-body">{d.title}</div>
                  <div className="rlv-decision-when">
                    {d.disposition} · {relTime(d.decidedAt)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="rlv-unlock">
        Every version here is preserved in <b>Redline</b> with a full
        track-changes diff and a tamper-evident decision ledger.{" "}
        <OpenInRedlineInline token={token} />
      </div>
    </>
  );
}

function AboutTab({ payload }: { payload: SnapshotPayload }) {
  const rows: Array<[string, string | undefined]> = [
    ["Shared by", payload.ownerName],
    ["For", payload.reviewerName],
    ["Project", payload.projectName],
    ["Version", `v${payload.baseVersion}`],
    ["Shared", new Date(payload.createdAt).toLocaleString()],
    [
      "Expires",
      payload.expiresAt ? new Date(payload.expiresAt).toLocaleString() : "never",
    ],
  ];
  return (
    <>
      <p className="rlv-hint" style={{ marginBottom: 14 }}>
        This plan was encrypted end-to-end into the link you opened. It decrypted
        entirely in your browser — it never reached any server.
      </p>
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div
            key={k}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              padding: "6px 0",
              borderBottom: "1px solid color-mix(in srgb, var(--color-rule) 60%, transparent)",
              fontSize: 12,
            }}
          >
            <span style={{ color: "var(--color-ink-muted)" }}>{k}</span>
            <span style={{ textAlign: "right" }}>{v}</span>
          </div>
        ))}
    </>
  );
}

/* ───────────────────────────  appearance menu  ─────────────────────────── */

// A curated subset of the app's themes, spanning the range so the picker looks
// intentional rather than a data dump.
const VIEWER_THEMES: ThemeName[] = [
  "studio",
  "terminal",
  "ocean",
  "novel",
  "blossom",
  "homebrew",
  "manpage",
  "grass",
  "redsand",
  "pro",
  "basic",
  "redline",
  "silveraerogel",
  "solidcolors",
];

function AppearanceMenu() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(() => readStoredTheme());
  const [font, setFont] = useState<FontName>(() => readStoredFont());
  const [wide, setWide] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pickTheme = (name: ThemeName) => {
    setTheme(name);
    applyTheme(name);
    storeTheme(name);
  };
  const pickFont = (name: FontName) => {
    setFont(name);
    applyFont(name);
    storeFont(name);
  };
  const setWidth = (w: boolean) => {
    setWide(w);
    document.documentElement.style.setProperty(
      "--rlv-measure",
      w ? "960px" : "760px",
    );
  };

  const themeEntries = new Map(THEMES.map((t) => [t.name, t]));

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        className="rlv-icon-round"
        title="Appearance"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ◑
      </button>
      {open && (
        <div className="rlv-pop" role="menu">
          <div className="rlv-pop-section">
            <div className="rlv-pop-label">Theme</div>
            <div className="rlv-swatches">
              {VIEWER_THEMES.map((name) => {
                const t = themeEntries.get(name);
                if (!t) return null;
                return (
                  <button
                    key={name}
                    className={`rlv-swatch${theme === name ? " rlv-swatch--active" : ""}`}
                    title={t.label}
                    onClick={() => pickTheme(name)}
                    style={{
                      background: `linear-gradient(135deg, ${t.base.bg} 0 55%, ${t.base.blue} 55% 78%, ${t.base.selection} 78%)`,
                    }}
                  />
                );
              })}
            </div>
          </div>
          <div className="rlv-pop-section">
            <div className="rlv-pop-label">Font</div>
            <select
              className="rlv-select"
              value={font}
              onChange={(e) => pickFont(e.target.value as FontName)}
            >
              {FONTS.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="rlv-pop-section">
            <div className="rlv-pop-label">Reading width</div>
            <div className="rlv-seg">
              <button
                className={!wide ? "rlv-seg--active" : ""}
                onClick={() => setWidth(false)}
              >
                Comfortable
              </button>
              <button
                className={wide ? "rlv-seg--active" : ""}
                onClick={() => setWidth(true)}
              >
                Wide
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────  Open-in-Redline  ─────────────────────────── */

function OpenInRedline({ token }: { token: string }) {
  return (
    <a
      className="rlv-btn rlv-ghost"
      href={`redline://open#${token}`}
      title="Open this plan in the Redline app for full track-changes review, live collaboration, revision diffs, and the decision ledger."
    >
      ⤢ Open in Redline
    </a>
  );
}

function OpenInRedlineInline({ token }: { token: string }) {
  return (
    <a
      href={`redline://open#${token}`}
      style={{ color: "var(--color-info)", fontWeight: 600 }}
    >
      Open in Redline →
    </a>
  );
}

/* ───────────────────────────  composer  ────────────────────────────────── */

function Composer({
  type,
  editing,
  quotedText,
  initialBody,
  initialRevised,
  onSave,
  onCancel,
}: {
  type: Annotation["type"];
  editing: boolean;
  quotedText: string;
  initialBody: string;
  initialRevised?: string;
  onSave: (type: Annotation["type"], body: string, revised?: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const [revised, setRevised] = useState(initialRevised ?? quotedText);
  const isEdit = type === "edit";
  const ready = isEdit ? revised !== quotedText || body.trim() : !!body.trim();
  return (
    <div className="rlv-overlay" onClick={onCancel}>
      <div className="rlv-card" onClick={(e) => e.stopPropagation()}>
        <h2>
          {editing
            ? "Edit annotation"
            : isEdit
              ? "Suggest an edit"
              : type === "question"
                ? "Ask a question"
                : "Add a comment"}
        </h2>
        <div className="rlv-quote">“{quotedText}”</div>
        {isEdit && (
          <label>
            Revised text (clear it to suggest deletion)
            <textarea
              value={revised}
              onChange={(e) => setRevised(e.target.value)}
              rows={3}
            />
          </label>
        )}
        <label>
          {isEdit ? "Why (optional)" : "Your note"}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            autoFocus={!isEdit}
          />
        </label>
        <div className="rlv-row rlv-end">
          <button className="rlv-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="rlv-btn rlv-primary"
            disabled={!ready}
            onClick={() => onSave(type, body.trim(), isEdit ? revised : undefined)}
          >
            {editing ? "Update" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────  send back  ───────────────────────────────── */

function SendBack({
  payload,
  annotations,
  onClose,
}: {
  payload: SnapshotPayload;
  annotations: Annotation[];
  onClose: () => void;
}) {
  const [blob, setBlob] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const comments: ReturnComment[] = annotations.map((a) => ({
      type: a.type,
      blockId: a.blockId,
      body: a.body || (a.type === "edit" ? "(edit)" : ""),
      ...(a.type === "edit"
        ? { edit: { original: a.selection.quotedText, revised: a.revised ?? "" } }
        : {}),
      selection: a.selection,
    }));
    const returnPayload: ReturnPayload = {
      v: 1,
      requestId: payload.requestId,
      baseVersion: payload.baseVersion,
      reviewerName: payload.reviewerName,
      createdAt: Date.now(),
      comments,
    };
    void signReturn(returnPayload, payload.signingKey).then((signed) => {
      if (!cancelled) setBlob(signed);
    });
    return () => {
      cancelled = true;
    };
  }, [payload, annotations]);

  const mailto = blob
    ? `mailto:?subject=${encodeURIComponent(
        `Review return — ${payload.planTitle || payload.projectName || "plan"}`,
      )}&body=${encodeURIComponent(
        `Here's my signed review return — paste it into Redline's Collaboration Center:\n\n${blob}\n`,
      )}`
    : undefined;

  return (
    <div className="rlv-overlay" onClick={onClose}>
      <div className="rlv-card" onClick={(e) => e.stopPropagation()}>
        <h2>Hand your review back</h2>
        <p>
          This return code carries your {annotations.length} annotation
          {annotations.length === 1 ? "" : "s"}, signed so{" "}
          {payload.ownerName || "the owner"} can verify it came from this review
          link untampered. Send it back any way you like — email, chat, a paste.
        </p>
        <textarea
          readOnly
          value={blob ?? "Signing…"}
          rows={5}
          className="rlv-mono"
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="rlv-row rlv-end">
          {mailto && (
            <a className="rlv-btn" href={mailto}>
              Email it…
            </a>
          )}
          <button
            className="rlv-btn rlv-primary"
            disabled={!blob}
            onClick={() => {
              if (!blob) return;
              void navigator.clipboard.writeText(blob);
              setCopied(true);
            }}
          >
            {copied ? "Copied ✓" : "Copy return code"}
          </button>
          <button className="rlv-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
