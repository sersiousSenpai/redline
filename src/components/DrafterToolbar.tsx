// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useLayoutEffect, useRef, useState } from "react";
import { useEditorState } from "@tiptap/react";
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
  MessageSquare,
  Minus,
  MoreHorizontal,
  MoveVertical,
  PenLine,
  Redo2,
  Strikethrough,
  Table as TableIcon,
  Underline as UnderlineIcon,
  Undo2,
} from "lucide-react";

import { InlineInputPopover, Panel, useClickPopover } from "./popover";
import { fitRibbon } from "../lib/ribbonFit";
import { rafCoalesce } from "../lib/raf";
import { FONTS } from "../theme/fonts";
import { applyLink } from "../editor/drafterInserts";

// A persistent Word-style formatting ribbon for the Prompt Drafter. Every
// control drives the live Tiptap editor through `editor.chain().focus()…` and
// reflects its pressed state through `useEditorState` — its OWN subscription,
// which is load-bearing: this ribbon used to rely on the host re-rendering on
// every ProseMirror transaction, and calling `editor.isActive(...)` fifteen
// times from that render. The host stopped doing that (it walked a ~2,800-line
// tree per keystroke, which was the literal jank), and a ribbon with no
// subscription of its own would simply FREEZE — Bold stops lighting up, the
// style dropdown stops tracking the caret. Strictly worse than the jank.
//
// The selector returns a flat object and `useEditorState` compares it with
// `deepEqual`, so moving the caret inside one word re-renders nothing.
// Controls are real lucide icons (not glyphs), arranged in labelled groups with
// a clearly visible active state.

interface DrafterToolbarProps {
  editor: Editor | null;
  /** The comment sidecar toggle (moved here from the old fat footer). */
  sidecarOpen?: boolean;
  onToggleSidecar?: () => void;
  commentCount?: number;
  /** Word's Editing/Suggesting switch. Suggesting paints the user's own
   *  keystrokes as tracked changes; Editing is plain typing. */
  suggesting?: boolean;
  onSetSuggesting?: (on: boolean) => void;
  /** Review rows in the mode menu: settle/revert EVERY pending user run. */
  hasUserRuns?: boolean;
  onResolveAllMine?: (keep: boolean) => void;
  /** ✦ co-authoring: send the caret's paragraph to the doc agent as an
   *  instruction (the toolbar twin of ⌘↵). */
  onGenerate?: () => void;
  canGenerate?: boolean;
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

/** Fit the ribbon to its pane. Measured, and driven entirely through DOM
 *  attributes — never React state.
 *
 *  Measured because the alternative (a media query, or a width breakpoint) is a
 *  guess: this is a PANE, not the viewport, and it can be any width from the
 *  document column's 300px floor upward. Unmeasured reads as roomy, so the
 *  first paint is the common case and there is no compact flash.
 *
 *  Attributes rather than state because this runs on every frame of a divider
 *  drag, and a state flip here would re-render the ribbon — and the drafter —
 *  sixty times a second. Same reason, stated the same way, as
 *  `useTextClearance`.
 *
 *  Each group is measured ONCE, with everything mounted, and cached by id:
 *  measuring a hidden group returns 0 and it would then "fit" forever. */
function useRibbonOverflow() {
  const ref = useRef<HTMLDivElement | null>(null);
  const widths = useRef(new Map<string, number>());
  const hiddenRef = useRef<string[]>([]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fit = () => {
      const groups = [...el.querySelectorAll<HTMLElement>("[data-group]")];
      for (const g of groups) {
        const id = g.dataset.group;
        if (!id) continue;
        // Only measure while VISIBLE — a hidden group measures 0.
        if (g.dataset.hidden !== "1") {
          const w = g.getBoundingClientRect().width;
          if (w > 0) widths.current.set(id, w + 8 /* gap */);
        }
      }
      const measured = groups
        .map((g) => g.dataset.group ?? "")
        .filter((id) => widths.current.has(id))
        .map((id) => ({ id, width: widths.current.get(id) as number }));
      if (measured.length === 0) return;

      const style = getComputedStyle(el);
      const available =
        el.clientWidth -
        parseFloat(style.paddingLeft || "0") -
        parseFloat(style.paddingRight || "0");
      const { overflow } = fitRibbon(measured, available, hiddenRef.current);
      hiddenRef.current = overflow;
      const hidden = new Set(overflow);
      for (const g of groups) {
        const id = g.dataset.group;
        if (!id) continue;
        g.dataset.hidden = hidden.has(id) ? "1" : "0";
      }
      el.dataset.overflowing = overflow.length > 0 ? "1" : "0";
    };

    fit();
    const onFrame = rafCoalesce(fit);
    // Guarded: without an observer the ribbon stays at its first measurement,
    // which is the roomy default. Degrading to "everything visible" is the
    // right failure — crashing the whole formatting bar over a missing
    // platform API is not.
    if (typeof ResizeObserver === "undefined") return () => onFrame.cancel();
    const ro = new ResizeObserver(() => onFrame());
    ro.observe(el);
    return () => {
      onFrame.cancel();
      ro.disconnect();
    };
  }, []);

