// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Line-number gutter sizing shared by the read-only CodeView and (via the
// pinned metrics in cmTheme.ts) the CodeMirror editor, so toggling Edit never
// shifts the code column. CM6 sizes its lineNumbers gutter from the widest
// number it will show; both surfaces use the same monospace font at the same
// size, so `ch` units line the two gutters up exactly.

/** Digits in the widest line number the gutter must fit. */
export function gutterDigits(lineCount: number): number {
  return String(Math.max(1, lineCount)).length;
}

/** CSS width for the gutter cell, matching CM6's lineNumbers metrics:
 *  5px left + 3px right padding around the digits, 20px minimum. */
export function gutterWidthCss(lineCount: number): string {
  return `max(20px, calc(${gutterDigits(lineCount)}ch + 8px))`;
}
