// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/**
 * List-marker arithmetic for the Prompt Drafter's Word-style lists.
 *
 * One home for everything that maps between ordinal values and visible list
 * markers: the serializer's value→glyph emitters (`orderedMarker`), their
 * inverses for Word-AutoFormat typing (`classifyOrderedToken`), and the
 * successor maps that drive the style cascade when a list item is nested
 * (`NEXT_ORDERED` / `NEXT_BULLET`).
 */

// ---------------------------------------------------------------------------
// value → marker (used by the markdown serializer)
// ---------------------------------------------------------------------------

// The visible marker (with trailing space) for one ordered-list item, matching
// the on-screen `list-style`. A null/`decimal` style keeps the canonical `1. `
// form so plan documents — which never carry `listStyle` — serialize exactly as
// before. Non-decimal styles emit their faithful glyph so the authored outline
// (Roman numerals, letters, parenthetical markers) survives into the prompt.
export function orderedMarker(style: string | null, value: number): string {
  if (!style || style === "decimal") return `${value}. `;
  const sym = orderedSymbol(style, value);
  if (style.endsWith("-parenthetical")) return `(${sym}) `;
  if (style.endsWith("-paren")) return `${sym}) `;
  return `${sym}. `;
}

export function orderedSymbol(style: string, value: number): string {
  if (style.startsWith("lower-alpha")) return toAlpha(value);
  if (style.startsWith("upper-alpha")) return toAlpha(value).toUpperCase();
  if (style.startsWith("lower-roman")) return toRoman(value);
  if (style.startsWith("upper-roman")) return toRoman(value).toUpperCase();
  if (style.startsWith("lower-greek")) return toGreek(value);
  if (style.startsWith("decimal-leading-zero"))
    return value < 10 ? `0${value}` : `${value}`;
  return `${value}`;
}

// 1 → "a", 26 → "z", 27 → "aa" (bijective base-26), mirroring CSS `lower-alpha`.
export function toAlpha(n: number): string {
  if (n <= 0) return `${n}`;
  let s = "";
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(97 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

const ROMAN: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

export function toRoman(n: number): string {
  if (n <= 0) return `${n}`;
  let r = "";
  let x = n;
  for (const [v, s] of ROMAN) {
    while (x >= v) {
      r += s;
      x -= v;
    }
  }
  return r;
}

// The 24-letter lowercase Greek alphabet, matching CSS `lower-greek`. Past ω it
// falls back to the number (CSS would continue αα… — a rare, acceptable drift).
const GREEK = "αβγδεζηθικλμνξοπρστυφχψω";
export function toGreek(n: number): string {
  return n >= 1 && n <= GREEK.length ? GREEK[n - 1] : `${n}`;
}

// ---------------------------------------------------------------------------
// marker → value (used by the Word-AutoFormat input rules)
// ---------------------------------------------------------------------------

/** Inverse of `toAlpha`: "c" → 3, "aa" → 27. Lowercase only; null otherwise. */
export function fromAlpha(s: string): number | null {
  if (!/^[a-z]+$/.test(s)) return null;
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 96);
  return n;
}

const ROMAN_VALUES: Record<string, number> = {
  i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000,
};

/** Inverse of `toRoman`, round-trip-validated so only canonical numerals pass:
 *  "iv" → 4, but "iiii" and "vv" → null. Lowercase only. */
export function fromRoman(s: string): number | null {
  if (!/^[ivxlcdm]+$/.test(s)) return null;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = ROMAN_VALUES[s[i]];
    const next = ROMAN_VALUES[s[i + 1]] ?? 0;
    n += cur < next ? -cur : cur;
  }
  return n > 0 && toRoman(n) === s ? n : null;
}

export type OrderedFamily =
  | "decimal"
  | "lower-alpha"
  | "upper-alpha"
  | "lower-roman"
  | "upper-roman";

/**
 * Classify one typed marker token ("a", "IV", "3", …) into its list family and
 * starting value, following Word's ambiguity policy:
 *  - digits are always decimal;
 *  - a bare `i`/`I` starts a Roman outline;
 *  - every other single letter — including `v` and `x` — reads as alphabetical
 *    with its computed start (`v.` begins at item 22, not Roman 5);
 *  - multi-letter tokens are accepted only as canonical Roman numerals over
 *    {i,v,x}, 2–6 chars ("ii", "xiv"), never as alpha ("aa"/"vv" → null);
 *  - mixed-case tokens are words, not markers.
 */
export function classifyOrderedToken(
  token: string,
): { family: OrderedFamily; start: number } | null {
  if (/^\d+$/.test(token)) {
    const n = parseInt(token, 10);
    return n > 0 ? { family: "decimal", start: n } : null;
  }
  if (!/^[A-Za-z]{1,6}$/.test(token)) return null;
  const lower = token.toLowerCase();
  const isLower = token === lower;
  if (!isLower && token !== token.toUpperCase()) return null;
  if (token.length === 1) {
    if (lower === "i") {
      return { family: isLower ? "lower-roman" : "upper-roman", start: 1 };
    }
    const start = fromAlpha(lower);
    return start === null
      ? null
      : { family: isLower ? "lower-alpha" : "upper-alpha", start };
  }
  if (!/^[ivx]+$/.test(lower)) return null;
  const start = fromRoman(lower);
  return start === null
    ? null
    : { family: isLower ? "lower-roman" : "upper-roman", start };
}

// ---------------------------------------------------------------------------
// nesting cascade (used by stampListCascade)
// ---------------------------------------------------------------------------

/**
 * Word's numbering cascade: the style a freshly nested ordered list inherits,
 * keyed by the parent list's style. The everyday dot ring is `1. → a. → i.`
 * (then back to `1.`); starting an outline at `I.` walks `I. → A. → 1.` and
 * then falls into the ring. The trailing-paren and parenthetical families
 * cascade within themselves so `1)` nests to `a)` and `(1)` to `(a)`.
 */
export const NEXT_ORDERED: Record<string, string> = {
  decimal: "lower-alpha",
  "lower-alpha": "lower-roman",
  "lower-roman": "decimal",
  "upper-roman": "upper-alpha",
  "upper-alpha": "decimal",
  // Decimal variants join the dot ring where decimal does.
  "decimal-leading-zero": "lower-alpha",
  "lower-greek": "lower-alpha",
  "decimal-paren": "lower-alpha-paren",
  "lower-alpha-paren": "lower-roman-paren",
  "lower-roman-paren": "decimal-paren",
  "upper-roman-paren": "upper-alpha-paren",
  "upper-alpha-paren": "decimal-paren",
  "decimal-parenthetical": "lower-alpha-parenthetical",
  "lower-alpha-parenthetical": "lower-roman-parenthetical",
  "lower-roman-parenthetical": "decimal-parenthetical",
};

/** Word's bullet cascade: ● → ○ → ■ → – and around again. */
export const NEXT_BULLET: Record<string, string> = {
  disc: "circle",
  circle: "square",
  square: "dash",
  dash: "disc",
};
