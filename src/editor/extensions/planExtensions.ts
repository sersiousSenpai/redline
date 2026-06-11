// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Code } from "@tiptap/extension-code";
import Collaboration from "@tiptap/extension-collaboration";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import type * as Y from "yjs";

import { AnchorIdAttribute } from "./AnchorIdAttribute";
import { BlockIdAttribute } from "./BlockIdAttribute";
import { richCodeBlock } from "./CodeBlockView";
import { DeletionMark, InsertionMark } from "./TrackChanges";
import { TrackChangesInput } from "./TrackChangesInput";

export interface PlanExtensionOptions {
  /** Bind the editor to this Y.Doc via the Collaboration extension. When set,
   *  StarterKit history is turned OFF (Collaboration ships the Yjs
   *  UndoManager instead) and document content lives in the CRDT. Omit for
   *  the headless schema (`getSchema` ignores plugins, so the node/mark model
   *  is identical either way) and for plain non-CRDT editors in tests. */
  document?: Y.Doc;
  /** M4: a user edit was blocked because its block carries a pending agent
   *  suggestion ("resolve it first" UI). */
  onLockedEdit?: (blockId: string) => void;
}

/**
 * The single source of truth for the plan editor's schema. Reused for both
 * the live editor and the headless schema (`@tiptap/core` `getSchema`) the
 * markdown parser/serializer build against, so round-trip and rendering can
 * never diverge.
 *
 * Undo (Cmd/Ctrl+Z): with a `document` bound, Collaboration's Yjs
 * UndoManager replaces StarterKit history. Programmatic reconcile and
 * track-change transactions stay tagged `addToHistory: false` — y-prosemirror
 * forwards that meta into the Yjs transaction and the UndoManager's
 * `captureTransaction` skips it, so undo only ever reverts genuine user
 * input, not derived marks (same invariant as before).
 */
export function planExtensions(
  options: PlanExtensionOptions = {},
): Extensions {
  const { document, onLockedEdit } = options;
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
    StarterKit.configure({
      codeBlock: false,
      code: false,
      ...(document ? { history: false } : {}),
    }),
    ...(document ? [Collaboration.configure({ document })] : []),
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
    TrackChangesInput.configure({ onLockedEdit }),
  ];
}
