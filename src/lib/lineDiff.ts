// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A line diff for the file pane's "changed on disk" Compare (W4): what is on
// disk against the unsaved buffer. Common head and tail are trimmed first;
// the middle is an LCS when it is small enough to be instant, else one
// replaced block — a compare has to open now, not be minimal.

export type LineOp = { kind: "same" | "add" | "del"; text: string; oldLine: number | null; newLine: number | null };

const LCS_CELLS = 2_000_000;

export function lineDiff(before: string, after: string): LineOp[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: LineOp[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: "same", text: a[i], oldLine: i + 1, newLine: i + 1 });
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  if (am.length * bm.length <= LCS_CELLS) {
    // dp[i][j] = LCS length of am[i:] and bm[j:].
    const w = bm.length + 1;
    const dp = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--)
      for (let j = bm.length - 1; j >= 0; j--)
        dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < am.length || j < bm.length) {
      if (i < am.length && j < bm.length && am[i] === bm[j]) {
        out.push({ kind: "same", text: am[i], oldLine: head + i + 1, newLine: head + j + 1 });
        i++;
        j++;
      } else if (i < am.length && (j >= bm.length || dp[(i + 1) * w + j] >= dp[i * w + j + 1])) {
        out.push({ kind: "del", text: am[i], oldLine: head + i + 1, newLine: null });
        i++;
      } else {
        out.push({ kind: "add", text: bm[j], oldLine: null, newLine: head + j + 1 });
        j++;
      }
    }
  } else {
    am.forEach((text, i) => out.push({ kind: "del", text, oldLine: head + i + 1, newLine: null }));
    bm.forEach((text, j) => out.push({ kind: "add", text, oldLine: null, newLine: head + j + 1 }));
  }
  for (let k = 0; k < tail; k++) out.push({ kind: "same", text: a[a.length - tail + k], oldLine: a.length - tail + k + 1, newLine: b.length - tail + k + 1 });
  return out;
}
