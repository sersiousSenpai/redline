// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";

import type { BinaryFile, DocMeta, FileContent } from "../types";
import { useLiveFile } from "../hooks/useFsWatch";
import {
  initialEditSwap,
  reduceEditSwap,
  type EditSwapEvent,
  type EditSwapState,
} from "../lib/editSwap";
import { MarkdownView } from "./MarkdownView";
import { codeViewImport } from "./codeViewWarm";
import { DiskChangeBanner, DiskCompare, type DiskChange } from "./DiskChangeBanner";
// Type-only: erased at build, so the main bundle stays CodeMirror-free.
import type { PreparedEdit } from "./CodeEditor";

// Don't flash a loading notice for reads faster than this; markdown files resolve
// well under it, so switching between them shows no flicker. Mirrors CodeView.
const LOADING_DELAY_MS = 120;

// The code viewer is a separate chunk; keep it out of the initial bundle but
// preload it as soon as the folder explorer is shown (`preloadCodeView` in
// codeViewWarm.ts — its own module so FileTree can warm without statically
// importing this file), so the first file click never waits on the chunk —
// which would stack a Suspense "Loading…" on top of CodeView's own load (the
// "double flash").
const CodeView = lazy(codeViewImport);

// The editor (CodeMirror + friends) is a bigger chunk and most file opens are
// read-only — so unlike CodeView it is NOT warmed on explorer open, only when
// the user hovers/clicks Edit. No `lazy()` wrapper: CodeBody awaits this
// import itself as part of *preparing* an edit, then renders the component
// directly — so there's no Suspense fallback frame to reason about.
const codeEditorImport = () => import("./CodeEditor");

let codeEditorPreloaded: Promise<unknown> | null = null;
/** Warm the CodeEditor chunk (Edit hover/click). Idempotent. */
function preloadCodeEditor(): void {
  if (!codeEditorPreloaded) codeEditorPreloaded = codeEditorImport();
}

// Image types the browser can render from a data URL. svg is text but renders
// fine as an image, which is what people expect when they click one.
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

function extension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

function imageMime(path: string): string | null {
  return IMAGE_MIME[extension(path)] ?? null;
}

