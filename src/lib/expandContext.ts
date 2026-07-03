// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Context expansion for the review diff: widen a hunk with real context
//! lines pulled from the full file contents (`review_file_contents`). Pure
//! and DOM-free. The consistency guard is load-bearing: if the file drifted
//! since the diff was cut, expanding with stale line math would corrupt every
//! anchor — we verify the diff's own lines against the fetched content first
//! and refuse to augment on any mismatch (the stale banner takes it from
//! there).

import type { DiffFile, DiffLine } from "../types";

/** Lines added per expander click. */
export const EXPAND_STEP = 20;

/** True when the fetched full content agrees with every line the diff claims
 *  for `side`: each context/side line's text must sit at its claimed line
 *  number. Stronger than a hunk-delta checksum — a same-length edit still
 *  fails honestly. */
export function contentConsistent(
  file: DiffFile,
  side: "old" | "new",
  lines: readonly string[],
): boolean {
  const skip = side === "old" ? "add" : "del";
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === skip) continue;
      const no = side === "old" ? l.oldLine : l.newLine;
      if (no == null) return false;
      if (no < 1 || no > lines.length) return false;
      if (lines[no - 1] !== l.text) return false;
    }
  }
  return true;
}

/** The unchanged-line gap sizes around hunk `i` (old and new sides advance in
 *  lockstep through unchanged regions, so one number describes both). */
export function gapAbove(file: DiffFile, i: number): number {
  const h = file.hunks[i];
  if (!h) return 0;
  const prevEndNew = i > 0 ? file.hunks[i - 1].newStart + file.hunks[i - 1].newLines : 1;
  return Math.max(0, h.newStart - prevEndNew);
}

function contextLine(oldLine: number, newLine: number, text: string): DiffLine {
  return { kind: "context", oldLine, newLine, text };
}

/**
 * Return a copy of `file` with one expansion applied.
 * - `edge: "up"` widens hunk `hunkIndex` upward into the gap above it (top
 *   gap or between-hunks gap); consuming the whole between-gap merges it
 *   with the previous hunk.
 * - `edge: "down"` widens the LAST hunk downward toward the file end.
 * `newLines` drives the text (the sides agree in unchanged regions — the
 * caller ran `contentConsistent` on both sides first); a deleted file (no
 * new side) draws from `oldLines` with mirrored numbering.
 * Returns `file` unchanged when there is nothing to expand.
 */
export function augmentFile(
  file: DiffFile,
  oldLines: readonly string[] | null,
  newLines: readonly string[] | null,
  hunkIndex: number,
  edge: "up" | "down",
  count: number = EXPAND_STEP,
): DiffFile {
  const hunks = file.hunks.map((h) => ({ ...h, lines: [...h.lines] }));
  const src = newLines ?? oldLines;
  if (!src) return file;
  // Old/new numbering offset inside an unchanged region adjacent to a hunk.
  const usingNew = newLines != null;

  if (edge === "up") {
    const h = hunks[hunkIndex];
    if (!h) return file;
    const gap = gapAbove(file, hunkIndex);
    const take = Math.min(count, gap);
    if (take <= 0) return file;
    const shift = h.newStart - h.oldStart; // new − old in the region above
    const added: DiffLine[] = [];
    for (let k = take; k >= 1; k--) {
      const newNo = h.newStart - k;
      const oldNo = newNo - shift;
      const text = usingNew ? src[newNo - 1] : src[oldNo - 1];
      if (text == null) return file; // content shorter than claimed — refuse
      added.push(contextLine(oldNo, newNo, text));
    }
    h.lines.unshift(...added);
    h.oldStart -= take;
    h.newStart -= take;
    h.oldLines += take;
    h.newLines += take;
    // Whole gap consumed → the previous hunk is now adjacent; merge.
    if (take === gap && hunkIndex > 0) {
      const prev = hunks[hunkIndex - 1];
      prev.lines.push(...h.lines);
      prev.oldLines += h.oldLines;
      prev.newLines += h.newLines;
      prev.header = prev.header || h.header;
      hunks.splice(hunkIndex, 1);
    }
    return { ...file, hunks };
  }

  // edge === "down": widen the last hunk toward the end of the file.
  const h = hunks[hunks.length - 1];
  if (!h) return file;
  const endNew = h.newStart + h.newLines; // first line number after the hunk
  const endOld = h.oldStart + h.oldLines;
  const total = src.length;
  const cursor = usingNew ? endNew : endOld;
  const avail = Math.max(0, total - (cursor - 1));
  const take = Math.min(count, avail);
  if (take <= 0) return file;
  for (let k = 0; k < take; k++) {
    const newNo = endNew + k;
    const oldNo = endOld + k;
    const text = src[(usingNew ? newNo : oldNo) - 1];
    if (text == null) break;
    h.lines.push(contextLine(oldNo, newNo, text));
    h.oldLines++;
    h.newLines++;
  }
  return { ...file, hunks };
}

/** Convenience: can this file expand at all? Binary and pure-add/-delete
 *  files have no unchanged region to reveal. */
export function expandable(file: DiffFile): boolean {
  return !file.binary && file.status !== "added" && file.hunks.length > 0;
}

/** Re-exported shape describing one expander slot (mirrors the flattenDiff
 *  expand row). */
export interface ExpandSlot {
  hunkIndex: number;
  edge: "up" | "down";
  /** Unchanged lines available, when known (null = bottom gap — unknown
   *  until the file content is fetched). */
  gap: number | null;
}

/** The expander slots a file presents: top (if the first hunk starts past
 *  line 1), between consecutive hunks, and bottom (size unknown). */
export function expandSlots(file: DiffFile): ExpandSlot[] {
  if (!expandable(file)) return [];
  const slots: ExpandSlot[] = [];
  const first = file.hunks[0];
  if (first.newStart > 1 || first.oldStart > 1) {
    slots.push({ hunkIndex: 0, edge: "up", gap: gapAbove(file, 0) });
  }
  for (let i = 1; i < file.hunks.length; i++) {
    const gap = gapAbove(file, i);
    if (gap > 0) slots.push({ hunkIndex: i, edge: "up", gap });
  }
  if (file.status !== "deleted") {
    slots.push({ hunkIndex: file.hunks.length - 1, edge: "down", gap: null });
  }
  return slots;
}

/** Sum of hunk-header deltas must reconcile with the whole-file line counts
 *  (cheap cross-side sanity used alongside `contentConsistent`). */
export function deltasReconcile(
  file: DiffFile,
  oldLines: readonly string[] | null,
  newLines: readonly string[] | null,
): boolean {
  if (!oldLines || !newLines) return true; // one-sided files have nothing to cross-check
  let net = 0;
  for (const h of file.hunks) net += h.newLines - h.oldLines;
  return newLines.length - oldLines.length === net;
}
