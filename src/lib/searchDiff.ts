// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Find-in-diff: a pure, case-insensitive substring index over the parsed
//! `DiffFile[]` (never the row list — matches survive virtualization, the
//! unified↔split toggle, and collapse states). DOM-free, unit-tested.

import type { DiffFile } from "../types";
import { displayPath, type ReviewRow } from "./flattenDiff";

/** One hit: which line of which hunk of which file, plus char offsets. */
export interface DiffMatch {
  filePath: string;
  fileIndex: number;
  hunkIndex: number;
  lineIndex: number;
  start: number;
  end: number;
}

/** All matches in document order, plus per-file counts for the tree badges.
 *  Empty query → no matches. */
export function searchDiff(
  files: DiffFile[],
  query: string,
): { matches: DiffMatch[]; perFile: Map<string, number> } {
  const matches: DiffMatch[] = [];
  const perFile = new Map<string, number>();
  const q = query.toLowerCase();
  if (!q) return { matches, perFile };
  files.forEach((file, fileIndex) => {
    const filePath = displayPath(file);
    let count = 0;
    file.hunks.forEach((hunk, hunkIndex) => {
      hunk.lines.forEach((line, lineIndex) => {
        const hay = line.text.toLowerCase();
        let at = 0;
        for (;;) {
          const hit = hay.indexOf(q, at);
          if (hit < 0) break;
          matches.push({
            filePath,
            fileIndex,
            hunkIndex,
            lineIndex,
            start: hit,
            end: hit + q.length,
          });
          count++;
          at = hit + q.length;
        }
      });
    });
    if (count > 0) perFile.set(filePath, count);
  });
  return { matches, perFile };
}

/** Group matches by hunk line for O(1) per-row lookup while rendering.
 *  Values carry the global match index so the active match can be marked. */
export function groupMatches(
  matches: DiffMatch[],
): Map<string, { start: number; end: number; index: number }[]> {
  const map = new Map<string, { start: number; end: number; index: number }[]>();
  matches.forEach((m, index) => {
    const key = `${m.fileIndex}:${m.hunkIndex}:${m.lineIndex}`;
    const list = map.get(key);
    const entry = { start: m.start, end: m.end, index };
    if (list) list.push(entry);
    else map.set(key, [entry]);
  });
  return map;
}

/** Row index a match renders at in the CURRENT row list — works for unified
 *  line rows and split pair rows. -1 when its file is collapsed. */
export function matchRowIndex(rows: ReviewRow[], m: DiffMatch): number {
  return rows.findIndex((r) => {
    if (r.filePath !== m.filePath) return false;
    if (r.type === "line") {
      return r.hunkIndex === m.hunkIndex && r.lineIndex === m.lineIndex;
    }
    if (r.type === "pair") {
      return (
        r.hunkIndex === m.hunkIndex &&
        (r.leftLineIndex === m.lineIndex || r.rightLineIndex === m.lineIndex)
      );
    }
    return false;
  });
}
