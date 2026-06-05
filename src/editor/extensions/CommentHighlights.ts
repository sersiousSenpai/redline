// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import {
  blockKindForTag,
  resolveSubBlockId,
} from "../subBlockResolve";

/** A persistent highlight over a comment's selected character range. The
 *  decoration is keyed by `(blockId, charStart, charEnd)` with three
 *  resolution tiers (see {@link resolveRange}): the sub-block id is tried
 *  first when present, then the stored char range, finally `quotedText`
 *  self-heal. */
export interface CommentHighlightRange {
  commentId: string;
  blockId: string;
  charStart: number;
  charEnd: number;
  quotedText: string;
  /** Optional sub-block sidecar id (e.g. `blk-X.s3.w2-w4`) — when set, the
   *  resolver tries it first because it survives reflow inside the parent
   *  block. */
  subBlockId?: string;
  /** Resolved/accepted comments fade their highlight to a muted state but
   *  stay visible (audit trail). */
  muted: boolean;
}

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

/** Resolve a stored selection to ProseMirror positions inside `blockText`,
 *  trying three tiers in order:
 *
 *  1. **Sub-block id** (`blk-X.s3.w2-w4`) — stable across any revise that
 *     leaves the parent block's body byte-identical. When present and
 *     resolvable against the current text, this is the highest-fidelity
 *     anchor we have.
 *  2. **Stored char range** — fast path when the byte slice still equals
 *     `quotedText` (no edits inside the block since capture).
 *  3. **`quotedText` self-heal** — `indexOf` lookup; rescues the highlight
 *     when offsets drifted but the quoted substring still appears
 *     somewhere in the block. */
export function resolveRange(
  blockText: string,
  blockTagName: string,
  range: CommentHighlightRange,
): { from: number; to: number } | null {
  if (range.subBlockId) {
    const resolved = resolveSubBlockId({
      blockText,
      kind: blockKindForTag(blockTagName),
      subBlockId: range.subBlockId,
    });
    // Only trust the sub-block tier when its slice actually matches the
    // captured `quotedText`. The id is minted against the whole-block DOM
    // textContent at selection time but resolved here against a single inner
    // textblock — for lists/blockquotes those texts differ, so a stale id can
    // resolve to a wrong (but non-null) range. Validating before returning
    // lets a mismatch fall through to the proven char-range / quotedText tiers
    // instead of painting (or losing) the highlight at the wrong spot.
    if (
      resolved &&
      resolved.end > resolved.start &&
      (range.quotedText.length === 0 ||
        blockText.slice(resolved.start, resolved.end) === range.quotedText)
    ) {
      return { from: resolved.start, to: resolved.end };
    }
  }
  const { charStart, charEnd, quotedText } = range;
  if (
    charStart >= 0 &&
    charEnd <= blockText.length &&
    blockText.slice(charStart, charEnd) === quotedText
  ) {
    return { from: charStart, to: charEnd };
  }
  if (quotedText.length === 0) return null;
  const idx = blockText.indexOf(quotedText);
  if (idx === -1) return null;
  return { from: idx, to: idx + quotedText.length };
}

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
              if (!target) return;
              const text = target.node.textContent;
              // First doc position INSIDE the textblock is `blockOffset +
              // target.offset + 1` (the `+1` steps through the opening
              // token of the textblock node).
              const base = blockOffset + target.offset + 1;
              // Sub-block-id resolution needs the block's tag (PRE / UL /
              // BLOCKQUOTE → line axis; everything else → sentence axis).
              // The PM Node has the type name; map to the equivalent DOM
              // tag for `blockKindForTag`.
              const blockTagName = pmNodeTagName(blockNode);
              for (const range of ranges) {
                const resolved = resolveRange(text, blockTagName, range);
                if (!resolved) continue;
                const classes = ["rl-comment-highlight"];
                if (range.muted) classes.push("rl-comment-highlight--muted");
                if (storage.focusedId === range.commentId)
                  classes.push("rl-comment-highlight--focused");
                decos.push(
                  Decoration.inline(
                    base + resolved.from,
                    base + resolved.to,
                    {
                      class: classes.join(" "),
                      "data-comment-id": range.commentId,
                      nodeName: "span",
                    },
                  ),
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