interface FileViewerProps {
  /** Absolute path of the file to show. */
  path: string;
  onClose: () => void;
  /** Called with the saved path after an in-place markdown edit is written. */
  onSaved?: (path: string) => void;
  /** The user started editing: a preview pane pins (the Files rail's rule). */
  onEdit?: () => void;
  /** A line to scroll to and mark (1-based): a `file:line` link. `lineAt`
   *  asks again for the same line. */
  line?: number;
  lineAt?: number;
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

// Read-only viewer for a single file picked from the FileTree. Images render
// inline; markdown renders rich; everything else shows syntax-highlighted
// source. Oversized files report why they weren't loaded.
function FileViewerBase({ path, onClose, onSaved, onEdit, line, lineAt }: FileViewerProps) {
  const mime = imageMime(path);

  return (
    <div className="h-full flex flex-col">
      <div
        className="rl-chrome-label sticky top-0 z-10 px-4 py-2 border-b flex items-center justify-between"
        style={{
          borderColor: "var(--color-rule)",
          background: "var(--color-paper)",
        }}
      >
        <span className="truncate normal-case font-mono" title={path}>
          {basename(path)}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close file"
          aria-label="Close file"
          className="flex items-center justify-center rounded shrink-0"
          style={{
            width: "20px",
            height: "20px",
            fontSize: "12px",
            lineHeight: 1,
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink-muted)",
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {mime ? (
          <ImageBody path={path} mime={mime} />
        ) : (
          <TextBody path={path} onSaved={onSaved} onEdit={onEdit} reveal={line ? { line, at: lineAt } : null} />
        )}
      </div>
    </div>
  );
}

// Loads and renders an image as a base64 data URL — works without the Tauri
// asset protocol, mirroring how PTY output is already framed as base64.
function ImageBody({ path, mime }: { path: string; mime: string }) {
  const [file, setFile] = useState<BinaryFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (refresh: boolean) => {
      let cancelled = false;
      if (!refresh) {
        setFile(null);
        setError(null);
      }
      void (async () => {
        try {
          const result = await invoke<BinaryFile>("read_file_base64", { path });
          if (!cancelled) {
            setFile(result);
            setError(null);
          }
        } catch (e) {
          if (!cancelled && !refresh) setError(String(e));
        }
      })();
      return () => {
        cancelled = true;
      };
    },
    [path],
  );

  useEffect(() => load(false), [load]);
  const reload = useCallback(() => void load(true), [load]);
  useLiveFile(path, reload);

  if (error) return <Notice>Couldn’t read this image.</Notice>;
  if (file === null) return <Notice>Loading…</Notice>;
  if (file.tooLarge) {
    return (
      <Notice>
        Image is too large to preview ({Math.round(file.size / 1024)} KB).
      </Notice>
    );
  }
  return <ImageStage src={`data:${mime};base64,${file.data}`} alt={basename(path)} />;
}

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 16;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** An image you can look into (W4): it opens fitted; pinch or ⌘-scroll zooms
 *  about the pointer, scrolling or dragging pans, a double-click toggles
 *  fitted and actual size, and the corner control steps the zoom. */
function ImageStage({ src, alt }: { src: string; alt: string }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // `fit` re-centres on every resize; any zoom or pan leaves it.
  const [view, setView] = useState<{ fit: boolean; scale: number; x: number; y: number }>({ fit: true, scale: 1, x: 0, y: 0 });
  const fitView = useCallback(() => {
    const box = boxRef.current;
    if (!box || !natural) return;
    const pad = 24;
    const scale = Math.min(1, (box.clientWidth - pad * 2) / natural.w, (box.clientHeight - pad * 2) / natural.h);
    const s = Math.max(ZOOM_MIN, scale);
    setView({ fit: true, scale: s, x: (box.clientWidth - natural.w * s) / 2, y: (box.clientHeight - natural.h * s) / 2 });
  }, [natural]);
  useEffect(() => {
    if (!view.fit) return;
    fitView();
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => fitView());
    ro.observe(box);
    return () => ro.disconnect();
  }, [view.fit, fitView]);
  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    const box = boxRef.current;
    setView((v) => {
      const scale = clampZoom(v.scale * factor);
      const cx = px ?? (box ? box.clientWidth / 2 : 0);
      const cy = py ?? (box ? box.clientHeight / 2 : 0);
      const k = scale / v.scale;
      return { fit: false, scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  }, []);
  // Wheel: non-passive, so a pinch never zooms the whole webview.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else setView((v) => ({ ...v, fit: false, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [zoomAt]);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const btn: React.CSSProperties = { width: "24px", height: "24px", border: "none", background: "transparent", color: "var(--color-ink-muted)", cursor: "pointer", fontSize: "13px" };
  return (
    <div
      ref={boxRef}
      className="relative h-full w-full overflow-hidden"
      style={{ cursor: drag.current ? "grabbing" : "grab", touchAction: "none", minHeight: "200px" }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        setView((v) => ({ ...v, fit: false, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onDoubleClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        if (view.fit && view.scale < 1) zoomAt(1 / view.scale, e.clientX - r.left, e.clientY - r.top);
        else setView((v) => ({ ...v, fit: true }));
      }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          maxWidth: "none",
          transformOrigin: "0 0",
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          visibility: natural ? "visible" : "hidden",
          // Checkerboard so transparent PNGs are legible on any theme.
          background:
            "repeating-conic-gradient(var(--color-bg-elevated) 0% 25%, transparent 0% 50%) 50% / 16px 16px",
          boxShadow: "0 1px 6px rgba(0,0,0,0.25)",
          imageRendering: view.scale >= 4 ? "pixelated" : undefined,
        }}
      />
      <div
        className="absolute flex items-center gap-1 rounded-full"
        style={{ right: "12px", bottom: "12px", padding: "2px 4px", background: "var(--color-bg-elevated)", border: "1px solid var(--color-rule)" }}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button type="button" style={btn} title="Zoom out" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.25)}>
          −
        </button>
        <span className="font-mono" style={{ fontSize: "10.5px", minWidth: "38px", textAlign: "center", color: "var(--color-ink-muted)" }}>
          {Math.round(view.scale * 100)}%
        </span>
        <button type="button" style={btn} title="Zoom in" aria-label="Zoom in" onClick={() => zoomAt(1.25)}>
          +
        </button>
        <button type="button" style={{ ...btn, width: "auto", padding: "0 6px", fontSize: "11px" }} title="Fit the pane" onClick={() => setView((v) => ({ ...v, fit: true }))}>
          Fit
        </button>
        <button
          type="button"
          style={{ ...btn, width: "auto", padding: "0 6px", fontSize: "11px" }}
          title="Actual size"
          onClick={() => zoomAt(1 / view.scale)}
        >
          1:1
        </button>
      </div>
    </div>
  );
}

