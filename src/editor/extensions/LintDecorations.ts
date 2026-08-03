// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { isLintName, type LintName } from "../../theme/lint";
import { tokenizeLint } from "./lintTokenize";

// IDE-style "linting" for the plan document: when a lint theme is active,
// tokenize every text node in the doc and lay down inline decorations tagging
// numbers, strings, brackets, URLs/paths and ALL-CAPS keywords with
// `rl-lint--<kind>` classes. The colors themselves come from styles.css keyed on
// `:root[data-lint]`, so switching between lint themes never touches this
// plugin — only turning linting fully off vs on changes what it emits.
//
// Cost discipline (see the render-isolation work): when linting is off — the
// default — this emits an empty set and never scans. It rebuilds only when the
// doc changes or a lint-change signal fires, mapping decorations through other
// transactions untouched, so typing pays one scan per edit, not one per render.

/** The window event applyLint() dispatches when the user picks a lint theme,
 *  so every mounted editor refreshes its decorations without prop threading. */
export const LINT_CHANGE_EVENT = "redline:lintchange";

export const lintDecorationsKey = new PluginKey("lintDecorations");

/** Read the active lint theme off <html data-lint>. `off`/absent/unknown all
 *  mean "no coloring". Kept here so the plugin has a single source of truth. */
function activeLint(): LintName {
  if (typeof document === "undefined") return "off";
  const raw = document.documentElement.dataset.lint;
  return isLintName(raw) ? raw : "off";
}

/** Build the decoration set for the whole document. Returns `DecorationSet.empty`
 *  when linting is off so the default path allocates nothing. */
function buildDecorations(doc: import("@tiptap/pm/model").Node): DecorationSet {
  if (activeLint() === "off") return DecorationSet.empty;
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const t of tokenizeLint(node.text)) {
      decos.push(
        Decoration.inline(pos + t.start, pos + t.end, {
          class: `rl-lint rl-lint--${t.kind}`,
        }),
      );
    }
  });
  return DecorationSet.create(doc, decos);
}

export const LintDecorations = Extension.create({
  name: "lintDecorations",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: lintDecorationsKey,
        state: {
          init: (_config, state) => buildDecorations(state.doc),
          apply(tr, old) {
            // A lint-change signal (meta) forces a full rebuild; otherwise a
            // doc edit rebuilds, and any other transaction just re-maps.
            if (tr.getMeta(lintDecorationsKey)) return buildDecorations(tr.doc);
            if (tr.docChanged) return buildDecorations(tr.doc);
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return lintDecorationsKey.getState(state);
          },
        },
        view(view) {
          // Refresh when the user switches lint theme (or turns it off/on).
          const onChange = () =>
            view.dispatch(view.state.tr.setMeta(lintDecorationsKey, true));
          window.addEventListener(LINT_CHANGE_EVENT, onChange);
          return {
            destroy() {
              window.removeEventListener(LINT_CHANGE_EVENT, onChange);
            },
          };
        },
      }),
    ];
  },
});
