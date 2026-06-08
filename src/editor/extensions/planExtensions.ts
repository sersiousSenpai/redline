// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Code } from "@tiptap/extension-code";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";

import { AnchorIdAttribute } from "./AnchorIdAttribute";
import { BlockIdAttribute } from "./BlockIdAttribute";
import { richCodeBlock } from "./CodeBlockView";
import { DeletionMark, InsertionMark } from "./TrackChanges";
import { TrackChangesInput } from "./TrackChangesInput";

/**
 * The single source of truth for the plan editor's schema. Reused for both
 * the live editor and the headless schema (`@tiptap/core` `getSchema`) the
 * markdown parser/serializer build against, so round-trip and rendering can
 * never diverge.
 *
 * Native history stays ON (Cmd/Ctrl+Z). Programmatic reconcile and
 * track-change transactions are tagged `addToHistory: false` so undo only
 * ever reverts genuine user input, not derived marks.
 */
export function planExtensions(): Extensions {
  return [
    // StarterKit's bundled code block is swapped for `richCodeBlock()` —
    // CodeBlockLowlight + a NodeView for syntax highlighting and mermaid
    // diagrams. The `codeBlock` node spec (name, `language` attr, `text*`
    // content) is identical, so the schema and markdown round-trip are
    // unaffected; only the rendering is richer.
    // StarterKit's inline `code` mark ships `excludes: '_'` (exclude ALL other
    // marks). That silently blocked the rl_ins/rl_del track-change marks from
    // ever attaching to inline code, so Backspace/Strike did nothing on the
    // file-reference chips (`app/page.tsx`, etc.). Re-add code with an explicit
    // exclude list that keeps it plain against formatting marks but lets the
    // redline marks through.
    StarterKit.configure({ codeBlock: false, code: false }),
    Code.extend({ excludes: "bold italic strike link" }),
    richCodeBlock(),
    Link.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: false,
    }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    BlockIdAttribute,
    AnchorIdAttribute,
    InsertionMark,
    DeletionMark,
    TrackChangesInput,
  ];
}
