// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The first cleanup tier for dictated text that is kept (a comment, a
// composer, a document): rules only, pure, well under 10 ms, so insertion
// never waits on a model. Conversation turns skip it — the agent reads messy
// speech fine.
//
// In order:
//   1. learned corrections (what the recognizer wrote → what was meant);
//   2. filler words ("um", "uh");
//   3. layout said aloud: "new line", "new paragraph", "bullet …", and a
//      mid-utterance "scratch that" (voiceIntents.ts);
//   4. punctuation said aloud ("comma", "question mark", "tts dot rs",
//      "redline dash wt");
//   5. numbers and dates: "seven hundred milliseconds" → "700 milliseconds",
//      "twenty twenty six" → "2026", "October tenth" → "October 10"; a lone
//      small number in prose ("one owner") stays a word;
//   6. vocabulary spelling: the capture's terms, ranked, win over the
//      recognizer's casing ("kokoro" → "Kokoro", "use stick to bottom" →
//      "useStickToBottom");
//   7. spacing.
// `fitToContext` then fits the result to the text around the caret.

import { layoutCommands } from "./voiceIntents";

export interface CleanupOptions {
  /** The capture's vocabulary, ranked (vocab.ts): earlier terms win. */
  vocab?: readonly string[];
  /** Learned corrections, applied first. */
  pairs?: readonly { heard: string; meant: string }[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Replace a phrase: any run of spaces between its words, and edges that
 *  don't cut into a word or a file name. (A leading group, not a lookbehind:
 *  older WebKit has none.) */
const replacePhrase = (text: string, words: string[], by: () => string) =>
  text.replace(
    new RegExp(`(^|[^\\w.])${words.map(escape).join("\\s+")}(?![\\w]|\\.\\w)`, "gi"),
    (_, lead: string) => lead + by(),
  );

const FILLERS = /(^|[\s,])(?:u+m+|u+h+|uhm+|e+rm+|hmm+|mhm|m{2,}|a+h+|er)(?=[\s,.!?;:]|$),?/gi;

/** Extensions worth joining "dot" onto: "tts dot rs" is tts.rs. */
const EXTENSIONS =
  "rs|ts|tsx|js|jsx|mjs|cjs|json|md|py|swift|toml|yaml|yml|css|html|sh|sql|txt|lock|env|com|org|dev|io|net|app|ai";

function punctuation(text: string): string {
  return text
    .replace(/[\s,]*\bcomma\b,?/gi, ",")
    .replace(/[\s,.]*\bquestion mark\b[?.]?/gi, "?")
    .replace(/[\s,.]*\bexclamation (?:point|mark)\b[!.]?/gi, "!")
    .replace(/[\s,]*\bsemi ?colon\b[;,]?/gi, ";")
    .replace(/[\s,]*\bcolon\b[:,]?/gi, ":")
    .replace(/[\s,]*\bfull stop\b\.?/gi, ".")
    // "Period" ends a sentence only where a sentence can end: at the end, or
    // before the next one. "A trial period of" stays. (Case-sensitive: under
    // /i, \p{Lu} matches lowercase too.)
    .replace(/[\s,]*\b[Pp]eriod\b\.?(?=\s*$|\s+\p{Lu}|\s*\n)/gu, ".")
    .replace(/[\s,]*\b(?:dot dot dot|ellipsis)\b/gi, "…")
    .replace(/\s*\bem dash\b\s*/gi, " — ")
    .replace(/\s*\bopen (?:paren|parenthesis)\b\s*/gi, " (")
    .replace(/\s*\bclose (?:paren|parenthesis)\b/gi, ")")
    .replace(/\s*\bopen quote\b\s*/gi, ' "')
    .replace(/\s*\b(?:close|end) quote\b/gi, '"')
    // Joiners, between two things said: redline-wt, and/or, off_main.
    .replace(/(\S)\s+(?:dash|hyphen)\s+(?=\S)/gi, "$1-")
    .replace(/(\S)\s+slash\s+(?=\S)/gi, "$1/")
    .replace(/(\S)\s+underscore\s+(?=\S)/gi, "$1_")
    .replace(new RegExp(`(\\w)\\s+dot\\s+(${EXTENSIONS})\\b`, "gi"), (_, a: string, ext: string) => `${a}.${ext.toLowerCase()}`);
}

// --- Numbers ----------------------------------------------------------------

/** Number words by value ("zero" … "nineteen"): Maps, so a word such as
 *  "constructor" is never mistaken for one. */
const UNITS = new Map(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"
    .split(" ")
    .map((w, i) => [w, i] as const),
);
const TENS = new Map("twenty thirty forty fifty sixty seventy eighty ninety".split(" ").map((w, i) => [w, 20 + 10 * i] as const));
const SCALES = new Map([
  ["thousand", 1e3],
  ["million", 1e6],
  ["billion", 1e9],
]);
const ORDINALS = new Map([
  ..."first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth"
    .split(" ")
    .map((w, i) => [w, i + 1] as const),
  ["thirtieth", 30] as const,
]);
const MONTHS = /^(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i;
/** Words a number measures: a number before one is written in digits. */
const MEASURES = new Set(
  (
    "ms millisecond milliseconds second seconds sec secs minute minutes min mins hour hours " +
    "day days week weeks month months year years percent kb kilobyte kilobytes mb megabyte megabytes " +
    "gb gigabyte gigabytes tb terabyte terabytes byte bytes bit bits px pixel pixels hz khz fps " +
    "degree degrees core cores thread threads"
  ).split(" "),
);
/** Words a number labels: "phase two", "macOS fourteen", "port eighty eighty". */
const LABELS = new Set(
  "version macos ios phase step wave lane item section chapter page issue pr part round level tier option task line row column tab port"
    .split(" "),
);
/** Units a lone "one" stays a word before: "one second", "one day". */
const SINGULAR = /^(?:second|minute|hour|day|week|month|year)$/;

interface Word {
  lower: string;
  /** Index into the token list. */
  at: number;
}

const isNumberWord = (w: string) => UNITS.has(w) || TENS.has(w);

/** One number read from the start of `words` (words a single space apart):
 *  its value, how many words it took, and whether it has a fraction. `pairs`:
 *  read "twenty twenty six" as 2026 — a year, or a label's number ("port
 *  eighty eighty") — rather than as twenty, then twenty-six. */
function readNumber(words: Word[], pairs: boolean): { value: number; used: number; fraction: boolean } | null {
  const w = (k: number) => words[k]?.lower ?? "";
  /** A digit word's value, else null. */
  const unit = (k: number) => {
    const v = UNITS.get(w(k));
    return v !== undefined && v < 10 ? v : null;
  };
  /** A two-digit group: "twenty six", "nineteen", "forty". */
  const two = (k: number): { v: number; n: number } | null => {
    const tens = TENS.get(w(k));
    if (tens !== undefined) {
      const b = unit(k + 1);
      return b ? { v: tens + b, n: 2 } : { v: tens, n: 1 };
    }
    const teen = UNITS.get(w(k));
    return teen !== undefined && teen >= 10 ? { v: teen, n: 1 } : null;
  };
  const head = two(0);
  if (head && (pairs || head.v === 19 || head.v === 20)) {
    const k = head.n;
    const oh = w(k) === "oh" ? unit(k + 1) : null;
    if (oh !== null) return { value: head.v * 100 + oh, used: k + 2, fraction: false };
    const tail = two(k);
    if (tail && tail.v >= 10) return { value: head.v * 100 + tail.v, used: k + tail.n, fraction: false };
  }
  let total = 0;
  let current = 0;
  let used = 0;
  let last: "none" | "unit" | "teen" | "tens" | "hundred" | "scale" = "none";
  const fresh = () => last === "none" || last === "hundred" || last === "scale";
  for (let a = w(0); a; a = w(used)) {
    const digit = unit(used);
    const small = UNITS.get(a) ?? TENS.get(a);
    const scale = SCALES.get(a);
    if (digit !== null) {
      if (last === "unit" || last === "teen") break;
      current += digit;
      last = "unit";
    } else if (small !== undefined) {
      if (!fresh()) break;
      current += small;
      last = UNITS.has(a) ? "teen" : "tens";
    } else if (a === "hundred") {
      if (last === "none" || last === "hundred" || current === 0 || current >= 100) break;
      current *= 100;
      last = "hundred";
    } else if (scale !== undefined) {
      if (last === "none" || current === 0) break;
      total += current * scale;
      current = 0;
      last = "scale";
    } else if (!(a === "and" && (last === "hundred" || last === "scale") && isNumberWord(w(used + 1)))) {
      // Not "one hundred and five".
      break;
    }
    used += 1;
  }
  if (used === 0) return null;
  let value = total + current;
  let fraction = false;
  if (w(used) === "point" && unit(used + 1) !== null) {
    // "two point five"
    let digits = "";
    let k = used + 1;
    for (let d = unit(k); d !== null; d = unit(++k)) digits += d;
    value = Number(`${value}.${digits}`);
    used = k;
    fraction = true;
  } else if (w(used) === "and" && w(used + 1) === "a" && w(used + 2) === "half") {
    value += 0.5;
    used += 3;
    fraction = true;
  }
  return { value, used, fraction };
}

function numbers(text: string): string {
  // "forty-one" is two words to the reader below.
  const prepared = text.replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(?=[a-z])/gi, "$1 ");
  const tokens = prepared.match(/[A-Za-z]+|[^A-Za-z]+/g) ?? [];
  const words: Word[] = [];
  tokens.forEach((t, at) => {
    if (/^[A-Za-z]/.test(t)) words.push({ lower: t.toLowerCase(), at });
  });
  const out = [...tokens];
  /** Whether word `j` follows word `j - 1` across one plain space. */
  const joined = (j: number) => j > 0 && words[j].at === words[j - 1].at + 2 && tokens[words[j].at - 1] === " ";
  /** Write `value` over tokens `from`..`to`. */
  const write = (from: number, to: number, value: string) => {
    out[from] = value;
    for (let k = from + 1; k <= to; k++) out[k] = "";
  };
  for (let i = 0; i < words.length; ) {
    const here = words[i].lower;
    const prev = joined(i) ? words[i - 1].lower : "";
    const dated = MONTHS.test(prev);
    if (!isNumberWord(here)) {
      // "October tenth" → "October 10".
      const day = dated ? ORDINALS.get(here) : undefined;
      if (day !== undefined) out[words[i].at] = String(day);
      i += 1;
      continue;
    }
    let n = 1;
    while (i + n < words.length && joined(i + n)) n += 1;
    const labelled = LABELS.has(prev);
    const read = readNumber(words.slice(i, i + n), labelled);
    if (!read) {
      i += 1;
      continue;
    }
    const end = words[i + read.used - 1];
    const next = read.used < n ? words[i + read.used] : undefined;
    const measured = next !== undefined && MEASURES.has(next.lower) && !(read.value === 1 && SINGULAR.test(next.lower));
    if (read.value >= 10 || read.fraction || measured || labelled || dated) {
      if (next?.lower === "percent") write(words[i].at, next.at, `${read.value}%`);
      else write(words[i].at, end.at, String(read.value));
    }
    i += read.used;
  }
  return out.join("");
}

// --- Vocabulary ---------------------------------------------------------------

/** Short everyday words a same-spelled acronym must not capitalize ("it" is
 *  not IT, "us" is not US). */
const PLAIN = new Set(
  (
    "a am an and any are as at be bit by can do for go has he if in is it its me my no not now of " +
    "ok on one or our out pm see set she so the to too two up us use was we who why yes you add " +
    "ask big box cut day did end few get got key let lot man map may new off old own put ram ran " +
    "raw red run say tab tag tap top try way web win yet all but had her him his how its job low " +
    "our pay per sum tip"
  ).split(" "),
);
const LOWER_CAMEL = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;

/** Mark each term's matches with a private-use placeholder so a later
 *  (lower-ranked) term never rewrites inside them, then put the terms in. */
function vocabulary(text: string, vocab: readonly string[]): string {
  const placed: string[] = [];
  const hold = (term: string) => {
    placed.push(term);
    return `${String.fromCharCode(0xe100 + placed.length - 1)}`;
  };
  let t = text;
  for (const term of vocab) {
    if (term.length < 2 || placed.length >= 0x700) continue;
    // A lowercase word is already spelled the way the recognizer writes it.
    if (!/[A-Z._\d-]/.test(term)) continue;
    if (/^[A-Z]{2,6}\d?$/.test(term) && PLAIN.has(term.toLowerCase())) continue;
    t = replacePhrase(t, term.split(/\s+/), () => hold(term));
    // "use stick to bottom" — a lowerCamel name is never prose. UpperCamel
    // names are left joined only where said joined: "the voice panel" is
    // also how a person talks about the panel.
    if (LOWER_CAMEL.test(term)) {
      t = replacePhrase(t, term.split(/(?=[A-Z])/), () => hold(term));
    }
  }
  return t.replace(/(.)/g, (_, c: string) => placed[c.charCodeAt(0) - 0xe100]);
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?%)\]…])/g, "$1")
    .replace(/([([]) +/g, "$1")
    .replace(/,(?=[,.;:!?])/g, "")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t,]+|[ \t,]+$/g, "")
    // A line said aloud starts a sentence; the first one is fitToContext's.
    .replace(/\n(- )?(\p{Ll})/gu, (_, dash = "", c: string) => "\n" + dash + c.toUpperCase());
}

