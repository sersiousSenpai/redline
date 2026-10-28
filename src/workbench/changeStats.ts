// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Line stats for the rail's Changes tab (W4): +added / −removed per file,
// counted off the parsed diff the Review pane already reads.

import type { DiffFile } from "../types";

export interface LineStats {
  add: number;
  del: number;
}

/** Per path (the new path; a deletion's old one), the lines added and
 *  removed. A binary file counts nothing. */
export function diffStats(files: readonly DiffFile[]): Map<string, LineStats> {
  const out = new Map<string, LineStats>();
  for (const f of files) {
    const path = f.newPath && f.newPath !== "/dev/null" ? f.newPath : f.oldPath;
    const s = out.get(path) ?? { add: 0, del: 0 };
    for (const h of f.hunks) for (const l of h.lines) {
      if (l.kind === "add") s.add++;
      else if (l.kind === "del") s.del++;
    }
    out.set(path, s);
  }
  return out;
}
