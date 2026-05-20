// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";

/**
 * Adds a model-only `blockId` attribute to every top-level block node.
 *
 * The id is the stable join key minted by the Rust parser
 * (`src-tauri/src/parser.rs`) and carried in markdown as a
 * `<!-- rl:blk-xxxx -->` sidecar. It is intentionally NOT serialized to the
 * DOM — it lives only in the ProseMirror document model and is round-tripped
 * through markdown by the custom serializer/parser in `../markdown`.
 */
export const BLOCK_ID_NODE_TYPES = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "codeBlock",
  "blockquote",
  "horizontalRule",
  "table",
] as const;

export const BlockIdAttribute = Extension.create({
  name: "blockIdAttribute",

  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_ID_NODE_TYPES],
        attributes: {
          blockId: {
            default: null,
            // Model-only: never read from or written to the DOM.
            rendered: false,
            keepOnSplit: false,
          },
        },
      },
    ];
  },
});
