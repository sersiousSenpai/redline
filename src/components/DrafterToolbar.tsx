// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { CSSProperties, ReactNode } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  ChevronDown,
  Code,
  Eraser,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  MoveVertical,
  Redo2,
  Strikethrough,
  Table as TableIcon,
  Underline as UnderlineIcon,
  Undo2,
} from "lucide-react";

import { FONTS } from "../theme/fonts";

// A persistent Word-style formatting ribbon for the Prompt Drafter. Every
// control drives the live Tiptap editor through `editor.chain().focus()…` and
// reflects its pressed state via `editor.isActive(...)` / stored mark attrs. The
// host (PromptDrafter) uses `useEditor`, which re-renders on every transaction,
// so this child re-reads active states automatically as the selection moves —
// no manual subscription. Controls are real lucide icons (not glyphs), arranged
// in labelled groups with a clearly visible active state.

interface DrafterToolbarProps {
  editor: Editor | null;
}

const ICON = 16;
const STROKE = 2;

const btnBase: CSSProperties = {
  width: "30px",
  height: "30px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid transparent",
  borderRadius: "6px",
  cursor: "pointer",
  userSelect: "none",
  color: "var(--color-ink)",
  background: "transparent",
};

// A button wrapped in a CSS tooltip (data-tip). The wrapper carries the tip so
// the button's own hover/active styling stays clean.
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
    <span className="rl-tipwrap" data-tip={title}>
      <button
        type="button"
        aria-label={title}
        aria-pressed={active}
        disabled={disabled}
        // Keep focus in the editor: mousedown default would blur it, collapsing
        // the selection before the command runs.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={`rl-ribbon-btn${active ? " rl-ribbon-btn--active" : ""}`}
        style={{
          ...btnBase,
          opacity: disabled ? 0.35 : 1,
          cursor: disabled ? "default" : "pointer",
          ...style,
        }}
      >
        {children}
      </button>
    </span>
  );
}

// A labelled cluster of related controls, separated from its neighbours by
// spacing and a hairline — the Word "ribbon group" cue.
function Group({ children }: { children: ReactNode }) {
  return <div className="rl-ribbon-group">{children}</div>;
}

