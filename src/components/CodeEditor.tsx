// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import {
  AUTO_SAVE_DELAY_MS,
  AUTO_SAVE_MAX_BYTES,
  createAutoSaveTimer,
  shouldAutoSave,
  useAutoSaveMode,
  utf8Bytes,
  type AutoSaveTrigger,
} from "../lib/autoSave";
import { redlineCmTheme } from "./cmTheme";
import { DiskChangeBanner, DiskCompare, type DiskChange } from "./DiskChangeBanner";

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
  /** Called with the saved path after a deliberate save (⌘S, Save,
   *  Overwrite). An auto-save shows its own quiet "Saved" instead. */
  onSaved?: (path: string) => void;
}

/** How long the "Saved" acknowledgement holds before it fades. */
const SAVED_FLASH_MS = 1200;

// A real editor for code files in the folder viewer (markdown keeps its
// textarea path in FileViewer). Mounts *prepared* — content and grammar were
// loaded by `prepareEdit` before this component ever rendered, so the first
// painted frame is the full highlighted document (the read view beneath stays
// visible until then; see CodeBody's overlay swap). Saves via
// `save_text_file`, and reconciles external edits: own-save echoes no-op,
// disk changes under a clean buffer silently reload (CodeView's live-reload
// contract), disk changes under a dirty buffer raise a banner. No merge —
// Save is last-writer-wins.
//
// Auto-save (Settings ▸ Auto-save, lib/autoSave.ts) writes after a second's
// pause or on leaving the editor. It never writes over a disk change: the
// banner, a Compare, or a change answered with Keep editing pause it until a
// deliberate save, and every auto-save re-reads the disk first so a change the
// watcher has not reported yet raises the banner instead.
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
  /** Bumped as each editor view goes away: a write that outlives its view
   *  (a leave-save on unmount, a file switch mid-write) still lands on disk
   *  but touches no state of the next one. */
  const epochRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  /** Disk content waiting behind the conflict banner (dirty buffer). */
  const [conflict, setConflict] = useState<DiskChange | null>(null);
  /** Compare: the buffer as it was when Compare was pressed, against disk. */
  const [comparing, setComparing] = useState<string | null>(null);
  /** The disk moved under this buffer and no deliberate save answered it. */
  const [diverged, setDiverged] = useState(false);
  /** The buffer is past save_text_file's cap: manual save only. */
  const [large, setLarge] = useState(false);
  const [mode] = useAutoSaveMode();
  /** What the auto-save policy reads, current as of the last render. */
  const live = useRef({ mode, conflict: false, comparing: false, diverged: false });
  live.current = { mode, conflict: conflict != null, comparing: comparing != null, diverged };
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  const isDirty = useCallback(() => {
    const view = viewRef.current;
    return !!view && view.state.doc.toString() !== savedRef.current;
  }, []);

  /** Write `content` to `at`. `auto` writes skip `onSaved` (no toast per
   *  pause); a failure keeps the buffer dirty and shows the one-liner. */
  const write = useCallback((at: string, content: string, auto: boolean, epoch: number) => {
    const attached = () => epochRef.current === epoch;
    if (attached()) {
      savingRef.current = true;
      setSaving(true);
    }
    return invoke<string>("save_text_file", { path: at, content })
      .then((saved) => {
        if (!auto) onSaved?.(saved);
        if (!attached()) return;
        savedRef.current = content;
        const now = viewRef.current?.state.doc.toString();
        setDirty(now != null && now !== content);
        setConflict(null);
        setComparing(null);
        setDiverged(false);
        setError(null);
        setFlash(true);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlash(false), SAVED_FLASH_MS);
        // Typed during the write: the debounce takes it from here.
        if (now != null && now !== content && live.current.mode === "delay") timer.edited();
      })
      .catch((e) => {
        if (attached()) setError(String(e));
      })
      .finally(() => {
        if (!attached()) return;
        savingRef.current = false;
        setSaving(false);
      });
    // `timer` is stable (created once below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSaved]);

  const save = useCallback(() => {
    const view = viewRef.current;
    if (!view || latestPath.current !== path) return;
    timer.cancel();
    void write(path, view.state.doc.toString(), false, epochRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, write]);
  const saveRef = useRef(save);
  saveRef.current = save;

  /** The auto-save: the policy, then a fresh read of the disk, then the
   *  write — or the banner, when the disk moved since the last read. */
  const autoSave = useCallback((trigger: AutoSaveTrigger, epoch = epochRef.current) => {
    const view = viewRef.current;
    if (!view) return;
    const at = latestPath.current;
    const content = view.state.doc.toString();
    const base = savedRef.current;
    const ok = shouldAutoSave({
      ...live.current,
      trigger,
      dirty: content !== base,
      saving: savingRef.current,
      bytes: utf8Bytes(content),
    });
    if (!ok) return;
    const attached = () => epochRef.current === epoch;
    savingRef.current = true;
    void invoke<FileContent>("read_text_file", { path: at })
      .then((f) => {
        if (f.tooLarge || f.isBinary || f.content == null) {
          throw new Error("Auto-save paused: the file on disk is no longer editable text. ⌘S to save anyway.");
        }
        if (f.content === base) return write(at, content, true, epoch);
        // The disk moved since the last read: never overwrite it.
        if (!attached()) return;
        savingRef.current = false;
        if (f.content === content) {
          savedRef.current = content;
          setDirty(viewRef.current?.state.doc.toString() !== content);
          return;
        }
        setDiverged(true);
        setConflict({ content: f.content, at: Date.now() });
      })
      .catch((e) => {
        if (!attached()) return;
        savingRef.current = false;
        setError(e instanceof Error ? e.message : `Auto-save paused: ${String(e)}`);
      });
  }, [write]);
  const autoSaveRef = useRef(autoSave);
  autoSaveRef.current = autoSave;
  const [timer] = useState(() =>
    createAutoSaveTimer({ delayMs: AUTO_SAVE_DELAY_MS, fire: (t) => autoSaveRef.current(t) }),
  );

  // Turning auto-save off mid-edit drops a pending write; turning it on
  // starts the clock on edits already in the buffer.
  useEffect(() => {
    if (mode === "delay" && isDirty()) timer.edited();
    else if (mode !== "delay") timer.cancel();
  }, [mode, timer, isDirty]);

  // Leaving the window (another app, a hidden window) is a focus change too.
  useEffect(() => {
    const leave = () => timer.left();
    const hidden = () => {
      if (document.visibilityState === "hidden") timer.left();
    };
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [timer]);

  // Build the editor over the prepared content. A layout effect with zero IPC:
  // the view exists (with its grammar already in the compartment) before the
  // browser paints, so there is never an empty or uncolored frame — and the
  // StrictMode double-mount is just a local build/destroy/build, invisible.
  useLayoutEffect(() => {
    latestPath.current = path;
    setError(null);
    setDirty(false);
    setConflict(null);
    setComparing(null);
    setDiverged(false);
    setLarge(false);
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
              const text = u.state.doc.toString();
              const nowDirty = text !== savedRef.current;
              setDirty(nowDirty);
              setLarge(utf8Bytes(text) > AUTO_SAVE_MAX_BYTES);
              if (!nowDirty) timer.cancel();
              else if (live.current.mode === "delay") timer.edited();
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    // Focus leaving the editor (its own search panel aside): a pane or tab
    // switch, a click into the rail, the Done button.
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget;
      if (next instanceof Node && view.dom.contains(next)) return;
      timer.left();
    };
    view.dom.addEventListener("focusout", onFocusOut);
    if (initialScrollTop) view.scrollDOM.scrollTop = initialScrollTop;
    view.focus();

    return () => {
      view.dom.removeEventListener("focusout", onFocusOut);
      // The editor going away (Done, a file switch, the pane closing) is the
      // last focus change: a leave-save that outlives the view.
      timer.cancel();
      autoSaveRef.current("leave");
      epochRef.current++;
      savingRef.current = false;
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
          // The banner shows and auto-save pauses until a deliberate save
          // (Keep editing clears the banner, not the pause).
          timer.cancel();
          setDiverged(true);
          setConflict({ content: f.content, at: Date.now() });
        }
      })
      .catch(() => {});
  }, [path, isDirty, timer]);
  useLiveFile(path, onDiskChange);

  const takeDisk = useCallback(() => {
    const view = viewRef.current;
    if (!view || conflict == null) return;
    savedRef.current = conflict.content;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: conflict.content },
    });
    setDirty(false);
    setConflict(null);
    setComparing(null);
    setDiverged(false);
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

  /** Leaving now would auto-save (Done reads "Done", not "Discard"). */
  const leaveSaves = mode !== "off" && conflict == null && comparing == null && !diverged && !large;
  const paused = mode !== "off" && (diverged || large);

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
        {error ? (
          <span
            className="truncate"
            style={{ color: "var(--color-warning)", marginRight: "auto" }}
            title={error}
          >
            {error}
          </span>
        ) : dirty ? (
          <span
            aria-label="Unsaved changes"
            title={
              paused
                ? large
                  ? "Unsaved changes. Past the 2 MB cap: ⌘S to save"
                  : "Unsaved changes. The file changed on disk: auto-save waits for ⌘S"
                : "Unsaved changes (⌘S to save)"
            }
            style={{ color: "var(--color-ink-muted)", marginRight: "auto" }}
          >
            ● edited{paused ? " · auto-save paused" : ""}
          </span>
        ) : (
          // The dirty dot's acknowledgement: opacity only, never a spinner.
          <span
            role="status"
            aria-hidden={!flash}
            data-autosave-flash
            style={{
              color: "var(--color-ink-muted)",
              marginRight: "auto",
              opacity: flash ? 1 : 0,
              transition: "opacity 300ms ease-out",
            }}
          >
            Saved
          </span>
        )}
        <button type="button" onClick={onDone} disabled={saving} style={btn()}>
          {dirty && !leaveSaves ? "Discard & close" : "Done"}
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
        <DiskChangeBanner
          change={conflict}
          comparing={comparing != null}
          busy={saving}
          onCompare={() => setComparing((c) => (c != null ? null : viewRef.current?.state.doc.toString() ?? ""))}
          onKeep={() => {
            setConflict(null);
            setComparing(null);
          }}
          onReload={takeDisk}
          onOverwrite={save}
        />
      )}
      {conflict != null && comparing != null && <DiskCompare disk={conflict.content} buffer={comparing} />}
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
