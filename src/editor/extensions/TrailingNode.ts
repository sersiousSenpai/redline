// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { NodeType } from "@tiptap/pm/model";

/**
 * TrailingNode — always keep an empty paragraph at the end of the document.
 *
 * ProseMirror happily lets a document end in an "isolating" block — a
 * horizontal rule, a table, a code block — with nothing after it. When that
 * happens there's nowhere to put the caret *below* that block, so (e.g.) adding
 * a divider strands the cursor: you can't click into the document beneath it.
 * Word/Notion avoid this by always leaving a trailing empty line.
 *
 * This appends a trailing paragraph whenever the document's last node isn't
 * already one. The extra empty paragraph is harmless in the markdown the
 * drafter sends (just a trailing blank line). Our own Apache-2.0 code.
 */

interface TrailingNodeOptions {
  /** The node to append (a paragraph). */
  node: string;
  /** Last-node types that do NOT need a trailing paragraph after them. */
  notAfter: string[];
}

export const TrailingNode = Extension.create<TrailingNodeOptions>({
  name: "trailingNode",

  addOptions() {
    return { node: "paragraph", notAfter: ["paragraph"] };
  },

  addProseMirrorPlugins() {
    const pluginKey = new PluginKey(this.name);
    const disabledNodes: NodeType[] = Object.values(this.editor.schema.nodes).filter(
      (node) => this.options.notAfter.includes(node.name),
    );
    const lastNodeAllowed = (lastChild: { type: NodeType } | null) =>
      !!lastChild && disabledNodes.includes(lastChild.type);

    return [
      new Plugin({
        key: pluginKey,
        appendTransaction: (_transactions, _oldState, state) => {
          if (!pluginKey.getState(state)) return undefined;
          const { doc, tr, schema } = state;
          const type = schema.nodes[this.options.node];
          if (!type) return undefined;
          return tr.insert(doc.content.size, type.create());
        },
        state: {
          // Plugin state = "should a trailing node be inserted?".
          init: (_config, state) =>
            !lastNodeAllowed(state.doc.lastChild),
          apply: (tr, value) => {
            if (!tr.docChanged) return value;
            return !lastNodeAllowed(tr.doc.lastChild);
          },
        },
      }),
    ];
  },
});
