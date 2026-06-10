// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Mark, mergeAttributes } from "@tiptap/core";
import type { Mark as PMMark, Node as PMNode } from "@tiptap/pm/model";

/**
 * Word-style tracked-change marks — since M3 the *source of truth* for
 * suggestions. They live inside the per-revision Y.Doc (and therefore in the
 * IndexedDB crash-recovery copy), and the comment sidebar is a projection
 * over them, not the other way around:
 *
 *  - `rl_ins` — proposed insertion (distinct color)
 *  - `rl_del` — proposed deletion (kept in place, struck-through + faded)
 *
 * Each mark carries identity:
 *  - `authorId` — who proposed it ("user" today; agent ids in M4).
 *  - `suggestionId` — stable id for one contiguous suggestion run.
 *  - `status` — "pending" (an open proposal feeding the sidebar projection)
 *    or "display" (presentation-only paint, e.g. the vN-vs-vN-1 revision
 *    redline; never projected to comments). "accepted"/"rejected" are
 *    reserved for M4 in-place resolution — today both transitions remove the
 *    mark instead.
 *
 * The serializer accepts all changes (drops `rl_del` text, unwraps `rl_ins`)
 * so per-block accept-all serialization always yields the clean `revised`
 * text the changeLedger projects to the sidebar.
 */

export type SuggestionStatus = "pending" | "display";

/** The local reviewer's author id (M4 introduces agent authors). */
export const USER_AUTHOR = "user";

export function newSuggestionId(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `sg-${rand}`;
}

const SUGGESTION_MARKS: ReadonlySet<string> = new Set(["rl_ins", "rl_del"]);

/** True for an open suggestion proposal. Marks restored from pre-M3 docs
 *  carry no attrs and default to pending — every pre-M3 non-display mark was
 *  a live proposal, so the default is the faithful migration. */
export function isPendingSuggestionMark(mark: PMMark): boolean {
  if (!SUGGESTION_MARKS.has(mark.type.name)) return false;
  return (mark.attrs.status ?? "pending") === "pending";
}

/** Does any text leaf inside `node` carry an open suggestion? */
export function hasPendingSuggestions(node: PMNode): boolean {
  let found = false;
  node.descendants((n) => {
    if (found) return false;
    if (n.isText && n.marks.some(isPendingSuggestionMark)) found = true;
    return !found;
  });
  return found;
}

function suggestionAttributes() {
  return {
    blockId: { default: null },
    authorId: {
      default: USER_AUTHOR,
      parseHTML: (el: HTMLElement) => el.getAttribute("data-rl-author"),
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.authorId ? { "data-rl-author": attrs.authorId } : {},
    },
    suggestionId: {
      default: null,
      parseHTML: (el: HTMLElement) => el.getAttribute("data-rl-suggestion"),
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.suggestionId ? { "data-rl-suggestion": attrs.suggestionId } : {},
    },
    status: {
      default: "pending",
      parseHTML: (el: HTMLElement) =>
        el.getAttribute("data-rl-status") ?? "pending",
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.status ? { "data-rl-status": attrs.status } : {},
    },
  };
}

export const InsertionMark = Mark.create({
  name: "rl_ins",
  inclusive: false,
  addAttributes() {
    return suggestionAttributes();
  },
  parseHTML() {
    return [{ tag: "ins[data-rl]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "ins",
      mergeAttributes(HTMLAttributes, { "data-rl": "ins", class: "rl-ins" }),
      0,
    ];
  },
});

export const DeletionMark = Mark.create({
  name: "rl_del",
  inclusive: false,
  addAttributes() {
    return suggestionAttributes();
  },
  parseHTML() {
    return [{ tag: "del[data-rl]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "del",
      mergeAttributes(HTMLAttributes, { "data-rl": "del", class: "rl-del" }),
      0,
    ];
  },
});
