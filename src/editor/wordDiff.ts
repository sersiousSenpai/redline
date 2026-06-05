// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
export interface DiffPart {
  kind: "equal" | "insert" | "delete";
  text: string;
}

/** Tokenize keeping whitespace as its own tokens so concatenating tokens
 *  reproduces the input exactly. Exported for the sub-block addressing
 *  resolver / capture path so word indices stay in lockstep with the diff. */
export function tokenize(s: string): string[] {
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

/**
 * A one-line summary of an edit for the comment pane: the full word diff with
 * long `equal` runs trimmed to a little context around each change (and an `…`
 * marking where text was elided). Changed runs are kept verbatim, except an
 * unusually long single run is itself middle-truncated. Callers render the
 * returned parts with strike (delete) / accent (insert) styling.
 */
export function compactEditPreview(
  original: string,
  revised: string,
  context = 18,
): DiffPart[] {
  const parts = diffWords(original, revised);
  return parts.map((p, idx) => {
    if (p.kind !== "equal") {
      // Cap a single huge changed run so one giant paste can't fill the line.
      if (p.text.length > context * 3) {
        return {
          kind: p.kind,
          text: `${p.text.slice(0, context)}…${p.text.slice(-context / 2)}`,
        };
      }
      return p;
    }
    if (p.text.length <= context * 2) return p;
    const first = idx === 0;
    const lastPart = idx === parts.length - 1;
    if (first) return { kind: "equal", text: `…${p.text.slice(-context)}` };
    if (lastPart) return { kind: "equal", text: `${p.text.slice(0, context)}…` };
    return {
      kind: "equal",
      text: `${p.text.slice(0, context)} … ${p.text.slice(-context)}`,
    };
  });
}