// Markdown renders rich (full read); everything else goes to the virtualized,
// off-thread-tokenized code viewer so a large file never freezes the UI.
function TextBody({
  path,
  onSaved,
  onEdit,
  reveal,
}: {
  path: string;
  onSaved?: (path: string) => void;
  onEdit?: () => void;
  reveal: { line: number; at?: number } | null;
}) {
  if (isMarkdown(path)) return <MarkdownBody path={path} onSaved={onSaved} onEdit={onEdit} />;
  return <CodeBody path={path} onSaved={onSaved} onEdit={onEdit} reveal={reveal} />;
}

// `save_text_file` matches `read_text_file`'s guard: a file is editable iff
// the text read succeeds — ≤ this many bytes, UTF-8, no NUL. Larger/binary
// files stay on the (paged) read-only CodeView.
const EDITABLE_MAX_BYTES = 2 * 1024 * 1024;

/** What a finished prepare hands the render: the file it was for, the
 *  pre-loaded content+grammar, and the editor component out of the awaited
 *  chunk (rendered directly — no lazy/Suspense in the edit path). */
interface EditPayload {
  path: string;
  prep: PreparedEdit;
  Editor: (typeof import("./CodeEditor"))["default"];
}

// Code files: CodeView stays the read surface for the whole life of the file;
// Edit overlays a fully *prepared* CodeMirror editor above it in one commit —
// chunk imported + text read + grammar resolved first (lib/editSwap.ts holds
// the race rules) — so the swap never paints a blank or uncolored frame. Done
// unmounts the overlay over the still-painted view: flicker-free both ways.
// Editability is decided from the meta CodeView already loads (size / binary),
// so no extra read is needed to enable the button.
function CodeBody({
  path,
  onSaved,
  onEdit,
  reveal = null,
}: {
  path: string;
  onSaved?: (path: string) => void;
  onEdit?: () => void;
  reveal?: { line: number; at?: number } | null;
}) {
  const [swap, dispatch] = useReducer(
    (s: EditSwapState<EditPayload>, e: EditSwapEvent<EditPayload>) =>
      reduceEditSwap(s, e),
    initialEditSwap as EditSwapState<EditPayload>,
  );
  const seqRef = useRef(0);
  const [meta, setMeta] = useState<DocMeta | null>(null);
  // Read-view scroll offset, mirrored by CodeView on every scroll — seeds the
  // editor so entering edit mode keeps the same lines on screen (both surfaces
  // share the 18px line grid and 16px top padding).
  const scrollPosRef = useRef(0);

  // Switching files leaves edit mode — the buffer belongs to the old file —
  // invalidates any in-flight prepare, and forgets meta until the new file
  // reports in.
  useEffect(() => {
    seqRef.current++;
    dispatch({ type: "path-changed" });
    setMeta(null);
  }, [path]);

  // Delayed "Opening…" label: a warm chunk + normal file prepares well under
  // LOADING_DELAY_MS, so the common path shows nothing at all.
  const preparing = swap.mode === "preparing";
  const [showOpening, setShowOpening] = useState(false);
  useEffect(() => {
    if (!preparing) {
      setShowOpening(false);
      return;
    }
    const t = setTimeout(() => setShowOpening(true), LOADING_DELAY_MS);
    return () => clearTimeout(t);
  }, [preparing]);

  const editable = !!meta && !meta.isBinary && meta.size <= EDITABLE_MAX_BYTES;
  const editTitle = !meta
    ? "Edit this file"
    : meta.isBinary
      ? "Binary file — not editable"
      : meta.size > EDITABLE_MAX_BYTES
        ? "Too large to edit (2 MB cap)"
        : "Edit this file";

  const beginEdit = () => {
    if (swap.mode !== "view") return;
    onEdit?.();
    const seq = ++seqRef.current;
    dispatch({ type: "edit", seq });
    void codeEditorImport()
      .then((mod) =>
        mod.prepareEdit(path).then((prep) =>
          dispatch({
            type: "prepared",
            seq,
            payload: { path, prep, Editor: mod.default },
          }),
        ),
      )
      .catch((e) =>
        dispatch({ type: "prepare-failed", seq, error: String(e) }),
      );
  };

  // Render guard on payload.path covers the one frame between a path change
  // and its effect dispatching `path-changed`.
  const editorOn = swap.mode === "editing" && swap.payload.path === path;

  return (
    <div className="relative h-full min-h-0">
      {/* The read column stays mounted while editing — its ResizeObserver,
          scroll position and live-reload subscription keep working under the
          overlay — but goes inert so the covered controls can't take focus. */}
      <div
        className="flex flex-col h-full min-h-0"
        inert={editorOn || undefined}
      >
        <div
          className="flex items-center justify-end gap-2 px-6 py-1.5 shrink-0"
          style={{ fontSize: "12px", borderBottom: "1px solid var(--color-rule)" }}
        >
          {swap.mode === "view" && swap.error && (
            <span
              className="truncate"
              style={{ color: "var(--color-warning)", marginRight: "auto" }}
              title={swap.error}
            >
              {swap.error}
            </span>
          )}
          <span title={editTitle} onMouseEnter={preloadCodeEditor}>
            <EditBtn
              onClick={beginEdit}
              disabled={!editable || swap.mode !== "view"}
            >
              {preparing && showOpening ? "Opening…" : "Edit"}
            </EditBtn>
          </span>
        </div>
        <div className="flex-1 min-h-0">
          {/* Blank (not a "Loading…" notice) while the chunk loads: it's
              preloaded on explorer open so this rarely shows, and a silent hold
              avoids stacking a second flash on CodeView's own loader. */}
          <Suspense
            fallback={
              <div className="h-full w-full" style={{ background: "var(--color-paper)" }} />
            }
          >
            <CodeView path={path} onMeta={setMeta} scrollPosRef={scrollPosRef} reveal={reveal} />
          </Suspense>
        </div>
      </div>
      {editorOn && (
        // The editor paints opaque over the view; in any frame before its
        // first paint the user simply keeps seeing the highlighted read view.
        <div className="absolute inset-0">
          <swap.payload.Editor
            path={path}
            prepared={swap.payload.prep}
            initialScrollTop={scrollPosRef.current}
            onDone={() => dispatch({ type: "done" })}
            onSaved={onSaved}
          />
        </div>
      )}
    </div>
  );
}

