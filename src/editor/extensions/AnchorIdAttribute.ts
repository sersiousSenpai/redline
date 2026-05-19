import { Extension } from "@tiptap/core";

import { BLOCK_ID_NODE_TYPES } from "./BlockIdAttribute";

/**
 * Renders each top-level block's positional `anchorId` to the DOM as
 * `data-anchor-id`. Unlike `blockId` (model-only join key), this attribute is
 * needed in the DOM so the existing `useTextSelection` hook + the
 * Edit/Feedback/Question `SelectionMenu` work over the single-document editor
 * exactly as they did over the old per-block view. Populated after mount from
 * the section tree (PM/markdown don't carry positional anchors).
 */
export const AnchorIdAttribute = Extension.create({
  name: "anchorIdAttribute",

  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_ID_NODE_TYPES],
        attributes: {
          anchorId: {
            default: null,
            parseHTML: (el) => el.getAttribute("data-anchor-id"),
            renderHTML: (attrs) =>
              attrs.anchorId ? { "data-anchor-id": attrs.anchorId } : {},
          },
        },
      },
    ];
  },
});
