// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Pure selection logic for the review diff's gutter: click starts a one-line
//! range, shift-click extends it (same file + side only), and the selected
//! lines' verbatim text is captured as `quotedText` — the durable content
//! anchor annotations re-locate on across review rounds. DOM-free, mirroring
//! the `flattenDiff`/`wordDiff` testing discipline.

import type { DiffFile, DiffLine } from "../types";
import { displayPath } from "./flattenDiff";

/** A selected line range on one side of one file's diff. */
export interface ReviewRange {
  filePath: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
}

/** One gutter click, as the row reports it. `side` is set by split-view cells
 *  (a context line exists on both sides — the clicked cell decides); absent,
 *  the line's own side applies. */
export interface GutterClick {
  filePath: string;
  line: DiffLine;
  shift: boolean;
  side?: "old" | "new";
}

/** The side a click on this line addresses: deleted lines only exist on the
 *  old side; context and added lines anchor to the new side. */
export function sideOfLine(line: DiffLine): "old" | "new" {
  return line.kind === "del" ? "old" : "new";
}

/** Line number of `line` on `side` (null when the line has no number there). */
function lineNo(line: DiffLine, side: "old" | "new"): number | null {
  return side === "old" ? line.oldLine : line.newLine;
}

/** Next selection state for a gutter click.
 *  - plain click: a fresh one-line range (clicking the sole selected line
 *    again clears — an easy "deselect").
 *  - shift-click on the same file + side: extend to span the clicked line.
 *  - shift-click elsewhere: treated as a fresh click. */
export function reduceGutterClick(
  current: ReviewRange | null,
  click: GutterClick,
): ReviewRange | null {
  const side = click.side ?? sideOfLine(click.line);
  const no = lineNo(click.line, side);
  if (no == null) return current;
  if (
    click.shift &&
    current &&
    current.filePath === click.filePath &&
    current.side === side
  ) {
    return {
      ...current,
      startLine: Math.min(current.startLine, no),
      endLine: Math.max(current.endLine, no),
    };
  }
  if (
    current &&
    !click.shift &&
    current.filePath === click.filePath &&
    current.side === side &&
    current.startLine === no &&
    current.endLine === no
  ) {
    return null;
  }
  return { filePath: click.filePath, side, startLine: no, endLine: no };
}

/** The range a drag describes: anchored at the mousedown line, spanning to
 *  the line currently under the pointer (either direction). One file, one
 *  side — the anchor's side wins; hovered lines without a number on that
 *  side (e.g. an add row while dragging the old side) keep the last range. */
export function dragRange(
  filePath: string,
  side: "old" | "new",
  anchorNo: number,
  hover: DiffLine,
): ReviewRange | null {
  const no = lineNo(hover, side);
  if (no == null) return null;
  return {
    filePath,
    side,
    startLine: Math.min(anchorNo, no),
    endLine: Math.max(anchorNo, no),
  };
}

/** True when `line` (in `filePath`) falls inside the selected range. */
export function lineInRange(
  range: ReviewRange | null,
  filePath: string,
  line: DiffLine,
): boolean {
  if (!range || range.filePath !== filePath) return false;
  const no = lineNo(line, range.side);
  return no != null && no >= range.startLine && no <= range.endLine;
}

/** The verbatim text of the range's lines on its side, joined with `\n` —
 *  the durable `quotedText` anchor. Empty string when the range addresses
 *  nothing visible (caller should treat that as no selection). */
export function quotedTextForRange(files: DiffFile[], range: ReviewRange): string {
  const file = files.find((f) =>
    range.side === "old" ? f.oldPath === range.filePath : displayPath(f) === range.filePath,
  );
  if (!file) return "";
  const out: string[] = [];
  for (const h of file.hunks) {
    for (const l of h.lines) {
      const no = lineNo(l, range.side);
      if (no != null && no >= range.startLine && no <= range.endLine) {
        out.push(l.text);
      }
    }
  }
  return out.join("\n");
}

/** Next id in a `{prefix}-NNN` series, ignoring foreign ids. */
export function nextIdInSeries(existing: { id: string }[], prefix: string): string {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const a of existing) {
    const m = re.exec(a.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

/** Next annotation id in the session-scoped `rc-NNN` series (mirrors plan
 *  review's `c-{max+1}` convention). The frontend owns only `rc-`; AI and
 *  external sources mint `ai-`/`ext-` server-side. */
export function nextAnnotationId(existing: { id: string }[]): string {
  return nextIdInSeries(existing, "rc");
}

/** Next Ask-AI question id (`ask-NNN`) — its own namespace, so a question
 *  thread can never collide with an annotation thread. */
export function nextQuestionId(existing: { id: string }[]): string {
  return nextIdInSeries(existing, "ask");
}
