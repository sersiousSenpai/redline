// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { resolveRange, type CommentHighlightRange } from "../resolveHighlightRange";
import { parseSidecarIdTyped } from "../markdown/sidecar";
import { resolveWordsInUnit } from "../subBlockResolve";
import { findUnitNode } from "../unitResolve";

// Re-exported so existing importers (PlanEditor) keep their import path. The
// type + tiered resolver now live in `resolveHighlightRange` so the static-HTML
// overlay can share them without depending on ProseMirror.
export type { CommentHighlightRange };

interface CommentHighlightsStorage {
  ranges: CommentHighlightRange[];
  focusedId: string | null;
  onClick: ((commentId: string) => void) | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    commentHighlights: {
      /** Replace the highlight range list and repaint decorations. */
      setCommentHighlights: (ranges: CommentHighlightRange[]) => ReturnType;
      /** Set the focused comment id (or null to clear) — adds the
       *  `--focused` modifier to the matching decoration. */
      focusCommentHighlight: (commentId: string | null) => ReturnType;
      /** Register a callback for clicks on any highlight. Replaces any
       *  previously-bound handler. */
      bindHighlightClick: (
        handler: ((commentId: string) => void) | null,
      ) => ReturnType;
    };
  }
}

export const commentHighlightsKey = new PluginKey("commentHighlights");

/** Map a ProseMirror node type to the DOM tag name `blockKindForTag` keys
 *  on. The mapping mirrors the default Tiptap renderer (codeBlock → pre,
 *  bulletList → ul, etc.) so the resolver's axis pick matches what the
 *  user sees in the editor. */
function pmNodeTagName(node: import("@tiptap/pm/model").Node): string {
  switch (node.type.name) {
    case "codeBlock":
      return "PRE";
    case "bulletList":
      return "UL";
    case "orderedList":
      return "OL";
    case "listItem":
      return "LI";
    case "blockquote":
      return "BLOCKQUOTE";
    case "table":
      return "TABLE";
    case "heading": {
      const level = (node.attrs?.level as number | undefined) ?? 1;
      return `H${level}`;
    }
    default:
      return "P";
  }
}

/** Locate the first textblock (paragraph or heading) descendant of `node`
 *  along with its position offset from `node`'s start. Matches the convention
 *  in `applyCommentOverridesToEditor` — comment selections live in prose
 *  paragraphs, so we descend through list-item / blockquote wrappers if any
 *  exist. */
function firstTextblockInside(
  node: import("@tiptap/pm/model").Node,
): { node: import("@tiptap/pm/model").Node; offset: number } | null {
  if (node.isTextblock) return { node, offset: 0 };
  let found: { node: import("@tiptap/pm/model").Node; offset: number } | null =
    null;
  node.descendants((child, pos) => {
    if (found) return false;
    if (child.isTextblock) {
      found = { node: child, offset: pos };
      return false;
    }
    return true;
  });
  return found;
}

/** Word-style comment highlights over arbitrary character ranges inside a
 *  block, click-bridged to a focus callback so the sidebar card and the
 *  in-doc selection can mirror each other. Does not touch existing block /
 *  inline mark decorations — sits as a separate decoration layer on top. */
export const CommentHighlights = Extension.create<
  unknown,
  CommentHighlightsStorage
