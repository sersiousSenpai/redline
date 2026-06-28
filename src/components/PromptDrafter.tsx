// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/react";

import { drafterExtensions } from "../editor/extensions/drafterExtensions";
import { planDocToMarkdown } from "../editor/markdown/serializer";
import { DrafterToolbar } from "./DrafterToolbar";
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

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ background: "var(--color-paper)" }}
    >
      <DrafterToolbar editor={editor} />

      <div className="rl-thin-scroll-y min-h-0 flex-1 overflow-y-auto">
        <div
          className="mx-auto pl-16 pr-8 py-10"
          style={{ maxWidth: "820px" }}
          onClick={() => editor?.chain().focus().run()}
        >
          <EditorContent editor={editor} />
        </div>
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
          Sent as structured text — underline & alignment are drafting aids only
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
