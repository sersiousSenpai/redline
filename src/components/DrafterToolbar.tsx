// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Editor } from "@tiptap/react";
import type { CSSProperties, ReactNode } from "react";

// A persistent Word-style formatting toolbar for the Prompt Drafter. Every
// control drives the live Tiptap editor through `editor.chain().focus()…` and
// reflects its pressed state via `editor.isActive(...)`. The host (PromptDrafter)
// uses `useEditor`, which re-renders on every transaction, so this child re-reads
// active states automatically as the selection moves — no manual subscription.

interface DrafterToolbarProps {
  editor: Editor | null;
}

const btnBase: CSSProperties = {
  fontSize: "12px",
  lineHeight: 1,
  minWidth: "26px",
  height: "26px",
  padding: "0 6px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--color-rule)",
  borderRadius: "4px",
  cursor: "pointer",
  userSelect: "none",
};

function ToolButton({
  active,
  disabled,
  title,
  onClick,
  children,
  style,
}: {
  active?: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      // Keep focus in the editor: mousedown default would blur it, collapsing
      // the selection before the command runs.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{
        ...btnBase,
        background: active
          ? "var(--color-anchor-bg)"
          : "var(--color-bg-elevated)",
        color: active ? "var(--color-anchor-text)" : "var(--color-ink)",
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "default" : "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function Divider() {
  return (
    <span
      aria-hidden
      style={{
        width: "1px",
        height: "18px",
        background: "var(--color-rule)",
        margin: "0 2px",
      }}
    />
  );
}

export function DrafterToolbar({ editor }: DrafterToolbarProps) {
  const disabled = !editor;

  const setLink = () => {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return; // cancelled
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: url })
      .run();
  };

  return (
    <div
      data-no-drag="true"
      className="flex flex-wrap items-center gap-1 px-3 py-2"
      style={{
        borderBottom: "1px solid var(--color-rule)",
        background: "var(--color-paper)",
      }}
    >
      {/* Block type */}
      <ToolButton
        title="Body text"
        disabled={disabled}
        active={editor?.isActive("paragraph")}
        onClick={() => editor?.chain().focus().setParagraph().run()}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        ¶
      </ToolButton>
      {[1, 2, 3].map((level) => (
        <ToolButton
          key={level}
          title={`Heading ${level}`}
          disabled={disabled}
          active={editor?.isActive("heading", { level })}
          onClick={() =>
            editor
              ?.chain()
              .focus()
              .toggleHeading({ level: level as 1 | 2 | 3 })
              .run()
          }
          style={{ fontFamily: "var(--font-mono)" }}
        >
          H{level}
        </ToolButton>
      ))}

      <Divider />

      {/* Inline marks */}
      <ToolButton
        title="Bold (⌘B)"
        disabled={disabled}
        active={editor?.isActive("bold")}
        onClick={() => editor?.chain().focus().toggleBold().run()}
        style={{ fontWeight: 700 }}
      >
        B
      </ToolButton>
      <ToolButton
        title="Italic (⌘I)"
        disabled={disabled}
        active={editor?.isActive("italic")}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
        style={{ fontStyle: "italic" }}
      >
        I
      </ToolButton>
      <ToolButton
        title="Underline (⌘U)"
        disabled={disabled}
        active={editor?.isActive("underline")}
        onClick={() => editor?.chain().focus().toggleUnderline().run()}
        style={{ textDecoration: "underline" }}
      >
        U
      </ToolButton>
      <ToolButton
        title="Strikethrough"
        disabled={disabled}
        active={editor?.isActive("strike")}
        onClick={() => editor?.chain().focus().toggleStrike().run()}
        style={{ textDecoration: "line-through" }}
      >
        S
      </ToolButton>
      <ToolButton
        title="Inline code"
        disabled={disabled}
        active={editor?.isActive("code")}
        onClick={() => editor?.chain().focus().toggleCode().run()}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {"</>"}
      </ToolButton>
      <ToolButton
        title="Link"
        disabled={disabled}
        active={editor?.isActive("link")}
        onClick={setLink}
      >
        🔗
      </ToolButton>

      <Divider />

      {/* Blocks */}
      <ToolButton
        title="Bullet list"
        disabled={disabled}
        active={editor?.isActive("bulletList")}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        •
      </ToolButton>
      <ToolButton
        title="Numbered list"
        disabled={disabled}
        active={editor?.isActive("orderedList")}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        1.
      </ToolButton>
      <ToolButton
        title="Quote"
        disabled={disabled}
        active={editor?.isActive("blockquote")}
        onClick={() => editor?.chain().focus().toggleBlockquote().run()}
      >
        ❝
      </ToolButton>
      <ToolButton
        title="Code block"
        disabled={disabled}
        active={editor?.isActive("codeBlock")}
        onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {"{ }"}
      </ToolButton>

      <Divider />

      {/* Alignment */}
      {(
        [
          ["left", "⬅"],
          ["center", "↔"],
          ["right", "➡"],
          ["justify", "☰"],
        ] as const
      ).map(([align, glyph]) => (
        <ToolButton
          key={align}
          title={`Align ${align}`}
          disabled={disabled}
          active={editor?.isActive({ textAlign: align })}
          onClick={() => editor?.chain().focus().setTextAlign(align).run()}
        >
          {glyph}
        </ToolButton>
      ))}

      <Divider />

      <ToolButton
        title="Clear formatting"
        disabled={disabled}
        onClick={() =>
          editor?.chain().focus().unsetAllMarks().clearNodes().run()
        }
      >
        ⌫
      </ToolButton>
    </div>
  );
}
