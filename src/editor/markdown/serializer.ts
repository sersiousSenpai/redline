// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Node as PMNode } from "@tiptap/pm/model";

import { sidecarComment } from "./sidecar";

export interface SerializeOptions {
  /** Emit `<!-- rl:blk-… -->` before each top-level block (persistence form).
   *  Off → clean markdown for `{original, revised}` comment payloads. */
  sidecars: boolean;
}

/**
 * Serialize a plan ProseMirror document back to markdown. Canonical &
 * idempotent: re-parsing the output and re-serializing yields the same bytes
 * (the fixed-point invariant the round-trip Vitest gates). Mirrors the block
 * model of the Rust parser so a serialized block equals its baseline.
 */
export function planDocToMarkdown(
  doc: PMNode,
  opts: SerializeOptions = { sidecars: false },
): string {
  const footnotes = collectFootnotes(doc);
  footnoteOrdinals = footnotes.map;
  try {
    const parts: string[] = [];
    doc.forEach((block) => {
      const body = serializeBlock(block, "");
      if (opts.sidecars && block.attrs && block.attrs.blockId) {
        parts.push(`${sidecarComment(block.attrs.blockId)}\n${body}`);
      } else {
        parts.push(body);
      }
    });
    let out = parts.join("\n\n") + "\n";
    // Footnote definitions trail the document as a pandoc/GFM block.
    if (footnotes.texts.length) {
      const defs = footnotes.texts
        .map((t, i) => `[^${i + 1}]: ${t}`)
        .join("\n");
      out += `\n${defs}\n`;
    }
    return out;
  } finally {
    footnoteOrdinals = null;
  }
}

// Footnote references need a document-global ordinal and a trailing definitions
// block, neither of which the recursive per-block walk can see. A pre-pass maps
// each footnote node (by identity — stable within one synchronous serialize
// pass) to its 1-based ordinal; `serializeInline` reads it to emit `[^n]`.
let footnoteOrdinals: Map<PMNode, number> | null = null;

function collectFootnotes(root: PMNode): {
  map: Map<PMNode, number>;
  texts: string[];
} {
  const map = new Map<PMNode, number>();
  const texts: string[] = [];
  root.descendants((n) => {
    if (n.type.name === "footnote") {
      map.set(n, texts.length + 1);
      texts.push((n.attrs.text as string) || "");
    }
  });
  return { map, texts };
}

/** Clean markdown for one block (no sidecar) — the value that maps to an
 *  edit comment's `original`/`revised` and the per-block diff baseline. */
export function serializeBlockToMarkdown(node: PMNode): string {
  return serializeBlock(node, "");
}

/** Serialize a single top-level (or nested) block. `indent` is the prefix for
 *  continuation lines (used by list items / blockquotes). */
function serializeBlock(node: PMNode, indent: string): string {
  switch (node.type.name) {
    case "heading":
      return `${"#".repeat(node.attrs.level)} ${serializeInline(node)}`;
    case "paragraph":
      return serializeInline(node);
    case "codeBlock": {
      const lang = node.attrs.language || "";
      return "```" + lang + "\n" + codeBlockText(node) + "\n```";
    }
    case "horizontalRule":
      return "---";
    case "blockquote": {
      const inner = serializeBlocks(node, "");
      return inner
        .split("\n")
        .map((l) => (l.length ? `> ${l}` : ">"))
        .join("\n");
    }
    case "bulletList":
      return serializeList(node, () => "- ", indent);
    case "orderedList": {
      const start = (node.attrs.start as number | null | undefined) ?? 1;
      const style =
        (node.attrs.listStyle as string | null | undefined) ?? null;
      let i = 0;
      return serializeList(node, () => orderedMarker(style, start + i++), indent);
    }
    case "table":
      return serializeTable(node);
    default:
      // listItem is handled by serializeList; any unknown block → inline text.
      return serializeInline(node);
  }
}

/** A code block's text with tracked changes accepted: `rl_del` leaves are
 *  dropped (a proposed deletion contributes nothing when accepted) and every
 *  other leaf — including `rl_ins` text, kept as accepted — contributes its raw
 *  text. No markdown delimiters are applied: code content stays literal. This
 *  is the code-fence analogue of `serializeInline`'s accept-all pass (which is
 *  never reached for `codeBlock`). With zero marks it equals `node.textContent`,
 *  so unedited plans serialize byte-for-byte as before. */
