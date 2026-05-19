import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";

import { AnchorIdAttribute } from "./AnchorIdAttribute";
import { BlockIdAttribute } from "./BlockIdAttribute";
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
    StarterKit,
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
