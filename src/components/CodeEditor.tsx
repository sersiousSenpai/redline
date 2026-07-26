// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
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
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";

import type { FileContent } from "../types";
import { useLiveFile } from "../hooks/useFsWatch";
import {
  languageForPath,
  resolveDiskChange,
  saveKeyBinding,
} from "../lib/codeEditor";
import { redlineCmTheme } from "./cmTheme";

interface CodeEditorProps {
  /** Absolute path being edited. */
  path: string;
  /** Leave edit mode (back to the read-only CodeView). */
  onDone: () => void;
  /** Called with the saved path after a successful write. */
  onSaved?: (path: string) => void;
}

// A real editor for code files in the folder viewer (markdown keeps its
// textarea path in FileViewer). Loads via `read_text_file` (≤2 MiB, UTF-8),
// resolves the language grammar async through a Compartment (the editor is
// usable immediately; colors pop in when the per-language chunk lands), saves
// via `save_text_file`, and reconciles external edits: own-save echoes no-op,
// disk changes under a clean buffer silently reload (CodeView's live-reload
// contract), disk changes under a dirty buffer raise a banner. No merge —
// Save is last-writer-wins.
export default function CodeEditor({ path, onDone, onSaved }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** The content as of the last load/save — the dirty + echo baseline. */
  const savedRef = useRef<string>("");
  const latestPath = useRef(path);
  const [ready, setReady] = useState(false);
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

  // Build the editor: load the file, then mount a view over it. Torn down and
  // rebuilt on a path change (stale-guarded like MarkdownBody's loads).
  useEffect(() => {
    latestPath.current = path;
    setReady(false);
    setError(null);
    setDirty(false);
    setConflict(null);
    let cancelled = false;
    const langCompartment = new Compartment();

    void invoke<FileContent>("read_text_file", { path })
      .then((f) => {
        if (cancelled || latestPath.current !== path || !hostRef.current) return;
        if (f.tooLarge || f.isBinary || f.content == null) {
          setError(
            f.tooLarge
              ? "File is too large to edit (2 MB cap)."
              : "Binary file — not editable.",
          );
          return;
        }
        savedRef.current = f.content;

        const view = new EditorView({
          parent: hostRef.current,
          state: EditorState.create({
            doc: f.content,
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
              langCompartment.of([]),
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
        setReady(true);
        view.focus();

        // Grammar: resolved async via the Compartment — the editor is live
        // right away, colors arrive when the language chunk loads.
        const desc = languageForPath(path);
        if (desc) {
          void desc.load().then((support) => {
            if (!cancelled && viewRef.current === view) {
              view.dispatch({
                effects: langCompartment.reconfigure(support),
              });
            }
          });
        }
      })
      .catch((e) => {
        if (!cancelled && latestPath.current === path) setError(String(e));
      });

    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [path]);

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
    <div className="flex flex-col h-full min-h-0">
      <div
        className="flex items-center justify-end gap-2 px-6 py-2 shrink-0"
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
          disabled={saving || !ready}
          title="Save (⌘S)"
          style={{ ...btn(true), opacity: saving || !ready ? 0.6 : 1 }}
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