// Markdown is read whole and rendered rich. Markdown files are small in
// practice, so the 2 MB `read_text_file` cap (and its too-large/binary flags)
// is the right guard here. Loads are stale-while-revalidate: the prior file's
// content stays on screen until the new one resolves, so switching never flashes
// a blank "Loading…" frame (the same anti-flicker contract as CodeView).
function MarkdownBody({
  path,
  onSaved,
  onEdit,
}: {
  path: string;
  onSaved?: (path: string) => void;
  onEdit?: () => void;
}) {
  const [displayed, setDisplayed] = useState<{ path: string; file: FileContent } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  // In-place editing of the raw markdown. `draft` lives independently of the
  // rendered `displayed`, so an fs-change reload (including our own save echo)
  // never clobbers what's in the textarea.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const latestPath = useRef(path);
  // The disk moving under an open edit: what the edit started from, and the
  // newer disk text behind the banner (W4).
  const editingRef = useRef(false);
  editingRef.current = editing;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editBaseRef = useRef<string | null>(null);
  const [conflict, setConflict] = useState<DiskChange | null>(null);
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    latestPath.current = path;
    setError(null);
    // Switching files leaves edit mode — the draft belongs to the old file.
    setEditing(false);
    setConflict(null);
    setComparing(false);
  }, [path]);

  const load = useCallback(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await invoke<FileContent>("read_text_file", { path });
        if (cancelled || latestPath.current !== path) return;
        setDisplayed({ path, file: result });
        setError(null);
        const disk = result.content;
        if (editingRef.current && disk != null && disk !== editBaseRef.current && disk !== draftRef.current) {
          setConflict({ content: disk, at: Date.now() });
        }
      } catch (e) {
        if (!cancelled && latestPath.current === path) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => load(), [load]);
  useLiveFile(path, load);

  const fresh = displayed?.path === path;
  const view = showLoading && !fresh ? null : displayed;

  useEffect(() => {
    if (fresh) {
      setShowLoading(false);
      return;
    }
    setShowLoading(false);
    const t = setTimeout(() => setShowLoading(true), LOADING_DELAY_MS);
    return () => clearTimeout(t);
  }, [fresh, path]);

  if (!view) {
    if (showLoading) {
      return <Notice>{error ? "Couldn’t read this file." : "Loading…"}</Notice>;
    }
    if (!displayed && error) return <Notice>Couldn’t read this file.</Notice>;
    return <div className="h-full w-full" style={{ background: "var(--color-paper)" }} />;
  }

  const file = view.file;
  if (file.tooLarge) {
    return (
      <Notice>
        File is too large to preview ({Math.round(file.size / 1024)} KB).
      </Notice>
    );
  }
  if (file.isBinary) return <Notice>Binary file — no preview.</Notice>;

  const beginEdit = () => {
    onEdit?.();
    editBaseRef.current = file.content ?? "";
    setDraft(file.content ?? "");
    setConflict(null);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await invoke<string>("save_text_file", {
        path,
        content: draft,
      });
      // Reflect the save immediately; the fswatch echo will re-read the same
      // bytes a moment later, which is a no-op.
      setDisplayed({ path, file: { ...file, content: draft } });
      editBaseRef.current = draft;
      setConflict(null);
      setComparing(false);
      setEditing(false);
      onSaved?.(saved);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center justify-end gap-2 px-6 pt-3"
        style={{ fontSize: "12px" }}
      >
        {editing ? (
          <>
            <EditBtn onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </EditBtn>
            <EditBtn onClick={() => void save()} disabled={saving} primary>
              {saving ? "Saving…" : "Save"}
            </EditBtn>
          </>
        ) : (
          <EditBtn onClick={beginEdit}>Edit</EditBtn>
        )}
      </div>
      {editing && conflict && (
        <div className="mx-6 mt-2" style={{ border: "1px solid var(--color-rule)", borderRadius: "6px", overflow: "hidden" }}>
          <DiskChangeBanner
            change={conflict}
            comparing={comparing}
            busy={saving}
            onCompare={() => setComparing((c) => !c)}
            onKeep={() => {
              editBaseRef.current = conflict.content;
              setConflict(null);
              setComparing(false);
            }}
            onReload={() => {
              editBaseRef.current = conflict.content;
              setDraft(conflict.content);
              setConflict(null);
              setComparing(false);
            }}
            onOverwrite={() => void save()}
          />
          {comparing && <DiskCompare disk={conflict.content} buffer={draft} />}
        </div>
      )}
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
              e.preventDefault();
              void save();
            }
          }}
          spellCheck={false}
          autoFocus
          className="rl-thin-scroll-y flex-1 mx-6 mb-6 mt-2 p-3 font-mono"
          style={{
            fontSize: "13px",
            lineHeight: 1.6,
            resize: "none",
            background: "var(--color-bg-elevated)",
            color: "var(--color-ink)",
            border: "1px solid var(--color-rule)",
            borderRadius: "4px",
            outline: "none",
          }}
        />
      ) : (
        <div className="rl-prose px-6 pb-6 pt-2" style={{ maxWidth: "820px" }}>
          <MarkdownView body={file.content ?? ""} />
        </div>
      )}
    </div>
  );
}

function EditBtn({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-sm px-2 py-0.5"
      style={{
        fontSize: "12px",
        lineHeight: 1.4,
        border: "1px solid var(--color-rule)",
        background: primary
          ? "var(--color-anchor-bg)"
          : "var(--color-bg-elevated)",
        color: primary ? "var(--color-anchor-text)" : "var(--color-ink)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
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

/** Memoized: the viewer is one of the center-pane surfaces that used to
 *  reconcile on every frame of a divider drag. */
export const FileViewer = memo(FileViewerBase);
