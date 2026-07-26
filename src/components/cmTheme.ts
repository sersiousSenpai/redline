// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// CodeMirror theme for the folder-viewer editor. Colors are literal
// `var(--color-…)` strings — CSS variables resolve at paint time, so every
// app theme (and live theme switching) works without regenerating anything.
// The token map mirrors the hljs palette in styles.css (`.rl-code-view`), and
// the chrome metrics mirror CodeView's (12.5px mono at 18px lines, 16px
// side padding) so toggling Edit doesn't make the text jump.

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** Lezer tags → the shared --color-hl-* palette (styles.css:.rl-code-view). */
const redlineHighlightStyle = HighlightStyle.define([
  {
    tag: [t.comment, t.quote],
    color: "var(--color-hl-comment)",
    fontStyle: "italic",
  },
  {
    tag: [
      t.keyword,
      t.operatorKeyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.bool,
      t.null,
      t.self,
      t.heading,
      t.link,
    ],
    color: "var(--color-hl-keyword)",
  },
  {
    tag: [t.string, t.special(t.string), t.regexp, t.inserted, t.attributeValue],
    color: "var(--color-hl-string)",
  },
  {
    tag: [t.number, t.typeName, t.className, t.standard(t.variableName), t.atom],
    color: "var(--color-hl-number)",
  },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.variableName),
      t.tagName,
      t.attributeName,
      t.propertyName,
    ],
    color: "var(--color-hl-title)",
  },
  {
    tag: [t.variableName, t.meta, t.macroName, t.labelName],
    color: "var(--color-hl-variable)",
  },
  { tag: t.deleted, color: "var(--color-hl-deletion)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
]);

const redlineEditorChrome = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12.5px",
    backgroundColor: "var(--color-paper)",
    color: "var(--color-ink)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, Menlo, monospace)",
    lineHeight: "18px",
  },
  ".cm-content": {
    caretColor: "var(--color-ink)",
    padding: "16px 0",
  },
  ".cm-line": { padding: "0 16px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-ink)" },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
    {
      backgroundColor: "color-mix(in srgb, var(--color-info) 24%, transparent)",
    },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--color-info) 6%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--color-paper)",
    color: "var(--color-ink-muted)",
    border: "none",
    borderRight: "1px solid var(--color-rule)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--color-info) 8%, transparent)",
    color: "var(--color-ink)",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in srgb, var(--color-info) 14%, transparent)",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--color-info) 18%, transparent)",
    outline: "none",
  },
  ".cm-panels": {
    backgroundColor: "var(--color-bg-elevated)",
    color: "var(--color-ink)",
    borderTop: "1px solid var(--color-rule)",
  },
  ".cm-panels input, .cm-panels button": {
    fontSize: "12px",
    color: "var(--color-ink)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--color-warning) 25%, transparent)",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--color-warning) 45%, transparent)",
  },
});

/** Everything visual: chrome + token colors, ready to drop into the config. */
export function redlineCmTheme(): Extension[] {
  return [redlineEditorChrome, syntaxHighlighting(redlineHighlightStyle)];
}
