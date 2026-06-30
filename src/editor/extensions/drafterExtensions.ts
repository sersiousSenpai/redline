// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import TextStyle from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import FontFamily from "@tiptap/extension-font-family";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import { FontSize } from "./FontSize";
import { LineHeight } from "./LineHeight";
import { Indent } from "./Indent";
import { SearchHighlight } from "./SearchHighlight";
import { TableControls } from "./TableControls";
import { TableAlign } from "./TableAlign";
import { TrailingNode } from "./TrailingNode";

/**
 * Extension set for the standalone Prompt Drafter — a Word-style document
 * editor used to author a prompt before launching a Claude Code plan session.
 *
 * Deliberately decoupled from `planExtensions`: the drafter is a throwaway
 * authoring surface with no review semantics, so it drops everything tied to
 * track-changes and the plan-review pipeline — Collaboration (Yjs CRDT),
 * BlockId/AnchorId attributes, the Insertion/Deletion marks, TrackChangesInput,
 * and the rich code-block NodeView (StarterKit's plain code block suffices).
 *
 * What it keeps is the everyday Word toolset: headings, bold/italic/strike,
 * lists, blockquote, code/code block, hr, undo/redo (StarterKit), tables, plus
 * inline links, underline, text alignment, font family/size, text color,
 * highlight, line spacing, and indent/outdent.
 *
 * The prompt is serialized to markdown only at send time via
 * `planDocToMarkdown`. Tables, links, lists, headings and code DO serialize.
 * The purely-visual drafting aids do NOT: the serializer ignores the
 * `underline`/`highlight`/`textStyle` (font, size, color) marks and never
 * reads `textAlign`, `lineHeight`, or the `indent` level — they're for the
 * human drafter, not semantic content for Claude. (Confirmed: `wrapMarks`
 * wraps only code/strike/italic/bold/link; unknown marks/attrs pass through
 * untouched.)
 */
export function drafterExtensions(): Extensions {
  return [
    // StarterKit ships history ON by default (no Collaboration here), giving
    // native Cmd/Ctrl+Z undo. Its bundled `code`/`codeBlock` are fine in this
    // editor — there are no track-change marks for the `code` mark's
    // `excludes: '_'` to silently block.
    StarterKit,
    Link.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: false,
    }),
    Underline,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    // Word-style highlighter with a color palette (multicolor). A drafting aid
    // only — the markdown serializer ignores the `highlight` mark at send time
    // (like `underline`).
    Highlight.configure({ multicolor: true }),
    // Character formatting hung off the shared `textStyle` mark. TextStyle must
    // precede Color/FontFamily/FontSize, which register attributes on it.
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    // Paragraph-level Word affordances (visual-only attributes).
    LineHeight,
    Indent,
    // Tables. Unlike the formatting aids above, tables DO serialize to markdown,
    // so they carry real structure into the sent prompt. `resizable` gives the
    // Word-like column drag handles.
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    // Word-like whole-table deletion: select the entire table → Delete removes
    // it (instead of just clearing cell contents).
    TableControls,
    // Word-style alignment of the whole table on the page (left/center/right).
    TableAlign,
    // In-document find (Cmd/Ctrl+F). Self-contained — owns match positions +
    // decorations off the editor doc, no backend. The drafter's find bar drives
    // it and layers replace on top via plain editor transactions.
    SearchHighlight,
    // Always keep a trailing empty paragraph so the caret can land below a
    // divider/table/code block at the end of the document.
    TrailingNode,
  ];
}
