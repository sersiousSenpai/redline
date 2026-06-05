// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { BinaryFile, FileContent } from "../types";
import { subscribeFsChange } from "../hooks/useFsWatch";
import { MarkdownView } from "./MarkdownView";

// highlight.js + its language grammars are weighty; keep them out of the
// initial bundle until the user actually opens a code file.
const CodeView = lazy(() => import("./CodeView"));

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
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "/";
}

// Watch the open file's directory for the viewer's lifetime and re-run `reload`
// when the file itself changes on disk, so edits show without reopening. The
// directory may already be watched by the tree; the backend refcounts so this
// extra watch is safe and guarantees coverage even if the tree dir is collapsed.
function useLiveFile(path: string, reload: () => void): void {
  useEffect(() => {
    const dir = dirname(path);
    void invoke("watch_dir", { path: dir }).catch(() => {});
    const unsubscribe = subscribeFsChange(path, reload);
    return () => {
      unsubscribe();
      void invoke("unwatch_dir", { path: dir }).catch(() => {});
    };
  }, [path, reload]);
}

function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

// Read-only viewer for a single file picked from the FileTree. Images render
// inline; markdown renders rich; everything else shows syntax-highlighted
// source. Oversized files report why they weren't loaded.
export function FileViewer({ path, onClose }: FileViewerProps) {
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
          <TextBody path={path} />
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

// Loads and renders a text file: markdown rich, everything else as highlighted
// source. Binary (non-image) and oversized files report why instead of choking.
function TextBody({ path }: { path: string }) {
  const [file, setFile] = useState<FileContent | null>(null);
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
          const result = await invoke<FileContent>("read_text_file", { path });
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

  if (error) return <Notice>Couldn’t read this file.</Notice>;
  if (file === null) return <Notice>Loading…</Notice>;
  if (file.tooLarge) {
    return (
      <Notice>
        File is too large to preview ({Math.round(file.size / 1024)} KB).
      </Notice>
    );
  }
  if (file.isBinary) return <Notice>Binary file — no preview.</Notice>;
  const content = file.content ?? "";
  if (isMarkdown(path)) {
    return (
      <div className="rl-prose px-6 py-6" style={{ maxWidth: "820px" }}>
        <MarkdownView body={content} />
      </div>
    );
  }
  return (
    <Suspense fallback={<Notice>Loading…</Notice>}>
      <CodeView content={content} filename={basename(path)} />
    </Suspense>
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
