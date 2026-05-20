// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
export interface DiffPart {
  kind: "equal" | "insert" | "delete";
  text: string;
}

/** Tokenize keeping whitespace as its own tokens so concatenating tokens
 *  reproduces the input exactly. */
function tokenize(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t.length > 0);
}

/**
 * Minimal word-level diff (LCS) used to render Word-style tracked changes:
 * shared runs are `equal`, removed runs `delete` (strikethrough, kept in
 * place), added runs `insert` (blue). Deterministic and dependency-free.
 */
export function diffWords(original: string, revised: string): DiffPart[] {
  const a = tokenize(original);
  const b = tokenize(revised);
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const raw: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ kind: "equal", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      raw.push({ kind: "delete", text: a[i++] });
    } else {
      raw.push({ kind: "insert", text: b[j++] });
    }
  }
  while (i < n) raw.push({ kind: "delete", text: a[i++] });
  while (j < m) raw.push({ kind: "insert", text: b[j++] });

  // Coalesce adjacent parts of the same kind for compact rendering.
  const out: DiffPart[] = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}