/** The first tier: rules only (see the top of the file). */
export function cleanupDictation(raw: string, opts: CleanupOptions = {}): string {
  let t = raw.replace(/\s+/g, " ").trim();
  for (const { heard, meant } of opts.pairs ?? []) {
    const words = heard.trim().split(/\s+/);
    if (words[0]) t = replacePhrase(t, words, () => meant);
  }
  t = t.replace(FILLERS, "$1");
  t = layoutCommands(t);
  t = punctuation(t);
  t = numbers(t);
  if (opts.vocab?.length) t = vocabulary(t, opts.vocab);
  return tidy(t);
}

/** Words a dictation may open with that stay lowercase mid-sentence. A name
 *  ("Kokoro") keeps the capital the recognizer gave it. */
const OPENERS = new Set(
  (
    "a an and also are as at be because but by can could did do does for from had has have how " +
    "if in into is it its just let like make maybe more most move my no not now of on once or our " +
    "please put rename run set should so some that the their them then there these they this those " +
    "to try use was we what when where which while who why will with would you your add check fix " +
    "keep open show take turn update"
  ).split(" "),
);

/** Fit dictated text to where it lands: `before` and `after` are the text on
 *  either side of the caret. Spacing on both sides, a capital only where a
 *  sentence starts, a break where a list item needs a line of its own, and
 *  one line only for a one-line field (`line`). */
