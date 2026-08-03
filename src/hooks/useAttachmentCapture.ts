// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import type { CommentAttachment } from "../types";

/** Drag-and-drop + paste capture for a composer, backed by the two Rust
 *  commands that copy the file into app data.
 *
 *  Two things make this non-obvious:
 *
 *  1. **HTML5 `onDrop` never fires in this app.** `tauri.conf.json` doesn't set
 *     `dragDropEnabled`, so it defaults to `true` and the webview swallows OS
 *     file drops before the DOM sees them. The working precedent is
 *     `TerminalView`'s `getCurrentWebview().onDragDropEvent(...)`, which also
 *     hands us real absolute paths — exactly what we want to copy from.
 *
 *  2. **That event is webview-global**, so every listener hears every drop.
 *     Each composer hit-tests the pointer against its own host element, the
 *     same way TerminalView does. Heed its comment: wry reports the position in
 *     logical points that already match CSS pixels, so do NOT divide by
 *     `devicePixelRatio` — on a Retina display that halves the coordinate and
 *     rejects any target not pinned to the top-left.
 *
 *  Pasted files have no path at all (they're clipboard bytes), so they take the
 *  base64 route instead.
 */
export function useAttachmentCapture(sessionId: string) {
  const [attachments, setAttachments] = useState<CommentAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** True while a drop is being copied — the drop zone shows it's working. */
  const [busy, setBusy] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** Highlight the drop zone while a drag hovers over it. */
  const [dragOver, setDragOver] = useState(false);

  const add = useCallback((a: CommentAttachment) => {
    setAttachments((prev) =>
      // The same file dropped twice is one attachment, not two.
      prev.some((p) => p.path === a.path) ? prev : [...prev, a],
    );
  }, []);

  const remove = useCallback((path: string) => {
    // The copy in app data is deliberately left on disk: the comment may
    // already reference it, and orphans are swept when the session is deleted.
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  }, []);

  const clear = useCallback(() => setAttachments([]), []);

  /** Is this pointer position inside our host element? */
  const isOverHost = useCallback((x: number, y: number) => {
    const h = hostRef.current;
    if (!h) return false;
    const r = h.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "leave") {
          setDragOver(false);
          return;
        }
        if (p.type === "over") {
          setDragOver(isOverHost(p.position.x, p.position.y));
          return;
        }
        if (p.type !== "drop") return;
        setDragOver(false);
        if (!isOverHost(p.position.x, p.position.y)) return;
        const paths = p.paths ?? [];
        if (paths.length === 0) return;
        setBusy(true);
        setError(null);
        void (async () => {
          for (const srcPath of paths) {
            try {
              const saved = await invoke<CommentAttachment>(
                "import_attachment",
                { sessionId, srcPath },
              );
              add(saved);
            } catch (e) {
              setError(String(e));
            }
          }
          setBusy(false);
        })();
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {
        /* no webview (tests) — paste still works */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId, add, isOverHost]);

  /** `onPaste` for the composer's textarea: pick up clipboard files/images. */
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files: File[] = [];
      for (const item of Array.from(e.clipboardData?.items ?? [])) {
        if (item.kind !== "file") continue;
        const f = item.getAsFile();
        if (f) files.push(f);
      }
      if (files.length === 0) return;
      // Only swallow the paste once we know there's a file on the clipboard —
      // pasting text into the composer must keep working normally.
      e.preventDefault();
      setBusy(true);
      setError(null);
      void (async () => {
        for (const f of files) {
          try {
            const base64Data = await fileToBase64(f);
            const saved = await invoke<CommentAttachment>("save_attachment", {
              sessionId,
              // A pasted screenshot often has no name at all.
              filename: f.name || `pasted-${extensionFor(f.type)}`,
              base64Data,
            });
            add(saved);
          } catch (err) {
            setError(String(err));
          }
        }
        setBusy(false);
      })();
    },
    [sessionId, add],
  );

  return {
    attachments,
    setAttachments,
    remove,
    clear,
    onPaste,
    hostRef,
    dragOver,
    busy,
    error,
    dismissError: () => setError(null),
  };
}

/** A plausible filename suffix for a clipboard image with no name. */
function extensionFor(mime: string): string {
  const sub = mime.split("/")[1] ?? "bin";
  return sub === "jpeg" ? "image.jpg" : `image.${sub}`;
}

/** Read a `File` as bare base64 (no `data:` prefix) for `save_attachment`. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      // FileReader hands back `data:<mime>;base64,<payload>`; Rust wants the
      // payload alone.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
