// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { BinaryFile, FileContent } from "../types";
import { useLiveFile } from "../hooks/useFsWatch";
import { MarkdownView } from "./MarkdownView";

// Don't flash a loading notice for reads faster than this; markdown files resolve
// well under it, so switching between them shows no flicker. Mirrors CodeView.
const LOADING_DELAY_MS = 120;

// The code viewer is a separate chunk; keep it out of the initial bundle but
// preload it as soon as the folder explorer is shown (see `preloadCodeView`), so
// the first file click never waits on the chunk — which would stack a Suspense
// "Loading…" on top of CodeView's own load (the "double flash").
const codeViewImport = () => import("./CodeView");
const CodeView = lazy(codeViewImport);

let codeViewPreloaded: Promise<unknown> | null = null;
/** Warm the CodeView chunk ahead of the first open. Idempotent; the bundler
 *  dedupes this with the `lazy()` import so they share one fetch. */
export function preloadCodeView(): void {
  if (!codeViewPreloaded) codeViewPreloaded = codeViewImport();
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
export function FileViewer({ path, onClose, onSaved }: FileViewerProps) {
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
          <TextBody path={path} onSaved={onSaved} />
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
  return (
    <div className="flex items-start justify-center p-6">
      <img
        src={`data:${mime};base64,${file.data}`}
        alt={basename(path)}
        style={{
          maxWidth: "100%",
          height: "auto",
          // Checkerboard so transparent PNGs are legible on any theme.
          background:
            "repeating-conic-gradient(var(--color-bg-elevated) 0% 25%, transparent 0% 50%) 50% / 16px 16px",
          boxShadow: "0 1px 6px rgba(0,0,0,0.25)",
        }}
      />
    </div>
  );
}

// Markdown renders rich (full read); everything else goes to the virtualized,
// off-thread-tokenized code viewer so a large file never freezes the UI.
function TextBody({
  path,
  onSaved,
}: {
  path: string;
  onSaved?: (path: string) => void;
}) {
  if (isMarkdown(path)) return <MarkdownBody path={path} onSaved={onSaved} />;
  return (
    // Blank (not a "Loading…" notice) while the chunk loads: it's preloaded on
    // explorer open so this rarely shows, and a silent hold avoids stacking a
    // second flash on CodeView's own (delayed, content-preserving) loader.
    <Suspense fallback={<div className="h-full w-full" style={{ background: "var(--color-paper)" }} />}>
      <CodeView path={path} />
    </Suspense>
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
}: {
  path: string;
  onSaved?: (path: string) => void;
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

  useEffect(() => {
    latestPath.current = path;
    setError(null);
    // Switching files leaves edit mode — the draft belongs to the old file.
    setEditing(false);
  }, [path]);

  const load = useCallback(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await invoke<FileContent>("read_text_file", { path });
        if (cancelled || latestPath.current !== path) return;
        setDisplayed({ path, file: result });
        setError(null);
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
    setDraft(file.content ?? "");
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
