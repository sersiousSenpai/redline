// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit } from "@codemirror/language";
import type { LanguageSupport } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";

import type { FileContent } from "../types";
import { useLiveFile } from "../hooks/useFsWatch";
import {
  languageForPath,
  prepareEditContent,
  resolveDiskChange,
  saveKeyBinding,
} from "../lib/codeEditor";
import { redlineCmTheme } from "./cmTheme";

/** Everything the editor needs to mount already-highlighted: raw text and the
 *  resolved grammar (null = no grammar / grammar chunk failed → plain). */
export interface PreparedEdit {
  content: string;
  language: LanguageSupport | null;
}

/** Load a file for editing: text + grammar in parallel, before the editor
 *  mounts — so its first painted frame is highlighted. Rejects for unreadable
 *  or non-editable (too large / binary) files; the caller stays in the read
 *  view and shows the message. */
export function prepareEdit(path: string): Promise<PreparedEdit> {
  const desc = languageForPath(path);
  return prepareEditContent<LanguageSupport>(
    () => invoke<FileContent>("read_text_file", { path }),
    desc ? () => desc.load() : null,
  );
}

interface CodeEditorProps {
  /** Absolute path being edited. */
  path: string;
  /** Pre-loaded content + grammar (see `prepareEdit`) — the editor itself
   *  never fetches on mount. */
  prepared: PreparedEdit;
  /** Scroll offset carried over from the read view (same 18px line grid). */
  initialScrollTop?: number;
  /** Leave edit mode (back to the read-only CodeView). */
  onDone: () => void;
  /** Called with the saved path after a successful write. */
  onSaved?: (path: string) => void;
}