function codeBlockText(node: PMNode): string {
  let text = "";
  node.forEach((child) => {
    if (!child.isText) return;
    if (child.marks.some((m) => m.type.name === "rl_del")) return;
    text += child.text ?? "";
  });
  return text;
}

/** Join a node's block children with a blank line between them. */
function serializeBlocks(parent: PMNode, indent: string): string {
  const out: string[] = [];
  parent.forEach((child) => out.push(serializeBlock(child, indent)));
  return out.join("\n\n");
}

function serializeList(
  list: PMNode,
  marker: () => string,
  indent: string,
): string {
  const lines: string[] = [];
  list.forEach((item) => {
    const m = marker();
    const pad = " ".repeat(m.length);
    const content = serializeBlocks(item, "");
    const itemLines = content.split("\n");
    itemLines.forEach((l, idx) => {
      lines.push(idx === 0 ? `${indent}${m}${l}` : `${indent}${pad}${l}`);
    });
  });
  return lines.join("\n");
}

// The visible marker (with trailing space) for one ordered-list item, matching
// the on-screen `list-style`. A null/`decimal` style keeps the canonical `1. `
// form so plan documents — which never carry `listStyle` — serialize exactly as
// before. Non-decimal styles emit their faithful glyph so the authored outline
// (Roman numerals, letters, parenthetical markers) survives into the prompt.
function orderedMarker(style: string | null, value: number): string {
  if (!style || style === "decimal") return `${value}. `;
  const sym = orderedSymbol(style, value);
  if (style.endsWith("-parenthetical")) return `(${sym}) `;
  if (style.endsWith("-paren")) return `${sym}) `;
  return `${sym}. `;
}

function orderedSymbol(style: string, value: number): string {
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
function toAlpha(n: number): string {
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

function toRoman(n: number): string {
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
function toGreek(n: number): string {
  return n >= 1 && n <= GREEK.length ? GREEK[n - 1] : `${n}`;
}

function serializeTable(table: PMNode): string {
  const rows: string[][] = [];
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(serializeInline(cell.firstChild ?? cell)));
    rows.push(cells);
  });
  if (rows.length === 0) return "";
  const [header, ...body] = rows;
  const sep = header.map(() => "---");
  const fmt = (r: string[]) => `| ${r.join(" | ")} |`;
  return [fmt(header), fmt(sep), ...body.map(fmt)].join("\n");
}

/** Serialize inline content, merging adjacent runs that share a mark set so
 *  delimiters don't fragment (`**a****b**`). */
function serializeInline(node: PMNode): string {
  let out = "";
  let pending = "";
  let pendingKey = "";
  let pendingMarks: PMNode["marks"] = [];

  const flush = () => {
    if (pending) out += wrapMarks(pending, pendingMarks);
    pending = "";
    pendingKey = "";
    pendingMarks = [];
  };

  node.forEach((child) => {
    if (child.type.name === "hardBreak") {
      flush();
      out += "\\\n";
      return;
    }
    if (child.type.name === "footnote") {
      flush();
      out += `[^${footnoteOrdinals?.get(child) ?? 1}]`;
      return;
    }
    if (child.isText) {
      // Accept all tracked changes: a proposed deletion contributes nothing,
      // a proposed insertion contributes its text as if accepted. This keeps
      // the changeLedger seeing clean `{original, revised}`.
      if (child.marks.some((m) => m.type.name === "rl_del")) return;
      const effective = child.marks.filter((m) => m.type.name !== "rl_ins");
      const key = effective.map((m) => markKey(m)).join("|");
      if (key !== pendingKey && pending) flush();
      pendingKey = key;
      pendingMarks = effective;
      pending += child.text ?? "";
    }
  });
  flush();
  return out;
}

function markKey(m: PMNode["marks"][number]): string {
  return m.type.name === "link" ? `link:${m.attrs.href}` : m.type.name;
}

/** Wrap text in markdown delimiters. Fixed nesting (link outermost → code
 *  innermost) keeps output canonical and therefore idempotent. */
function wrapMarks(text: string, marks: PMNode["marks"]): string {
  const has = (n: string) => marks.some((m) => m.type.name === n);
  let s = text;
  if (has("code")) s = "`" + s + "`";
  if (has("strike")) s = `~~${s}~~`;
  if (has("italic")) s = `*${s}*`;
  if (has("bold")) s = `**${s}**`;
  const link = marks.find((m) => m.type.name === "link");
  if (link) s = `[${s}](${link.attrs.href})`;
  return s;
}
