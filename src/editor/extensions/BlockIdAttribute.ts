// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";

/**
 * Adds a `blockId` attribute to every top-level block node.
 *
 * The id is the stable join key minted by the Rust parser
 * (`src-tauri/src/parser.rs`) and carried in markdown as a
 * `<!-- rl:blk-xxxx -->` sidecar. The custom markdown serializer/parser in
 * `../markdown` is the authoritative wire format — DOM rendering is a
 * separate concern, surfaced as `data-block-id` so selection-capture code
 * (`useTextSelection`) can pick up the stable id without needing a handle
 * on the live Tiptap editor instance.
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
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute("data-block-id"),
            renderHTML: (attrs) =>
              attrs.blockId ? { "data-block-id": attrs.blockId } : {},
          },
        },
      },
    ];
  },
});
