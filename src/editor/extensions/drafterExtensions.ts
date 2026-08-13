// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Code } from "@tiptap/extension-code";
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
import { ListStyle } from "./ListStyle";
import { SearchHighlight } from "./SearchHighlight";
import { TableControls } from "./TableControls";
import { TableAlign } from "./TableAlign";
import { TrailingNode } from "./TrailingNode";
import { BlockIdAttribute } from "./BlockIdAttribute";
import { AnchorIdAttribute } from "./AnchorIdAttribute";
import { DraftBlockIds } from "./DraftBlockIds";
import { InsertionMark, DeletionMark } from "./TrackChanges";
import { TrackChangesInput } from "./TrackChangesInput";
import { InstructionTrigger } from "./InstructionTrigger";
import { CommentHighlights } from "./CommentHighlights";

export interface DrafterExtensionOptions {
  /** Surfaced when a user edit is filtered because its block carries a
   *  pending agent suggestion — "resolve it first". */
  onLockedEdit?: (blockId: string) => void;
  /** The ✦ in-document instruction trigger (Mod-Enter / toolbar): fires with
   *  the caret paragraph's blockId + text for `draft_instruct`. */
  onInstruct?: (blockId: string, text: string) => void;
}

/**
 * Extension set for the standalone Prompt Drafter — a Word-style document
 * editor used to author a prompt before launching a Claude Code plan session.
 *
 * Deliberately decoupled from `planExtensions`: the drafter has no review
 * pipeline, so it drops Collaboration (Yjs CRDT) and the rich code-block
 * NodeView (StarterKit's plain code block suffices).
 *
 * What it now SHARES with the plan editor is agent-facing identity + tracked
 * suggestions: BlockId/AnchorId attributes (ids self-minted by DraftBlockIds —
 * there's no Rust parser round-trip to mint them), the Insertion/Deletion
 * marks (agent write-suggestions render as pending tracked changes with
 * accept/reject — see `../drafterSuggestions.ts`), TrackChangesInput (block
 * locking always; live Suggesting mode when the user flips the toolbar
 * toggle — it starts OFF, unlike the plan editor), and CommentHighlights (the
 * draft comment sidecar anchors selections exactly like plan comments).
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
export function drafterExtensions(
  options: DrafterExtensionOptions = {},
): Extensions {
  const { onLockedEdit, onInstruct } = options;
  return [
    // StarterKit ships history ON by default (no Collaboration here), giving
    // native Cmd/Ctrl+Z undo. Its bundled plain `codeBlock` suffices, but the
    // bundled `code` mark ships `excludes: '_'` (exclude ALL other marks),
    // which silently blocked rl_ins/rl_del from ever attaching to inline code
    // — an agent rewrite touching a code span lost its tracked paint. Re-add
    // it excluding only the formatting marks, letting the redline marks
    // through (the plan editor's fix, widened to the drafter's mark set).
    StarterKit.configure({ code: false }),
    Code.extend({
      excludes: "bold italic strike link underline highlight textStyle",
    }),
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
    // Word-style list numbering / bullet styles (Roman, alpha, greek,
    // parenthetical, …). Unlike the visual aids above, `listStyle` is semantic
    // and DOES serialize — the emitted marker matches what's on screen.
    ListStyle,
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
    // Agent-facing block identity: `blockId`/`anchorId` attributes rendered to
    // the DOM (selection capture + suggestion addressing), with ids
    // self-minted by DraftBlockIds since no Rust parse ever stamps a draft.
    BlockIdAttribute,
    AnchorIdAttribute,
    DraftBlockIds,
    // Tracked-change marks for agent write-suggestions (accept/reject), plus
    // the input tracker: block locking guards pending agent suggestions from
    // being typed through in EVERY mode; live Suggesting (keystrokes → tracked
    // runs) starts OFF and is flipped by the toolbar's Editing/Suggesting
    // toggle via `setSuggesting`.
    InsertionMark,
    DeletionMark,
    TrackChangesInput.configure({ onLockedEdit, initialSuggesting: false }),
    // ✦ co-authoring: Mod-Enter / the toolbar button sends the caret's
    // paragraph to the doc-side agent as an instruction; also paints the
    // pulsing "generating" state on the target block.
    InstructionTrigger.configure({ onInstruct }),
    // Selection-anchored comment highlights for the draft sidecar.
    CommentHighlights,
  ];
}
