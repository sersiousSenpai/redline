// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Pure flatten of a parsed diff (`DiffFile[]`) into one fixed-height row list
//! the review pane virtualizes with `virtual.ts`. DOM-free and side-effect-free
//! so the row math is unit-testable, mirroring the `visibleRange` discipline.

import type { DiffFile, DiffHunk, DiffLine } from "../types";
import { expandSlots, type ExpandSlot } from "./expandContext";

/** One virtualized row of the review pane. All variants render at the same
 *  fixed height, which is what lets `visibleRange` treat the pane as a flat
 *  line list. */
export type ReviewRow =
  | { type: "file"; file: DiffFile; filePath: string; fileIndex: number }
  | {
      type: "hunk";
      filePath: string;
      fileIndex: number;
      hunk: DiffHunk;
      hunkIndex: number;
    }
  | {
      type: "line";
      filePath: string;
      fileIndex: number;
      hunkIndex: number;
      /** Index within the hunk's `lines` — the key `pairHunkLines` pairs on. */
      lineIndex: number;
      line: DiffLine;
    }
  | {
      /** Split view: one side-by-side row. A context line mirrors into both
       *  cells; a del/add pair fills both; an unpaired side leaves the other
       *  cell null. Still exactly one fixed-height row. */
      type: "pair";
      filePath: string;
      fileIndex: number;
      hunkIndex: number;
      left: DiffLine | null;
      /** Hunk-line index of each cell (word-diff / highlight lookups). */
      leftLineIndex: number | null;
      right: DiffLine | null;
      rightLineIndex: number | null;
    }
  | {
      /** A gutter expander: reveal unchanged lines hidden around the hunks. */
      type: "expand";
      filePath: string;
      fileIndex: number;
      slot: ExpandSlot;
    };

export type DiffViewMode = "unified" | "split";

/** The path a file is presented (and annotated) under: the new path, except a
 *  deletion only has an old path. Rename rows show both in the header, but the
 *  annotation anchor uses this single canonical path. */
export function displayPath(file: DiffFile): string {
  return file.status === "deleted" ? file.oldPath : file.newPath;
}

/** Flatten files → header/hunk/line (or pair) rows. Files whose path is in
 *  `collapsed` contribute only their header row (the "mark viewed" collapse).
 *  `mode: "split"` emits `pair` rows: context mirrors both cells; a del run
 *  followed by an add run pairs positionally (1st del ↔ 1st add — the same
 *  rule as `pairHunkLines`); the longer run's tail gets a one-sided row. */
export function flattenDiff(
  files: DiffFile[],
  collapsed: ReadonlySet<string> = new Set(),
  mode: DiffViewMode = "unified",
  expanders = false,
): ReviewRow[] {
  const rows: ReviewRow[] = [];
  files.forEach((file, fileIndex) => {
    const filePath = displayPath(file);
    rows.push({ type: "file", file, filePath, fileIndex });
    if (collapsed.has(filePath)) return;
    const slots = expanders ? expandSlots(file) : [];
    file.hunks.forEach((hunk, hunkIndex) => {
      const up = slots.find((s) => s.hunkIndex === hunkIndex && s.edge === "up");
      if (up) rows.push({ type: "expand", filePath, fileIndex, slot: up });
      rows.push({ type: "hunk", filePath, fileIndex, hunk, hunkIndex });
      if (mode === "unified") {
        hunk.lines.forEach((line, lineIndex) => {
          rows.push({ type: "line", filePath, fileIndex, hunkIndex, lineIndex, line });
        });
        return;
      }
      const lines = hunk.lines;
      let i = 0;
      while (i < lines.length) {
        if (lines[i].kind === "context") {
          rows.push({
            type: "pair",
            filePath,
            fileIndex,
            hunkIndex,
            left: lines[i],
            leftLineIndex: i,
            right: lines[i],
            rightLineIndex: i,
          });
          i++;
          continue;
        }
        // A del run then an add run; either may be empty.
        const delStart = i;
        while (i < lines.length && lines[i].kind === "del") i++;
        const addStart = i;
        while (i < lines.length && lines[i].kind === "add") i++;
        const dels = addStart - delStart;
        const adds = i - addStart;
        for (let k = 0; k < Math.max(dels, adds); k++) {
          const li = k < dels ? delStart + k : null;
          const ri = k < adds ? addStart + k : null;
          rows.push({
            type: "pair",
            filePath,
            fileIndex,
            hunkIndex,
            left: li != null ? lines[li] : null,
            leftLineIndex: li,
            right: ri != null ? lines[ri] : null,
            rightLineIndex: ri,
          });
        }
      }
    });
    const down = slots.find((s) => s.edge === "down");
    if (down) rows.push({ type: "expand", filePath, fileIndex, slot: down });
  });
  return rows;
}

/** Per hunk line, its index within its side's *segment* — old = context+del
 *  lines in order, new = context+add — matching how `highlight_diff` segments
 *  are built. -1 when the line doesn't exist on that side. */
export function hunkSideIndices(hunk: DiffHunk): { oldIdx: number; newIdx: number }[] {
  let o = 0;
  let n = 0;
  return hunk.lines.map((l) => {
    const entry = {
      oldIdx: l.kind !== "add" ? o : -1,
      newIdx: l.kind !== "del" ? n : -1,
    };
    if (l.kind !== "add") o++;
    if (l.kind !== "del") n++;
    return entry;
  });
}

/** One side's text of a hunk — the `highlight_diff` segment content. */
export function hunkSideText(hunk: DiffHunk, side: "old" | "new"): string {
  const skip = side === "old" ? "add" : "del";
  return hunk.lines
    .filter((l) => l.kind !== skip)
    .map((l) => l.text)
    .join("\n");
}

/** Row index of a file's header row, for jump-to-file navigation. -1 when the
 *  path isn't in the row list. */
export function fileHeaderIndex(rows: ReviewRow[], filePath: string): number {
  return rows.findIndex((r) => r.type === "file" && r.filePath === filePath);
}

/** Totals for the review header / file tree badges. Binary files count as
 *  neither added nor deleted lines. */
export function diffStats(files: DiffFile[]): {
  files: number;
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind === "add") additions++;
        else if (l.kind === "del") deletions++;
      }
    }
  }
  return { files: files.length, additions, deletions };
}
