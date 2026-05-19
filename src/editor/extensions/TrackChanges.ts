import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * Word-style tracked-change marks. These are a *projection* of the existing
 * `edit` comment model (rendered by `applyCommentOverridesToEditor` via
 * `diffWords`), not a parallel store:
 *
 *  - `rl_ins` — proposed insertion (distinct color)
 *  - `rl_del` — proposed deletion (kept in place, struck-through + faded)
 *
 * The serializer accepts all changes (drops `rl_del` text, unwraps `rl_ins`)
 * so the changeLedger always sees clean `{original, revised}` and the
 * doc↔comment sync is unaffected.
 */
export const InsertionMark = Mark.create({
  name: "rl_ins",
  inclusive: false,
  addAttributes() {
    return {
      blockId: { default: null },
      changeId: { default: null },
    };
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
    return {
      blockId: { default: null },
      changeId: { default: null },
    };
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