  return ref;
}

// A labelled cluster of related controls, separated from its neighbours by
// spacing and a hairline — the Word "ribbon group" cue.
//
// `id` names it for the overflow law in lib/ribbonFit.ts. Groups leave as whole
// units, never mid-group.
function Group({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div className="rl-ribbon-group" data-group={id}>
      {children}
    </div>
  );
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
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // `useClickPopover` + `Panel` instead of a raw `position: absolute; left: 0`
  // panel, which fixes two bugs at once:
  //
  //  1. No collision detection — the right-most dropdowns ran straight out of a
  //     narrow pane. `placeUnder` clamps them back in.
  //  2. No `useMenuOverlay` registration — so EVERY ribbon dropdown was painted
  //     over by the native browser webview whenever the browser surface was up
  //     (the webview always paints above React DOM; `menuOverlay` is how the
  //     rest of the app hides it while a menu is open). `useClickPopover` calls
  //     it, which is most of why this moved.
  //
  // `.rl-ribbon-pop` keeps its skin and loses its positioning.
  const pop = useClickPopover(btnRef, "left", "below", minWidth ?? 200);

  return (
    <div style={{ position: "relative" }}>
      <span className="rl-tipwrap" data-tip={title}>
        <button
          type="button"
          ref={btnRef}
          aria-label={title}
          aria-haspopup="menu"
          aria-expanded={pop.open}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => !disabled && pop.toggle()}
          className={`rl-ribbon-trigger${pop.open ? " rl-ribbon-btn--active" : ""}`}
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
      {pop.open && (
        <Panel
          label={title}
          {...pop.panelProps}
          style={{
            ...pop.panelProps.style,
            // The skin comes from `.rl-ribbon-pop`; Panel's own border and
            // background would double it.
            border: "none",
            background: "transparent",
            boxShadow: "none",
          }}
        >
          <div
            role="menu"
            onMouseDown={(e) => e.preventDefault()}
            className="rl-ribbon-pop"
            style={{ position: "static", minWidth: "100%" }}
          >
            {children(pop.close)}
          </div>
        </Panel>
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

// Ordered-list marker styles. `key` matches the `listStyle` attribute and the
// serializer's marker logic; `preview` shows the on-screen glyphs. Grouped by
// family with a heading so the ~dozen permutations stay scannable.
const ORDERED_STYLE_GROUPS: {
  heading: string;
  styles: { key: string; preview: string }[];
}[] = [
  {
    heading: "Numbers",
    styles: [
      { key: "decimal", preview: "1. 2. 3." },
      { key: "decimal-paren", preview: "1) 2) 3)" },
      { key: "decimal-parenthetical", preview: "(1) (2) (3)" },
      { key: "decimal-leading-zero", preview: "01. 02. 03." },
    ],
  },
  {
    heading: "Letters",
    styles: [
      { key: "lower-alpha", preview: "a. b. c." },
      { key: "lower-alpha-paren", preview: "a) b) c)" },
      { key: "lower-alpha-parenthetical", preview: "(a) (b) (c)" },
      { key: "upper-alpha", preview: "A. B. C." },
      { key: "upper-alpha-paren", preview: "A) B) C)" },
    ],
  },
  {
    heading: "Roman",
    styles: [
      { key: "lower-roman", preview: "i. ii. iii." },
      { key: "lower-roman-paren", preview: "i) ii) iii)" },
      { key: "lower-roman-parenthetical", preview: "(i) (ii) (iii)" },
      { key: "upper-roman", preview: "I. II. III." },
      { key: "upper-roman-paren", preview: "I) II) III)" },
    ],
  },
  {
    heading: "Greek",
    styles: [{ key: "lower-greek", preview: "α. β. γ." }],
  },
];

const BULLET_STYLES: { key: string; preview: string; label: string }[] = [
  { key: "disc", preview: "●", label: "Disc" },
  { key: "circle", preview: "○", label: "Circle" },
  { key: "square", preview: "▪", label: "Square" },
  { key: "dash", preview: "–", label: "Dash" },
];

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

export function DrafterToolbar({
  editor,
  sidecarOpen = false,
  onToggleSidecar,
  commentCount = 0,
  suggesting = false,
  onSetSuggesting,
  hasUserRuns = false,
  onResolveAllMine,
  onGenerate,
  canGenerate = false,
}: DrafterToolbarProps) {
  const disabled = !editor;

  // The link input popover, with its prefill. Commits through applyLink.
  const [inputPop, setInputPop] = useState<null | {
    kind: "link";
    initial: string;
  }>(null);

  const openLinkPop = () => {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    setInputPop({ kind: "link", initial: prev ?? "https://" });
  };

  // ONE subscription for everything the ribbon reflects. Flat and primitive by
  // design: `deepEqual` on a flat object of strings/booleans is what makes
  // typing three characters inside one word cost zero ribbon renders.
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const sel = e.state.selection as { node?: { type: { name: string } } };
      return {
        // Undo/Redo enablement rides the selector too. Read at render time it
        // would freeze at whatever the history looked like on mount — Undo
        // permanently disabled after the first keystroke, which is a worse
        // failure than the jank it came from.
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        styleKey: PARAGRAPH_STYLES.find((s) => s.isActive(e))?.key ?? "",
        family: (e.getAttributes("textStyle").fontFamily as string) ?? "",
        size: (e.getAttributes("textStyle").fontSize as string) ?? "",
        color: (e.getAttributes("textStyle").color as string) || "",
        highlight: (e.getAttributes("highlight").color as string) || "",
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        underline: e.isActive("underline"),
        strike: e.isActive("strike"),
        code: e.isActive("code"),
        link: e.isActive("link"),
        inOrdered: e.isActive("orderedList"),
        inBullet: e.isActive("bulletList"),
        orderedStyle:
          (e.getAttributes("orderedList").listStyle as string) || "decimal",
        bulletStyle:
          (e.getAttributes("bulletList").listStyle as string) || "disc",
        inTable: e.isActive("table"),
        // A table is the alignment target when the cursor is inside it OR the
        // whole table is node-selected (via the move-handle).
        tableSelected: sel?.node?.type?.name === "table",
        tableAlign: (e.getAttributes("table").align as string) || "left",
        alignLeft: e.isActive({ textAlign: "left" }),
        alignCenter: e.isActive({ textAlign: "center" }),
        alignRight: e.isActive({ textAlign: "right" }),
        alignJustify: e.isActive({ textAlign: "justify" }),
      };
    },
  });

  const activeStyle = PARAGRAPH_STYLES.find((s) => s.key === st?.styleKey);
  const activeFamily = st?.family ?? "";
  const activeFamilyLabel =
    FONTS.find((f) => f.stack === activeFamily)?.label ?? "Default";
  const activeSizeRaw = st?.size ?? "";
  const activeSizeLabel = activeSizeRaw
    ? activeSizeRaw.replace("px", "")
    : "15";
  const activeColor = st?.color ?? "";
  const activeHighlight = st?.highlight ?? "";
  const inOrdered = !!st?.inOrdered;
  const inBullet = !!st?.inBullet;
  const orderedStyle = st?.orderedStyle ?? "decimal";
  const bulletStyle = st?.bulletStyle ?? "disc";
  const inTable = !!st?.inTable;
  const tableContext = !!editor && (inTable || !!st?.tableSelected);
  const tableAlign = st?.tableAlign ?? "left";
  const isAligned = (align: string) =>
    align === "left"
      ? !!st?.alignLeft
      : align === "center"
        ? !!st?.alignCenter
        : align === "right"
          ? !!st?.alignRight
          : !!st?.alignJustify;

  const ribbonRef = useRibbonOverflow();
  // The ⋯ toggle. State is right here: it changes on a deliberate click, not
  // on a drag frame.
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      data-no-drag="true"
      className="rl-ribbon"
      ref={ribbonRef}
      data-expanded={expanded ? "1" : "0"}
    >
      {/* History */}
      <Group id="history">
        <ToolButton
          title="Undo (⌘Z)"
          disabled={disabled || !st?.canUndo}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          <Undo2 size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Redo (⌘⇧Z)"
          disabled={disabled || !st?.canRedo}
          onClick={() => editor?.chain().focus().redo().run()}
        >
          <Redo2 size={ICON} strokeWidth={STROKE} />
        </ToolButton>
      </Group>

      {/* Paragraph style + font */}
      <Group id="style">
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
      </Group>

      {/* Type: font family + size. Split OUT of the paragraph-style group so
          the give-up order can be honest — family and size are drafting AIDS
          that don't survive the launch, while the paragraph style is semantics
          that does. Combined, they could only ever leave as one unit. */}
      <Group id="type">
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
      <Group id="marks">
        <ToolButton
          title="Bold (⌘B)"
          disabled={disabled}
          active={st?.bold}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Italic (⌘I)"
          disabled={disabled}
          active={st?.italic}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Underline (⌘U)"
          disabled={disabled}
          active={st?.underline}
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
        >
          <UnderlineIcon size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Strikethrough"
          disabled={disabled}
          active={st?.strike}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        >
          <Strikethrough size={ICON} strokeWidth={STROKE} />
        </ToolButton>
        <ToolButton
          title="Inline code"
          disabled={disabled}
          active={st?.code}
          onClick={() => editor?.chain().focus().toggleCode().run()}
        >
          <Code size={ICON} strokeWidth={STROKE} />
        </ToolButton>
      </Group>

      {/* Color + highlight */}
      <Group id="color">
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
      <Group id="align">
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
                  : !tableContext && isAligned(align)
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
      <Group id="lists">
        <RibbonMenu
          title="Bulleted list"
          label={<List size={ICON} strokeWidth={STROKE} />}
          minWidth={42}
          disabled={disabled}
        >
          {(close) => (
            <div style={{ minWidth: "148px" }}>
              <MenuRow
                active={inBullet}
                onClick={() => {
                  editor?.chain().focus().toggleBulletList().run();
                  close();
                }}
              >
                {inBullet ? "Remove bullets" : "Bulleted list"}
              </MenuRow>
              <div className="rl-menu-sep" />
              {BULLET_STYLES.map((s) => (
                <MenuRow
                  key={s.key}
                  active={inBullet && bulletStyle === s.key}
                  onClick={() => {
                    editor?.chain().focus().setBulletListStyle(s.key).run();
                    close();
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: "1.4em",
                      textAlign: "center",
                    }}
                  >
                    {s.preview}
                  </span>
                  {s.label}
                </MenuRow>
              ))}
            </div>
          )}
        </RibbonMenu>
        <RibbonMenu
          title="Numbered list"
          label={<ListOrdered size={ICON} strokeWidth={STROKE} />}
          minWidth={42}
          disabled={disabled}
        >
          {(close) => (
            <div style={{ minWidth: "170px" }}>
              <MenuRow
                active={inOrdered}
                onClick={() => {
                  editor?.chain().focus().toggleOrderedList().run();
                  close();
                }}
              >
                {inOrdered ? "Remove numbering" : "Numbered list"}
              </MenuRow>
              {ORDERED_STYLE_GROUPS.map((group) => (
                <div key={group.heading}>
                  <div className="rl-menu-sep" />
                  <div className="rl-menu-heading">{group.heading}</div>
                  {group.styles.map((s) => (
                    <MenuRow
                      key={s.key}
                      active={inOrdered && orderedStyle === s.key}
                      onClick={() => {
                        editor?.chain().focus().setOrderedListStyle(s.key).run();
                        close();
                      }}
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {s.preview}
                    </MenuRow>
                  ))}
                </div>
              ))}
            </div>
          )}
        </RibbonMenu>
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
      <Group id="insert">
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
        <div style={{ position: "relative" }}>
          <ToolButton
            title="Link"
            disabled={disabled}
            active={st?.link}
            onClick={openLinkPop}
          >
            <LinkIcon size={ICON} strokeWidth={STROKE} />
          </ToolButton>
          {inputPop?.kind === "link" && (
            <InlineInputPopover
              title="Link URL — empty removes the link"
              placeholder="https://"
              initialValue={inputPop.initial}
              onCommit={(url) => editor && applyLink(editor, url)}
              onClose={() => setInputPop(null)}
            />
          )}
        </div>
        <ToolButton
          title="Horizontal divider"
          disabled={disabled}
          onClick={() => editor?.chain().focus().setHorizontalRule().run()}
        >
          <Minus size={ICON} strokeWidth={STROKE} />
        </ToolButton>
      </Group>

      {/* Clear */}
      <Group id="clear">
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

      {/* ✦ co-authoring: send the caret's paragraph to the doc agent as an
          instruction — it consumes the paragraph and drafts in its place. */}
      {onGenerate && (
        <Group id="generate">
          <span
            className="rl-tipwrap"
            data-tip="Write an instruction as a paragraph, then send it to the agent — it drafts in its place (⌘↵)"
          >
            <button
              type="button"
              aria-label="Generate from this paragraph"
              disabled={disabled || !canGenerate}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onGenerate}
              className="rl-ribbon-btn"
              style={{
                ...btnBase,
                width: "auto",
                gap: "4px",
                padding: "0 8px",
                fontSize: "12px",
                color: "var(--color-info)",
                opacity: disabled || !canGenerate ? 0.35 : 1,
                cursor: disabled || !canGenerate ? "default" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              ✦ Generate
            </button>
          </span>
        </Group>
      )}

      {/* Editing / Suggesting — Word's mode switch. Suggesting turns the
          user's own keystrokes into tracked runs (Keep/Revert in place). */}
      {onSetSuggesting && (
        <Group id="mode">
          <RibbonMenu
            title="Editing mode — whether your edits are tracked"
            label={
              <span
                className="flex items-center gap-1"
                style={
                  suggesting ? { color: "var(--color-info)" } : undefined
                }
              >
                <PenLine size={13} strokeWidth={STROKE} />
                {suggesting ? "Suggesting" : "Editing"}
              </span>
            }
            minWidth={104}
          >
            {(close) => (
              <>
                <MenuRow
                  active={!suggesting}
                  onClick={() => {
                    onSetSuggesting(false);
                    close();
                  }}
                >
                  <span>
                    Editing
                    <span
                      style={{
                        display: "block",
                        fontSize: "10.5px",
                        color: "var(--color-ink-muted)",
                      }}
                    >
                      Your edits change the text directly
                    </span>
                  </span>
                </MenuRow>
                <MenuRow
                  active={suggesting}
                  onClick={() => {
                    onSetSuggesting(true);
                    close();
                  }}
                >
                  <span>
                    Suggesting
                    <span
                      style={{
                        display: "block",
                        fontSize: "10.5px",
                        color: "var(--color-ink-muted)",
                      }}
                    >
                      Your edits land as tracked changes
                    </span>
                  </span>
                </MenuRow>
                {onResolveAllMine && (
                  <>
                    <div className="rl-menu-sep" />
                    <div className="rl-menu-heading">Review</div>
                    <MenuRow
                      disabled={!hasUserRuns}
                      onClick={() => {
                        onResolveAllMine(true);
                        close();
                      }}
                    >
                      Keep all my changes
                    </MenuRow>
                    <MenuRow
                      disabled={!hasUserRuns}
                      onClick={() => {
                        onResolveAllMine(false);
                        close();
                      }}
                    >
                      Revert all my changes
                    </MenuRow>
                  </>
                )}
              </>
            )}
          </RibbonMenu>
        </Group>
      )}

      {/* Comments — the sidecar toggle, with a count badge when any exist. */}
      {onToggleSidecar && (
        <Group id="comments">
          <ToolButton
            title={
              sidecarOpen
                ? "Close the comment sidecar"
                : "Comments anchored to this draft"
            }
            active={sidecarOpen}
            onClick={onToggleSidecar}
            style={{ position: "relative" }}
          >
            <MessageSquare size={ICON} strokeWidth={STROKE} />
            {commentCount > 0 && (
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  top: "1px",
                  right: "1px",
                  minWidth: "13px",
                  height: "13px",
                  padding: "0 3px",
                  borderRadius: "7px",
                  fontSize: "9px",
                  lineHeight: "13px",
                  fontWeight: 600,
                  background: "var(--color-info)",
                  color: "var(--color-on-accent)",
                }}
              >
                {commentCount > 99 ? "99+" : commentCount}
              </span>
            )}
          </ToolButton>
        </Group>
      )}

      {/* The rest, when the pane is too narrow to carry them. Shown only when
          something actually left (pure CSS on `data-overflowing`), so a roomy
          ribbon never carries a dead control. */}
      <button
        type="button"
        aria-label={expanded ? "Hide the rest of the ribbon" : "Show the rest of the ribbon"}
        aria-expanded={expanded}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setExpanded((v) => !v)}
        className={`rl-ribbon-btn rl-ribbon-more${expanded ? " rl-ribbon-btn--active" : ""}`}
        style={btnBase}
      >
        <MoreHorizontal size={ICON} strokeWidth={STROKE} />
      </button>
    </div>
  );
}