// A reusable ribbon dropdown: a labelled trigger that opens a floating panel.
// Children are a render function receiving `close`, so callers can lay out
// option rows, swatch grids, etc. Closes on outside-click and Escape. The
// trigger and its panel both suppress mousedown so the editor selection is
// preserved while the user picks an option.
function RibbonMenu({
  label,
  title,
  minWidth,
  disabled,
  children,
}: {
  label: ReactNode;
  title: string;
  minWidth?: number;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <span className="rl-tipwrap" data-tip={title}>
        <button
          type="button"
          aria-label={title}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => !disabled && setOpen((o) => !o)}
          className={`rl-ribbon-trigger${open ? " rl-ribbon-btn--active" : ""}`}
          style={{
            minWidth: minWidth ? `${minWidth}px` : undefined,
            opacity: disabled ? 0.35 : 1,
            cursor: disabled ? "default" : "pointer",
          }}
        >
          <span className="rl-ribbon-trigger-label">{label}</span>
          <ChevronDown size={13} strokeWidth={STROKE} style={{ opacity: 0.7 }} />
        </button>
      </span>
      {open && (
        <div
          role="menu"
          onMouseDown={(e) => e.preventDefault()}
          className="rl-ribbon-pop"
          style={{ minWidth: minWidth ? `${minWidth}px` : "160px" }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// A single option row inside a RibbonMenu.
function MenuRow({
  active,
  disabled,
  onClick,
  children,
  style,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`rl-menu-row${active ? " rl-menu-row--active" : ""}`}
      style={style}
    >
      {children}
    </button>
  );
}

// Standard font-color palette. Absolute colors (not theme tokens): font color
// is an explicit author choice, like Word's swatches. "Automatic" clears it.
const TEXT_COLORS = [
  "#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#ffffff",
  "#e8553d", "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3d85c6",
  "#3c5fb5", "#674ea7", "#a64d79", "#85200c", "#0b5394", "#274e13",
];

// Paragraph "styles" — Word's style gallery, mapped to the drafter's schema.
const PARAGRAPH_STYLES: {
  key: string;
  label: string;
  isActive: (e: Editor) => boolean;
  apply: (e: Editor) => void;
}[] = [
  {
    key: "p",
    label: "Normal",
    isActive: (e) => e.isActive("paragraph"),
    apply: (e) => e.chain().focus().setParagraph().run(),
  },
  {
    key: "h1",
    label: "Heading 1",
    isActive: (e) => e.isActive("heading", { level: 1 }),
    apply: (e) => e.chain().focus().setHeading({ level: 1 }).run(),
  },
  {
    key: "h2",
    label: "Heading 2",
    isActive: (e) => e.isActive("heading", { level: 2 }),
    apply: (e) => e.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    key: "h3",
    label: "Heading 3",
    isActive: (e) => e.isActive("heading", { level: 3 }),
    apply: (e) => e.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    key: "quote",
    label: "Quote",
    isActive: (e) => e.isActive("blockquote"),
    apply: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    key: "code",
    label: "Code block",
    isActive: (e) => e.isActive("codeBlock"),
    apply: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
];

// Word-style highlighter palette. Warm, legible washes + "None" to clear.
const HIGHLIGHT_COLORS = [
  "#fff3a3", "#ffd27f", "#ffb3b3", "#c8f7c5", "#bfe3ff", "#e3c8ff", "#ffc8ec",
];

const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 40, 48];

// Word's "drag to size" table inserter: hover the grid to choose columns × rows.
function TableGrid({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const MAX_ROWS = 8;
  const MAX_COLS = 10;
  const [hover, setHover] = useState({ r: 0, c: 0 });
  return (
    <div style={{ padding: "8px" }} onMouseLeave={() => setHover({ r: 0, c: 0 })}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${MAX_COLS}, 15px)`,
          gap: "3px",
        }}
      >
        {Array.from({ length: MAX_ROWS * MAX_COLS }).map((_, i) => {
          const r = Math.floor(i / MAX_COLS) + 1;
          const c = (i % MAX_COLS) + 1;
          const on = r <= hover.r && c <= hover.c;
          return (
            <div
              key={i}
              onMouseEnter={() => setHover({ r, c })}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(r, c);
              }}
              style={{
                width: "15px",
                height: "15px",
                borderRadius: "2px",
                border: `1px solid ${
                  on ? "var(--color-info)" : "var(--color-rule)"
                }`,
                background: on
                  ? "color-mix(in srgb, var(--color-info) 45%, transparent)"
                  : "var(--color-bg-elevated)",
                cursor: "pointer",
              }}
            />
          );
        })}
      </div>
      <div
        style={{
          textAlign: "center",
          fontSize: "12px",
          marginTop: "7px",
          color: "var(--color-ink-muted)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {hover.r > 0 ? `${hover.c} × ${hover.r} table` : "Insert table"}
      </div>
    </div>
  );
}

const LINE_SPACINGS: { label: string; value: string }[] = [
  { label: "Single", value: "1.2" },
  { label: "1.15", value: "1.15" },
  { label: "1.5 lines", value: "1.5" },
  { label: "Double", value: "2" },
];

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

  // Live reflections of the current selection for the dropdown labels.
  const activeStyle = editor
    ? PARAGRAPH_STYLES.find((s) => s.isActive(editor))
    : undefined;
  const activeFamily =
    (editor?.getAttributes("textStyle").fontFamily as string | undefined) ??
    "";
  const activeFamilyLabel =
    FONTS.find((f) => f.stack === activeFamily)?.label ?? "Default";
  const activeSizeRaw =
    (editor?.getAttributes("textStyle").fontSize as string | undefined) ?? "";
  const activeSizeLabel = activeSizeRaw
    ? activeSizeRaw.replace("px", "")
    : "15";
  const activeColor =
    (editor?.getAttributes("textStyle").color as string | undefined) || "";
  const activeHighlight =
    (editor?.getAttributes("highlight").color as string | undefined) || "";
  const inTable = !!editor?.isActive("table");
  // A table is the alignment target when the cursor is inside it OR the whole
  // table is node-selected (via the move-handle). In either case the ribbon's
  // align buttons align the table on the page rather than the text.
  const selection = editor?.state.selection as
    | { node?: { type: { name: string } } }
    | undefined;
  const tableSelected = selection?.node?.type?.name === "table";
  const tableContext = !!editor && (inTable || tableSelected);
  const tableAlign =
    (editor?.getAttributes("table").align as string | undefined) || "left";

  return (
    <div data-no-drag="true" className="rl-ribbon">
      {/* History */}
      <Group>
        <ToolButton
          title="Undo (⌘Z)"
          disabled={disabled || !editor?.can().undo()}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          <Undo2 size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Redo (⌘⇧Z)"
          disabled={disabled || !editor?.can().redo()}
          onClick={() => editor?.chain().focus().redo().run()}
        >
          <Redo2 size={ICON} strokeWidth={STROKE} />
        </ToolButton>
      </Group>

      {/* Paragraph style + font */}
      <Group>
        <RibbonMenu
          title="Paragraph style"
          label={activeStyle?.label ?? "Normal"}
          minWidth={116}
          disabled={disabled}
        >
          {(close) =>
            PARAGRAPH_STYLES.map((s) => (
              <MenuRow
                key={s.key}
                active={editor ? s.isActive(editor) : false}
                onClick={() => {
                  if (editor) s.apply(editor);
                  close();
                }}
              >
                {s.label}
              </MenuRow>
            ))
          }
        </RibbonMenu>
        <RibbonMenu
          title="Font"
          label={activeFamilyLabel}
          minWidth={128}
          disabled={disabled}
        >
          {(close) => (
            <>
              <MenuRow
                active={!activeFamily}
                onClick={() => {
                  editor?.chain().focus().unsetFontFamily().run();
                  close();
                }}
              >
                Default
              </MenuRow>
              {FONTS.map((f) => (
                <MenuRow
                  key={f.name}
                  active={activeFamily === f.stack}
                  onClick={() => {
                    editor?.chain().focus().setFontFamily(f.stack).run();
                    close();
                  }}
                  style={{ fontFamily: f.stack }}
                >
                  {f.label}
                </MenuRow>
              ))}
            </>
          )}
        </RibbonMenu>
        <RibbonMenu
          title="Font size"
          label={activeSizeLabel}
          minWidth={56}
          disabled={disabled}
        >
          {(close) => (
            <>
              <MenuRow
                active={!activeSizeRaw}
                onClick={() => {
                  editor?.chain().focus().unsetFontSize().run();
                  close();
                }}
              >
                Default
              </MenuRow>
              {FONT_SIZES.map((px) => (
                <MenuRow
                  key={px}
                  active={activeSizeRaw === `${px}px`}
                  onClick={() => {
                    editor?.chain().focus().setFontSize(`${px}px`).run();
                    close();
                  }}
                >
                  {px}
                </MenuRow>
              ))}
            </>
          )}
        </RibbonMenu>
      </Group>

      {/* Inline marks */}
      <Group>
        <ToolButton
          title="Bold (⌘B)"
          disabled={disabled}
          active={editor?.isActive("bold")}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Italic (⌘I)"
          disabled={disabled}
          active={editor?.isActive("italic")}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Underline (⌘U)"
          disabled={disabled}
          active={editor?.isActive("underline")}
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
        >
          <UnderlineIcon size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Strikethrough"
          disabled={disabled}
          active={editor?.isActive("strike")}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        >
          <Strikethrough size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Inline code"
          disabled={disabled}
          active={editor?.isActive("code")}
          onClick={() => editor?.chain().focus().toggleCode().run()}
        >
          <Code size={ICON} strokeWidth={STROKE} />
        </ToolButton>
      </Group>

      {/* Color + highlight */}
      <Group>
        <RibbonMenu
          title="Text color"
          label={
            <Baseline
              size={ICON}
              strokeWidth={STROKE}
              style={{ color: activeColor || "var(--color-info)" }}
            />
          }
          minWidth={42}
          disabled={disabled}
        >
          {(close) => (
            <div style={{ width: "176px" }}>
              <MenuRow
                onClick={() => {
                  editor?.chain().focus().unsetColor().run();
                  close();
                }}
              >
                Automatic
              </MenuRow>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, 1fr)",
                  gap: "4px",
                  padding: "6px 8px",
                }}
              >
                {TEXT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      editor?.chain().focus().setColor(c).run();
                      close();
                    }}
                    style={{
                      width: "18px",
                      height: "18px",
                      borderRadius: "3px",
                      border: "1px solid var(--color-rule)",
                      background: c,
                      cursor: "pointer",
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </RibbonMenu>
        <RibbonMenu
          title="Highlight color"
          label={
            <Highlighter
              size={ICON}
              strokeWidth={STROKE}
              style={{
                color: activeHighlight || "var(--color-ink)",
              }}
            />
          }
          minWidth={42}
          disabled={disabled}
        >
          {(close) => (
            <div style={{ width: "168px" }}>
              <MenuRow
                onClick={() => {
                  editor?.chain().focus().unsetHighlight().run();
                  close();
                }}
              >
                No highlight
              </MenuRow>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, 1fr)",
                  gap: "4px",
                  padding: "6px 8px",
                }}
              >
                {HIGHLIGHT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      editor?.chain().focus().setHighlight({ color: c }).run();
                      close();
                    }}
                    style={{
                      width: "18px",
                      height: "18px",
                      borderRadius: "3px",
                      border: "1px solid var(--color-rule)",
                      background: c,
                      cursor: "pointer",
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </RibbonMenu>
      </Group>

      {/* Alignment — aligns the whole table when one is selected, else text. */}
      <Group>
        {(
          [
            ["left", AlignLeft],
            ["center", AlignCenter],
            ["right", AlignRight],
            ["justify", AlignJustify],
          ] as const
        ).map(([align, Icon]) => {
          const isTableAlign = tableContext && align !== "justify";
          return (
            <ToolButton
              key={align}
              title={
                isTableAlign ? `Align table ${align}` : `Align ${align}`
              }
              // Tables can't be justified.
              disabled={disabled || (tableContext && align === "justify")}
              active={
                isTableAlign
                  ? tableAlign === align
                  : !tableContext && editor?.isActive({ textAlign: align })
              }
              onClick={() => {
                if (!editor) return;
                if (isTableAlign) {
                  editor
                    .chain()
                    .focus()
                    .setTableAlign(align as "left" | "center" | "right")
                    .run();
                } else {
                  editor.chain().focus().setTextAlign(align).run();
                }
              }}
            >
              <Icon size={ICON} strokeWidth={STROKE} />
            </ToolButton>
          );
        })}
      </Group>

      {/* Lists + indent + spacing */}
      <Group>
        <ToolButton
          title="Bullet list"
          disabled={disabled}
          active={editor?.isActive("bulletList")}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Numbered list"
          disabled={disabled}
          active={editor?.isActive("orderedList")}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Decrease indent"
          disabled={disabled}
          onClick={() => editor?.chain().focus().outdent().run()}
        >
          <IndentDecrease size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Increase indent"
          disabled={disabled}
          onClick={() => editor?.chain().focus().indent().run()}
        >
          <IndentIncrease size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <RibbonMenu
          title="Line spacing"
          label={<MoveVertical size={ICON} strokeWidth={STROKE} />}
          minWidth={42}
          disabled={disabled}
        >
          {(close) => (
            <>
              <MenuRow
                onClick={() => {
                  editor?.chain().focus().unsetLineHeight().run();
                  close();
                }}
              >
                Default
              </MenuRow>
              {LINE_SPACINGS.map((s) => (
                <MenuRow
                  key={s.value}
                  onClick={() => {
                    editor?.chain().focus().setLineHeight(s.value).run();
                    close();
                  }}
                >
                  {s.label}
                </MenuRow>
              ))}
            </>
          )}
        </RibbonMenu>
      </Group>

      {/* Insert */}
      <Group>
        <RibbonMenu
          title="Table"
          label={<TableIcon size={ICON} strokeWidth={STROKE} />}
          minWidth={42}
          disabled={disabled}
        >
          {(close) => (
            <>
              <TableGrid
                onPick={(rows, cols) => {
                  editor
                    ?.chain()
                    .focus()
                    .insertTable({ rows, cols, withHeaderRow: true })
                    .run();
                  close();
                }}
              />
              <div
                style={{
                  height: "1px",
                  background: "var(--color-rule)",
                  margin: "2px 0",
                }}
              />
              <MenuRow
                disabled={!inTable}
                onClick={() => {
                  editor?.chain().focus().addRowAfter().run();
                  close();
                }}
              >
                Add row below
              </MenuRow>
              <MenuRow
                disabled={!inTable}
                onClick={() => {
                  editor?.chain().focus().addColumnAfter().run();
                  close();
                }}
              >
                Add column after
              </MenuRow>
              <MenuRow
                disabled={!inTable}
                onClick={() => {
                  editor?.chain().focus().deleteRow().run();
                  close();
                }}
              >
                Delete row
              </MenuRow>
              <MenuRow
                disabled={!inTable}
                onClick={() => {
                  editor?.chain().focus().deleteColumn().run();
                  close();
                }}
              >
                Delete column
              </MenuRow>
              <MenuRow
                disabled={!inTable}
                onClick={() => {
                  editor?.chain().focus().deleteTable().run();
                  close();
                }}
              >
                Delete table
              </MenuRow>
            </>
          )}
        </RibbonMenu>
        <ToolButton
          title="Link"
          disabled={disabled}
          active={editor?.isActive("link")}
          onClick={setLink}
        >
          <LinkIcon size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Horizontal divider"
          disabled={disabled}
          onClick={() => editor?.chain().focus().setHorizontalRule().run()}
        >
          <Minus size={ICON} strokeWidth={STROKE} />
        </ToolButton>
      </Group>

      {/* Clear */}
      <Group>
        <ToolButton
          title="Clear formatting"
          disabled={disabled}
          onClick={() =>
            editor?.chain().focus().unsetAllMarks().clearNodes().run()
          }
        >
          <Eraser size={ICON} strokeWidth={STROKE} />
        </ToolButton>
      </Group>
    </div>
  );
}
