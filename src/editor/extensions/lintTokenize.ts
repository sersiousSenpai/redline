// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { LintTokenKind } from "../../theme/lint";

/** A recognized token within a single run of text, as [start, end) offsets
 *  into that string plus its kind. */
export interface LintToken {
  start: number;
  end: number;
  kind: LintTokenKind;
}

// One pass over the text with an ordered alternation — the first branch to
// match at a position wins, so URLs/paths are recognized before their embedded
// numbers and dots. Named groups keep the kind mapping legible.
//
//  url   — http(s):// links, bare domains/paths (foo.bar/baz, /abs/path, a.ext)
//  str   — single/double-quoted spans (backticks are code marks in prose, skip)
//  num   — hex (0x…), decimals, thousands-grouped, trailing %  (word-bounded)
//  kw    — ALL-CAPS words of 2+ chars (TODO, API, HTTP, shout-case)
//  punct — the brackets that give prose a "code" silhouette
const TOKEN_RE = new RegExp(
  [
    // url/path, in longest-intent order at a given position:
    //   http(s):// links · slash paths (rel `src/App.tsx` or abs `/etc/hosts`)
    //   · single absolute segment `/tmp` · bare domain/filename `example.com`,
    //   `App.tsx` (needs a 2+-letter dot-TLD so `etc.` at a sentence end is out)
    "(?<url>https?:\\/\\/[^\\s]+|\\/?[A-Za-z0-9._-]+(?:\\/[A-Za-z0-9._-]+)+|\\/[A-Za-z0-9._-]+|\\b[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*\\.[A-Za-z]{2,})",
    "(?<str>\"[^\"\\n]*\"|'[^'\\n]*')",
    // A trailing negative-lookahead (not `\b`) so a trailing `%` survives while
    // still refusing partials like the `3` in `3rd` / `12px`.
    "(?<num>\\b0x[0-9a-fA-F]+\\b|\\b\\d[\\d,]*(?:\\.\\d+)?%?(?![A-Za-z0-9]))",
    "(?<kw>\\b[A-Z][A-Z0-9_]+\\b)",
    "(?<punct>[()\\[\\]{}])",
  ].join("|"),
  "g",
);

/** Tokenize a run of plaintext into IDE-style syntax tokens. Pure and
 *  DOM-free so the LintDecorations plugin and its tests share one source of
 *  truth. Non-token text simply yields no tokens. */
export function tokenizeLint(text: string): LintToken[] {
  const tokens: LintToken[] = [];
  if (!text) return tokens;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    // Zero-width defensiveness — a pathological empty match would loop forever.
    if (m.index === TOKEN_RE.lastIndex) {
      TOKEN_RE.lastIndex++;
      continue;
    }
    const g = m.groups!;
    const kind: LintTokenKind = g.url
      ? "url"
      : g.str
        ? "str"
        : g.num
          ? "num"
          : g.kw
            ? "kw"
            : "punct";
    tokens.push({ start: m.index, end: m.index + m[0].length, kind });
  }
  return tokens;
}
