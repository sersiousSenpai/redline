// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Code } from "@tiptap/extension-code";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
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

/** Remote-cursor wiring for a live collaboration session. `awareness` is the
 *  network provider's y-protocols Awareness instance (typed loosely so this
 *  schema module never imports the transport). Requires `document`. */
export interface PlanCursorOptions {
  awareness: unknown;
  user: { name: string; color: string };
}

export interface PlanExtensionOptions {
  /** Bind the editor to this Y.Doc via the Collaboration extension. When set,
   *  StarterKit history is turned OFF (Collaboration ships the Yjs
   *  UndoManager instead) and document content lives in the CRDT. Omit for
   *  the headless schema (`getSchema` ignores plugins, so the node/mark model
   *  is identical either way) and for plain non-CRDT editors in tests. */
  document?: Y.Doc;
  /** Live-session remote carets/selections (CollaborationCursor). Cursor
   *  state rides awareness, not the doc — the schema is unchanged, so the
   *  markdown round-trip and `getSchema` are unaffected. */
  cursor?: PlanCursorOptions;
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
  const { document, cursor, onLockedEdit } = options;
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
    // CollaborationCursor expects `{ provider: { awareness } }`; it stores
    // the local user in awareness and decorates remote selections. Attached
    // only when a live provider exists, so solo editing pays nothing.
    ...(document && cursor
      ? [
          CollaborationCursor.configure({
            provider: { awareness: cursor.awareness },
            user: cursor.user,
          }),
        ]
      : []),
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