export function fitToContext(text: string, before: string, after = "", opts: { line?: boolean } = {}): string {
  let t = text;
  if (opts.line) t = t.replace(/\s*\n+(?:- )?\s*/g, " ").replace(/^- /, "").trim();
  if (!t.trim()) return "";
  const head = /^\n*/.exec(t)![0].length;
  const tail = /\n*$/.exec(before)![0].length;
  // Breaks already there count; a field's first line needs none.
  t = "\n".repeat(before.trim() ? Math.max(0, head - tail) : 0) + t.slice(head);
  if (t.startsWith("- ") && before.trim() && !before.endsWith("\n")) t = "\n" + t;
  const opensSentence = !before.trim() || /(?:[.!?]["')\]]?|\n)\s*$/.test(before) || t.startsWith("\n");
  t = t.replace(/^(\n*(?:- )?)(\p{L})(\S*)/u, (whole, lead: string, c: string, rest: string) => {
    if (opensSentence) return lead + c.toUpperCase() + rest;
    const word = (c + rest).replace(/[^\p{L}']/gu, "");
    return OPENERS.has(word.toLowerCase()) && word === word[0].toUpperCase() + word.slice(1).toLowerCase()
      ? lead + c.toLowerCase() + rest
      : whole;
  });
  if (before && !/[\s([{"'/-]$/.test(before) && !/^[\s,.;:!?)\]…%]/.test(t)) t = " " + t;
  if (after && /^[\p{L}\p{N}(]/u.test(after) && !/\s$/.test(t)) t += " ";
  return t;
}