// A real editor for code files in the folder viewer (markdown keeps its
// textarea path in FileViewer). Mounts *prepared* — content and grammar were
// loaded by `prepareEdit` before this component ever rendered, so the first
// painted frame is the full highlighted document (the read view beneath stays
// visible until then; see CodeBody's overlay swap). Saves via
// `save_text_file`, and reconciles external edits: own-save echoes no-op,
// disk changes under a clean buffer silently reload (CodeView's live-reload
// contract), disk changes under a dirty buffer raise a banner. No merge —
// Save is last-writer-wins.
function CodeEditor({
  path,
  prepared,
  initialScrollTop,
  onDone,
  onSaved,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** The content as of the last load/save — the dirty + echo baseline. */
  const savedRef = useRef<string>("");
  const latestPath = useRef(path);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Disk content waiting behind the conflict banner (dirty buffer). */
  const [conflict, setConflict] = useState<string | null>(null);

  const isDirty = useCallback(() => {
    const view = viewRef.current;
    return !!view && view.state.doc.toString() !== savedRef.current;
  }, []);

  const save = useCallback(() => {
    const view = viewRef.current;
    if (!view || latestPath.current !== path) return;
    const content = view.state.doc.toString();
    setSaving(true);
    void invoke<string>("save_text_file", { path, content })
      .then((saved) => {
        savedRef.current = content;
        setDirty(false);
        setConflict(null);
        setError(null);
        onSaved?.(saved);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setSaving(false));
  }, [path, onSaved]);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Build the editor over the prepared content. A layout effect with zero IPC:
  // the view exists (with its grammar already in the compartment) before the
  // browser paints, so there is never an empty or uncolored frame — and the
  // StrictMode double-mount is just a local build/destroy/build, invisible.
  useLayoutEffect(() => {
    latestPath.current = path;
    setError(null);
    setDirty(false);
    setConflict(null);
    if (!hostRef.current) return;
    savedRef.current = prepared.content;
    // Kept as a Compartment so a future live-reconfigure (e.g. retrying a
    // failed grammar) stays a one-line dispatch.
    const langCompartment = new Compartment();

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: prepared.content,
        extensions: [
          // ⌘S must win over everything (and over WebKit's own dialog).
          Prec.high(keymap.of([saveKeyBinding(() => saveRef.current())])),
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          indentUnit.of("    "),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          langCompartment.of(prepared.language ?? []),
          redlineCmTheme(),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              setDirty(u.state.doc.toString() !== savedRef.current);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (initialScrollTop) view.scrollDOM.scrollTop = initialScrollTop;
    view.focus();

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // initialScrollTop is a mount-time seed, not a controlled value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, prepared]);

  // External edits while the editor is open.
  const onDiskChange = useCallback(() => {
    void invoke<FileContent>("read_text_file", { path })
      .then((f) => {
        const view = viewRef.current;
        if (!view || latestPath.current !== path) return;
        if (f.tooLarge || f.isBinary || f.content == null) return;
        const res = resolveDiskChange({
          dirty: isDirty(),
          disk: f.content,
          saved: savedRef.current,
        });
        if (res === "ignore") return;
        if (res === "reload") {
          savedRef.current = f.content;
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: f.content },
          });
          setDirty(false);
        } else {
          setConflict(f.content);
        }
      })
      .catch(() => {});
  }, [path, isDirty]);
  useLiveFile(path, onDiskChange);

  const takeDisk = useCallback(() => {
    const view = viewRef.current;
    if (!view || conflict == null) return;
    savedRef.current = conflict;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: conflict },
    });
    setDirty(false);
    setConflict(null);
  }, [conflict]);

  const btn = (primary?: boolean): React.CSSProperties => ({
    fontSize: "12px",
    lineHeight: 1.4,
    border: "1px solid var(--color-rule)",
    background: primary ? "var(--color-anchor-bg)" : "var(--color-bg-elevated)",
    color: primary ? "var(--color-anchor-text)" : "var(--color-ink)",
    cursor: "pointer",
    borderRadius: "3px",
    padding: "2px 8px",
  });

  return (
    // Opaque as a whole (not just the host div): this component renders as an
    // overlay above the still-mounted read view, which must never show through.
    // py-1.5 matches CodeBody's toolbar row exactly — same buttons, same
    // padding — so entering/leaving edit mode can't move the content top.
    <div
      className="flex flex-col h-full min-h-0"
      style={{ background: "var(--color-paper)" }}
    >
      <div
        className="flex items-center justify-end gap-2 px-6 py-1.5 shrink-0"
        style={{ fontSize: "12px", borderBottom: "1px solid var(--color-rule)" }}
      >
        {error && (
          <span
            className="truncate"
            style={{ color: "var(--color-warning)", marginRight: "auto" }}
            title={error}
          >
            {error}
          </span>
        )}
        {dirty && !error && (
          <span
            aria-label="Unsaved changes"
            title="Unsaved changes (⌘S to save)"
            style={{ color: "var(--color-ink-muted)", marginRight: "auto" }}
          >
            ● edited
          </span>
        )}
        <button type="button" onClick={onDone} disabled={saving} style={btn()}>
          {dirty ? "Discard & close" : "Done"}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          title="Save (⌘S)"
          style={{ ...btn(true), opacity: saving ? 0.6 : 1 }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {conflict != null && (
        <div
          className="flex items-center gap-2 px-6 py-1.5 shrink-0"
          style={{
            fontSize: "12px",
            color: "var(--color-ink)",
            background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
            borderBottom: "1px solid var(--color-rule)",
          }}
        >
          <span style={{ flex: 1 }}>
            File changed on disk while you were editing.
          </span>
          <button type="button" onClick={takeDisk} style={btn()}>
            Reload
          </button>
          <button
            type="button"
            onClick={() => setConflict(null)}
            title="Keep your buffer — Save overwrites the disk version"
            style={btn()}
          >
            Keep editing
          </button>
        </div>
      )}
      <div
        ref={hostRef}
        className="flex-1 min-h-0 overflow-hidden"
        style={{ background: "var(--color-paper)" }}
      />
    </div>
  );
}

/** Memoized: CodeMirror builds its view in a content-keyed effect, so this
 *  spares reconciliation without ever tearing the editor down. */
export default memo(CodeEditor);