>({
  name: "commentHighlights",

  addStorage() {
    return {
      ranges: [],
      focusedId: null,
      onClick: null,
    };
  },

  addCommands() {
    return {
      setCommentHighlights:
        (ranges) =>
        ({ editor, tr, dispatch }) => {
          editor.storage.commentHighlights.ranges = ranges;
          if (dispatch) dispatch(tr.setMeta(commentHighlightsKey, true));
          return true;
        },
      focusCommentHighlight:
        (commentId) =>
        ({ editor, tr, dispatch }) => {
          editor.storage.commentHighlights.focusedId = commentId;
          if (dispatch) dispatch(tr.setMeta(commentHighlightsKey, true));
          return true;
        },
      bindHighlightClick:
        (handler) =>
        ({ editor }) => {
          editor.storage.commentHighlights.onClick = handler;
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const extension = this;
    return [
      new Plugin({
        key: commentHighlightsKey,
        props: {
          decorations(state) {
            const storage: CommentHighlightsStorage =
              extension.editor.storage.commentHighlights;
            if (storage.ranges.length === 0) return DecorationSet.empty;

            // Group ranges by blockId for a single pass over the doc.
            const byBlock = new Map<string, CommentHighlightRange[]>();
            for (const r of storage.ranges) {
              const list = byBlock.get(r.blockId);
              if (list) list.push(r);
              else byBlock.set(r.blockId, [r]);
            }

            const decos: Decoration[] = [];
            state.doc.forEach((blockNode, blockOffset) => {
              const blockId = blockNode.attrs.blockId as string | null;
              if (!blockId) return;
              const ranges = byBlock.get(blockId);
              if (!ranges) return;
              const target = firstTextblockInside(blockNode);
              // First doc position INSIDE the first textblock is `blockOffset +
              // target.offset + 1` (the `+1` steps through the opening token of
              // the textblock node). Only needed for the legacy fallback path.
              const legacyText = target ? target.node.textContent : "";
              const legacyBase = target ? blockOffset + target.offset + 1 : 0;
              // Sub-block-id resolution needs the block's tag (PRE / UL /
              // BLOCKQUOTE → line axis; everything else → sentence axis).
              // The PM Node has the type name; map to the equivalent DOM
              // tag for `blockKindForTag`.
              const blockTagName = pmNodeTagName(blockNode);
              for (const range of ranges) {
                let from: number | null = null;
                let to: number | null = null;

                // Tier 0 — line-axis unit path. A `.lN` id addresses one list
                // item / table cell / code source line; resolve the word range
                // against that unit's own text so structured blocks no longer
                // collapse to their first inner textblock (items 1, 6, 9).
                const parsed = range.subBlockId
                  ? parseSidecarIdTyped(range.subBlockId)
                  : null;
                if (
                  parsed &&
                  parsed.kind === "subBlock" &&
                  parsed.axis.kind === "line"
                ) {
                  const unit = findUnitNode(blockNode, parsed.axis);
                  if (unit) {
                    const wr = resolveWordsInUnit(unit.unitText, parsed.words);
                    // Validate against the captured quote before trusting a
                    // derived index — a drifted unit resolves to a non-matching
                    // slice and falls through to the proven char/quotedText
                    // tiers instead of painting at the wrong spot.
                    if (
                      wr &&
                      wr.end > wr.start &&
                      (range.quotedText.length === 0 ||
                        unit.unitText.slice(wr.start, wr.end) ===
                          range.quotedText)
                    ) {
                      const unitBase =
                        blockOffset + unit.contentStart + unit.charBase;
                      from = unitBase + wr.start;
                      to = unitBase + wr.end;
                    }
                  }
                }

                // Legacy tiers (sub-id on the first textblock → char range →
                // quotedText self-heal) for everything the unit path didn't
                // claim.
                if (from === null && target) {
                  const resolved = resolveRange(legacyText, blockTagName, range);
                  if (resolved) {
                    from = legacyBase + resolved.from;
                    to = legacyBase + resolved.to;
                  }
                }

                if (from === null || to === null) continue;
                const classes = ["rl-comment-highlight"];
                if (range.muted) classes.push("rl-comment-highlight--muted");
                if (storage.focusedId === range.commentId)
                  classes.push("rl-comment-highlight--focused");
                decos.push(
                  Decoration.inline(from, to, {
                    class: classes.join(" "),
                    "data-comment-id": range.commentId,
                    nodeName: "span",
                  }),
                );
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
          handleDOMEvents: {
            click(_view, event) {
              const onClick =
                extension.editor.storage.commentHighlights.onClick;
              if (!onClick) return false;
              let el: Node | null = event.target as Node;
              while (el && el !== document.body) {
                if (el instanceof HTMLElement) {
                  const id = el.dataset.commentId;
                  if (id) {
                    onClick(id);
                    // Don't consume — keep ProseMirror's default cursor
                    // placement so the user can type inside the highlight
                    // (Word's behaviour: click a highlight, the cursor
                    // lands there and the card focuses in the sidebar).
                    return false;
                  }
                }
                el = el.parentNode;
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});
