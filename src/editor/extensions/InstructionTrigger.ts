// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { isPendingSuggestionMark } from "./TrackChanges";

/**
 * The drafter's ✦ instruction trigger — the explicit entry point for
 * in-document co-authoring. Cmd/Ctrl+Enter (or the toolbar ✦ button) takes
 * the caret's paragraph as an instruction to the doc-side agent, which
 * consumes it via `replace_block` (see `draft_instruct` / the prompt
 * contract). Free-text instruction *detection* was rejected as fragile — the
 * trigger is always a deliberate user gesture.
 *
 * Also owns the "generating" paint: `setGeneratingBlocks` node-decorates the
 * target blocks with `.rl-generating` (a quiet pulse) until the suggestion
 * lands or the turn errors.
 */

interface GeneratingState {
  ids: Set<string>;
  decos: DecorationSet;
}

export const instructionTriggerKey = new PluginKey<GeneratingState>(
  "instructionTrigger",
);

export interface InstructionTriggerOptions {
  /** Fires with the caret block's identity + text when the user triggers an
   *  instruction (Mod-Enter / the toolbar ✦ button). */
  onInstruct?: (blockId: string, text: string) => void;
}

/**
 * The caret's top-level block IF it can carry an instruction: a non-empty
 * paragraph with a minted blockId and no pending suggestion marks (a block
 * mid-proposal must be resolved, not instructed over). Null otherwise —
 * which also lets Mod-Enter fall through to its default behavior there.
 */
export function resolveInstructionBlock(
  state: EditorState,
): { blockId: string; text: string } | null {
  const $head = state.selection.$head;
  if ($head.depth < 1) return null;
  const node = $head.node(1);
  if (node.type.name !== "paragraph") return null;
  const blockId = (node.attrs?.blockId as string | null) ?? null;
  if (!blockId) return null;
  const text = node.textContent.trim();
  if (!text) return null;
  let pending = false;
  node.descendants((n) => {
    if (pending) return false;
    if (n.isText && n.marks.some(isPendingSuggestionMark)) pending = true;
    return !pending;
  });
  return pending ? null : { blockId, text };
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    instructionTrigger: {
      /** Send the caret's paragraph as a ✦ instruction (toolbar twin of
       *  Mod-Enter). False when the caret block can't carry one. */
      instructAtCaret: () => ReturnType;
      /** Replace the set of blocks painted as "generating" (pulsing). */
      setGeneratingBlocks: (blockIds: string[]) => ReturnType;
    };
  }
}

function generatingDecorations(
  state: EditorState,
  ids: ReadonlySet<string>,
): DecorationSet {
  if (ids.size === 0) return DecorationSet.empty;
  const decos: Decoration[] = [];
  state.doc.forEach((node, pos) => {
    const id = node.attrs?.blockId as string | null;
    if (id && ids.has(id)) {
      decos.push(
        Decoration.node(pos, pos + node.nodeSize, { class: "rl-generating" }),
      );
    }
  });
  return DecorationSet.create(state.doc, decos);
}

export const InstructionTrigger =
  Extension.create<InstructionTriggerOptions>({
    name: "instructionTrigger",

    // Above default (100): StarterKit's HardBreak also binds Mod-Enter, and
    // keymaps run in plugin order — ours must see the key first. In any
    // context where instructAtCaret declines (code block, empty paragraph,
    // pending marks) the key still falls through to the default.
    priority: 1000,

    addOptions() {
      return { onInstruct: undefined };
    },

    addKeyboardShortcuts() {
      return {
        "Mod-Enter": () => this.editor.commands.instructAtCaret(),
      };
    },

    addCommands() {
      return {
        instructAtCaret:
          () =>
          ({ state }) => {
            const target = resolveInstructionBlock(state);
            if (!target) return false;
            this.options.onInstruct?.(target.blockId, target.text);
            return true;
          },
        setGeneratingBlocks:
          (blockIds: string[]) =>
          ({ tr, dispatch }) => {
            if (dispatch) tr.setMeta(instructionTriggerKey, blockIds);
            return true;
          },
      };
    },

    addProseMirrorPlugins() {
      return [
        new Plugin<GeneratingState>({
          key: instructionTriggerKey,
          state: {
            init: () => ({ ids: new Set(), decos: DecorationSet.empty }),
            apply(tr, prev, _old, newState) {
              const ids = tr.getMeta(instructionTriggerKey) as
                | string[]
                | undefined;
              if (ids) {
                const set = new Set(ids);
                return {
                  ids: set,
                  decos: generatingDecorations(newState, set),
                };
              }
              // Node decorations don't survive arbitrary structural edits —
              // rebuild from the id set whenever the doc moves.
              if (!tr.docChanged) return prev;
              return {
                ids: prev.ids,
                decos: generatingDecorations(newState, prev.ids),
              };
            },
          },
          props: {
            decorations(state) {
              return instructionTriggerKey.getState(state)?.decos ?? null;
            },
          },
        }),
      ];
    },
  });
