// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/react";

import { drafterExtensions } from "../editor/extensions/drafterExtensions";
import { planDocToMarkdown } from "../editor/markdown/serializer";
import { DrafterToolbar } from "./DrafterToolbar";
import { DrafterFindBar } from "./DrafterFindBar";
import { ProjectPicker, type ProjectOption } from "./ProjectPicker";

interface PromptDrafterProps {
  /** Persisted draft (Tiptap JSON), or null for a blank document. */
  doc: JSONContent | null;
  /** Called (debounced) with the latest Tiptap JSON so the host can persist it. */
  onDocChange: (json: JSONContent) => void;
  /** Candidate project directories for the launch picker. */
  projectOptions: ProjectOption[];
  /** Selected project dir, or null for $HOME. */
  selectedProject: string | null;
  onSelectedProjectChange: (path: string | null) => void;
  /** Launch a fresh Claude plan session with this prompt (markdown) + cwd. */
  onLaunch: (markdown: string, projectPath: string | null) => void;
}

// The Prompt Drafter: a Word-style document editor for authoring a prompt and
// launching it into a new Claude Code plan session. JSON is the in-editor source
// of truth (full fidelity, persisted); markdown is generated only at send time.
export function PromptDrafter({
  doc,
  onDocChange,
  projectOptions,
  selectedProject,
  onSelectedProjectChange,
  onLaunch,
}: PromptDrafterProps) {
  const persistTimer = useRef<number | null>(null);

  const editor = useEditor({
    extensions: drafterExtensions(),
    content: doc ?? undefined,
    editorProps: {
      attributes: {
        class: "rl-prose font-serif",
        "data-drafter": "true",
      },
    },
    onUpdate: ({ editor }) => {
      // Debounce localStorage writes — avoid a serialize+stringify per keystroke.
      if (persistTimer.current !== null)
        window.clearTimeout(persistTimer.current);
      persistTimer.current = window.setTimeout(() => {
        onDocChange(editor.getJSON());
      }, 400);
    },
  });

  // Land a blinking caret at the end of the document once the pane is mounted.
  // Done in an effect (not useEditor's `autofocus`, which targets the wrong
  // instance under React.StrictMode's mount→unmount→remount) and deferred a
  // frame so the ProseMirror view is in the DOM before we focus it.
  useEffect(() => {
    if (!editor) return;
    const raf = requestAnimationFrame(() => {
      if (!editor.isDestroyed) editor.commands.focus("end");
    });
    return () => cancelAnimationFrame(raf);
  }, [editor]);

  // Flush any pending debounced write on unmount (toggling the pane closed
  // shouldn't drop the last few keystrokes).
  useEffect(() => {
    return () => {
      if (persistTimer.current !== null) {
        window.clearTimeout(persistTimer.current);
        if (editor && !editor.isDestroyed) onDocChange(editor.getJSON());
      }
    };
  }, [editor, onDocChange]);

  const launch = useCallback(() => {
    if (!editor || editor.isEmpty) return;
    const markdown = planDocToMarkdown(editor.state.doc, { sidecars: false });
    onLaunch(markdown, selectedProject);
  }, [editor, selectedProject, onLaunch]);

  const canSend = !!editor && !editor.isEmpty;

  // In-document find & replace (Cmd/Ctrl+F). PromptDrafter owns the query +
  // counters; the SearchHighlight extension owns the match positions and
  // decorations. Replace is layered on top via plain editor transactions —
  // SearchHighlight stays find-only.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [searchCount, setSearchCount] = useState(0);
  const [searchActive, setSearchActive] = useState(-1);

  const syncSearchState = useCallback(() => {
    if (!editor) return;
    const s = editor.storage.searchHighlight;
    setSearchCount(s.matches.length);
    setSearchActive(s.activeIndex);
  }, [editor]);

  const scrollToActiveMatch = useCallback(() => {
    if (!editor) return;
    const s = editor.storage.searchHighlight;
    const m = s.matches[s.activeIndex];
    if (!m) return;
    const at = editor.view.domAtPos(m.from);
    const el =
      at.node instanceof HTMLElement ? at.node : at.node.parentElement;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [editor]);

  const runSearch = useCallback(
    (q: string) => {
      setSearchQuery(q);
      editor?.commands.setSearchQuery(q);
      syncSearchState();
      scrollToActiveMatch();
    },
    [editor, syncSearchState, scrollToActiveMatch],
  );

  const stepSearch = useCallback(
    (dir: "next" | "prev") => {
      if (!editor) return;
      if (dir === "next") editor.commands.nextMatch();
      else editor.commands.prevMatch();
      syncSearchState();
      scrollToActiveMatch();
    },
    [editor, syncSearchState, scrollToActiveMatch],
  );

  // Replace one range with the replacement as literal text (a text node, so
  // markup characters aren't reparsed); an empty replacement deletes.
  const replaceRange = (
    chain: ReturnType<NonNullable<typeof editor>["chain"]>,
    from: number,
    to: number,
  ) =>
    replacement
      ? chain.insertContentAt({ from, to }, { type: "text", text: replacement })
      : chain.deleteRange({ from, to });

  const replaceActive = useCallback(() => {
    if (!editor) return;
    const s = editor.storage.searchHighlight;
    const m = s.matches[s.activeIndex];
    if (!m) return;
    replaceRange(editor.chain().focus(), m.from, m.to).run();
    // Recompute matches against the edited doc.
    editor.commands.setSearchQuery(searchQuery);
    syncSearchState();
    scrollToActiveMatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, searchQuery, replacement, syncSearchState, scrollToActiveMatch]);

  const replaceAll = useCallback(() => {
    if (!editor) return;
    const matches = [...editor.storage.searchHighlight.matches];
    if (!matches.length) return;
    // Right-to-left so earlier (smaller) positions stay valid as we edit.
    let chain = editor.chain().focus();
    for (let i = matches.length - 1; i >= 0; i--) {
      chain = replaceRange(chain, matches[i].from, matches[i].to);
    }
    chain.run();
    editor.commands.setSearchQuery(searchQuery);
    syncSearchState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, searchQuery, replacement, syncSearchState]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    editor?.commands.clearSearch();
    syncSearchState();
    editor?.commands.focus();
  }, [editor, syncSearchState]);

  // Intercept Cmd/Ctrl+F while the drafter is mounted: open the find bar
  // instead of the WebView's native find, and refresh the count for any prior
  // query against the latest doc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchOpen(true);
        if (editor && searchQuery) {
          editor.commands.setSearchQuery(searchQuery);
          syncSearchState();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editor, searchQuery, syncSearchState]);

  // useEditor re-renders on every transaction, so reading the text here yields
  // a live word/character count without an extra extension or subscription.
  const text = editor?.getText() ?? "";
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ background: "var(--color-paper)" }}
    >
      <DrafterToolbar editor={editor} />

      <div className="rl-thin-scroll-y rl-page-workspace min-h-0 flex-1 overflow-y-auto">
        {searchOpen && (
          <DrafterFindBar
            query={searchQuery}
            onQueryChange={runSearch}
            replacement={replacement}
            onReplacementChange={setReplacement}
            matchCount={searchCount}
            activeIndex={searchActive}
            onNext={() => stepSearch("next")}
            onPrev={() => stepSearch("prev")}
            onReplaceOne={replaceActive}
            onReplaceAll={replaceAll}
            onClose={closeSearch}
          />
        )}
        <div
          className="rl-page"
          onClick={() => editor?.chain().focus().run()}
        >
          <EditorContent editor={editor} />
        </div>
      </div>

      <div
        data-no-drag="true"
        className="flex items-center gap-3 px-4 py-1.5"
        style={{
          borderTop: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
          fontSize: "11px",
          color: "var(--color-ink-muted)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span style={{ flex: 1 }}>
          {words} {words === 1 ? "word" : "words"} · {chars}{" "}
          {chars === 1 ? "character" : "characters"}
        </span>
        <span style={{ opacity: 0.7 }}>⌘F to find &amp; replace</span>
      </div>

      <div
        data-no-drag="true"
        className="flex items-center gap-3 px-4 py-3"
        style={{
          borderTop: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
        }}
      >
        <ProjectPicker
          options={projectOptions}
          value={selectedProject}
          onChange={onSelectedProjectChange}
          onAfterPick={() => editor?.chain().focus().run()}
        />
        <span
          className="rl-chrome-label"
          style={{
            fontSize: "10px",
            opacity: 0.55,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          Sent as structured text — fonts, color & styling are drafting aids only
        </span>
        <button
          type="button"
          onClick={launch}
          disabled={!canSend}
          title="Launch a new Claude Code plan session seeded with this prompt"
          className="rounded-sm px-3 py-1.5"
          style={{
            fontSize: "13px",
            border: "1px solid var(--color-rule)",
            background: canSend
              ? "var(--color-anchor-bg)"
              : "var(--color-bg-elevated)",
            color: canSend ? "var(--color-anchor-text)" : "var(--color-ink)",
            opacity: canSend ? 1 : 0.5,
            cursor: canSend ? "pointer" : "default",
            whiteSpace: "nowrap",
          }}
        >
          Send to Claude Code ▶
        </button>
      </div>
    </div>
  );
}
