// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Human labels for plan anchors — "§4 · step 4", "Context · ¶3",
//! "§4 · releases" — in place of the positional ids the parser mints
//! (`A.4.p2`, `letter_label` in parser.rs).
//!
//! **Display only.** The ids themselves are untouched: they are what the
//! feedback payload names (`§A.4.p2 [feedback]`, feedback.rs), what Claude's
//! resolutions key on and what the Rust snapshots pin. Nothing here is ever
//! written back; a label is computed from the section tree each time it is
//! shown.
//!
//! How a label is built:
//!
//! - **The section part** is the nearest heading. A heading its author
//!   numbered ("4. Releases", "4.2 Rollout") reads "§4" / "§4.2"; an
//!   unnumbered one reads by its own (shortened) title — "Context". A plan
//!   whose single H1 wraps everything is the title, not a section: blocks
//!   directly under it carry no section part, and a mark on the title itself
//!   reads "Plan".
//! - **The position part** says where in the section: the Nth prose
//!   paragraph ("¶3"), the step of a numbered list the mark sits in
//!   ("step 4"), a table row by its first cell ("releases"), a bold lead-in
//!   ("**Releases.** R1 is…" → "releases"), or the block's kind ("code",
//!   "quote"). The step and the row come from the comment's selection — its
//!   line-axis sub-block id first, its quoted text second — because a whole
//!   list or table is one anchored block.
//! - **Which block** is found by the stable `blockId` first and the
//!   positional `anchorId` second, so a label read against a later revision
//!   follows the block if it moved or its section was renamed. An anchor the
//!   tree no longer has degrades to its section, then to "Plan" — never to
//!   the raw id.

import { parseSidecarIdTyped } from "../editor/markdown/sidecar";
import type { Paragraph, Section } from "../types";

/** What a label is asked for: an anchor, and what the comment knows beyond
 *  it. A plain anchor id is also accepted. */
export interface AnchorTarget {
  anchorId: string;
  /** The stable block id, when the comment carries one. Wins over the
   *  positional anchor. */
  blockId?: string | null;
  /** The comment's selection inside the block: picks the step / row. */
  selection?: { quotedText?: string | null; subBlockId?: string | null } | null;
}

/** The kinds of block a paragraph anchor can name, read from its markdown. */
export type BlockKind = "prose" | "ordered" | "bullet" | "table" | "code" | "quote" | "rule";

interface SectionEntry {
  kind: "section";
  section: Section;
  /** "§4" / "Context"; null for the title wrapper. */
  label: string | null;
}

interface BlockEntry {
  kind: "block";
  paragraph: Paragraph;
  block: BlockKind;
  /** The section part of the label (null: directly under the title). */
  sectionLabel: string | null;
  /** 1-based count of prose paragraphs in its section, up to this one. */
  proseOrdinal: number;
}

type Entry = SectionEntry | BlockEntry;

/** A revision's anchors, indexed once and labelled many times. */
export interface AnchorDisplay {
  /** The human label for an anchor (never the raw id). */
  label: (target: AnchorTarget | string) => string;
}

/** Longest a title-derived label may run before it is cut at a word. */
const TITLE_MAX = 28;
/** Longest a lead-in or row label may run. */
const LEAD_MAX = 24;

/** Index a revision's section tree for labelling. Memoize it per revision:
 *  labelling is then a map lookup plus, for a list or table, one parse of
 *  that block's markdown. */
export function createAnchorDisplay(sections: readonly Section[]): AnchorDisplay {
  const byAnchor = new Map<string, Entry>();
  const byBlock = new Map<string, Entry>();
  const wrapper = sections.length === 1 && sections[0].level === 1 ? sections[0] : null;

  const add = (anchorId: string, blockId: string, entry: Entry) => {
    if (anchorId && !byAnchor.has(anchorId)) byAnchor.set(anchorId, entry);
    if (blockId && !byBlock.has(blockId)) byBlock.set(blockId, entry);
  };
  const walk = (secs: readonly Section[]) => {
    for (const s of secs) {
      const label = s === wrapper ? null : sectionLabel(s.title);
      add(s.anchorId, s.blockId, { kind: "section", section: s, label });
      let prose = 0;
      for (const p of s.paragraphs) {
        const block = blockKind(p.markdown);
        if (block === "prose") prose++;
        add(p.anchorId, p.blockId, {
          kind: "block",
          paragraph: p,
          block,
          sectionLabel: label,
          proseOrdinal: prose,
        });
      }
      walk(s.children);
    }
  };
  walk(sections);

  const resolve = (raw: AnchorTarget | string): { entry: Entry | null; coarse: boolean } => {
    const t = typeof raw === "string" ? { anchorId: raw } : raw;
    const viaBlock = t.blockId ? byBlock.get(t.blockId) : undefined;
    if (viaBlock) return { entry: viaBlock, coarse: false };
    const viaAnchor = byAnchor.get(t.anchorId);
    if (viaAnchor) {
      // The comment names a block this revision doesn't have, and something
      // else now sits at its position: only the section is still a fair
      // answer.
      const other = viaAnchor.kind === "block" ? viaAnchor.paragraph.blockId : viaAnchor.section.blockId;
      return { entry: viaAnchor, coarse: !!t.blockId && !!other && other !== t.blockId };
    }
    return { entry: byAnchor.get(sectionAnchorOf(t.anchorId)) ?? null, coarse: true };
  };

  return {
    label(raw) {
      const { entry, coarse } = resolve(raw);
      if (!entry) return "Plan";
      if (entry.kind === "section") return entry.label ?? "Plan";
      if (coarse) return entry.sectionLabel ?? "Plan";
      const selection = typeof raw === "string" ? null : raw.selection ?? null;
      const position = blockPosition(entry, selection);
      return entry.sectionLabel ? `${entry.sectionLabel} · ${position}` : position;
    },
  };
}

/** One label, without keeping the index. */
export function anchorLabel(sections: readonly Section[], target: AnchorTarget | string): string {
  return createAnchorDisplay(sections).label(target);
}

/** `A.4.p2` → `A.4`; a section anchor is its own section. */
function sectionAnchorOf(anchorId: string): string {
  return anchorId.replace(/\.p\d+$/, "");
}

/** "§4" for a heading its author numbered, else its shortened title. */
export function sectionLabel(title: string): string {
  const t = title.trim();
  const numbered =
    /^(\d{1,3}(?:\.\d{1,3})*)[.):]\s+\S/.exec(t) ??
    /^(\d{1,3}(?:\.\d{1,3})+)\s+\S/.exec(t) ??
    /^(\d{1,3})\s+[-–—]\s+\S/.exec(t);
  if (numbered) return `§${numbered[1]}`;
  return shorten(t.replace(/[:.]\s*$/, ""), TITLE_MAX) || "Section";
}

/** What kind of block `markdown` is (the parser's block containers). */
export function blockKind(markdown: string): BlockKind {
  const first = markdown.replace(/^\s*\n/, "").split("\n")[0] ?? "";
  if (/^\s{0,3}(```|~~~)/.test(first) || /^( {4}|\t)/.test(first)) return "code";
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(first)) return "rule";
  if (/^\s{0,3}\d{1,9}[.)](\s|$)/.test(first)) return "ordered";
  if (/^\s{0,3}[-*+](\s|$)/.test(first)) return "bullet";
  if (/^\s{0,3}>/.test(first)) return "quote";
  if (/^\s*\|/.test(first) && /^\s*\|?\s*:?-{3,}/m.test(markdown.split("\n")[1] ?? "")) return "table";
  return "prose";
}

function blockPosition(entry: BlockEntry, selection: AnchorTarget["selection"]): string {
  const md = entry.paragraph.markdown;
  switch (entry.block) {
    case "prose":
      return leadIn(md) ?? `¶${entry.proseOrdinal}`;
    case "ordered": {
      const step = listItemAt(md, selection);
      return step ? `step ${step.number}` : "steps";
    }
    case "bullet": {
      const item = listItemAt(md, selection);
      return item ? leadIn(item.text) ?? `item ${item.number}` : "list";
    }
    case "table":
      return tableRowAt(md, selection) ?? "table";
    case "code":
      return "code";
    case "quote":
      return "quote";
    case "rule":
      return "rule";
  }
}

/** A bold lead-in, as a label: `**Releases.** R1 is…` → "releases". Only a
 *  short one — a sentence in bold is emphasis, not a name. */
function leadIn(markdown: string): string | null {
  const m = /^\s*(?:[-*+]\s+|\d{1,9}[.)]\s+)?(\*\*|__)(.+?)\1/.exec(markdown);
  if (!m) return null;
  const name = plain(m[2]).replace(/[.:—–-]+\s*$/, "").trim();
  if (!name || name.split(/\s+/).length > 4) return null;
  return lowerFirst(shorten(name, LEAD_MAX));
}

interface ListItem {
  /** The number a reader sees: the list's start plus the item's index (how
   *  CommonMark numbers it, whatever each line's own digit says). */
  number: number;
  /** The item's own text, markdown kept. */
  text: string;
}

/** The top-level list item the selection sits in, or null when it can't be
 *  told. */
function listItemAt(markdown: string, selection: AnchorTarget["selection"]): ListItem | null {
  const items = listItems(markdown);
  if (items.top.length === 0) return null;
  // The line axis counts every <li> in document order, nested ones too —
  // the same order this flat list keeps.
  const unit = lineUnit(selection?.subBlockId);
  if (unit !== null) {
    const hit = items.all[unit - 1];
    if (hit) return items.top[hit.top];
  }
  const quoted = norm(selection?.quotedText ?? "");
  if (quoted) {
    const needle = quoted.slice(0, 48);
    for (const item of items.all) if (norm(plain(item.text)).includes(needle)) return items.top[item.top];
  }
  return null;
}

/** Every item of a markdown list, flat in document order, each pointing at
 *  the top-level item it belongs to. */
function listItems(markdown: string): {
  top: ListItem[];
  all: { text: string; top: number }[];
} {
  const top: ListItem[] = [];
  const all: { text: string; top: number }[] = [];
  let base: number | null = null;
  let start = 1;
  // The item a continuation line belongs to, and whether it is top-level.
  let last: { text: string; top: number } | null = null;
  let lastIsTop = false;
  for (const line of markdown.split("\n")) {
    const m = /^(\s*)(?:(\d{1,9})[.)]|[-*+])(?:\s+(.*))?$/.exec(line);
    if (m) {
      const indent = m[1].replace(/\t/g, "    ").length;
      if (base === null) {
        base = indent;
        start = m[2] ? Number(m[2]) : 1;
      }
      lastIsTop = indent <= base;
      if (lastIsTop) top.push({ number: start + top.length, text: m[3] ?? "" });
      last = { text: m[3] ?? "", top: Math.max(0, top.length - 1) };
      all.push(last);
    } else if (last && line.trim()) {
      last.text += ` ${line.trim()}`;
      if (lastIsTop) top[top.length - 1].text += ` ${line.trim()}`;
    }
  }
  return { top, all };
}

/** The table row the selection sits in, named by its first cell. */
function tableRowAt(markdown: string, selection: AnchorTarget["selection"]): string | null {
  const lines = markdown.split("\n").filter((l) => l.trim());
  if (lines.length < 3) return null;
  const header = cells(lines[0]);
  const body = lines.slice(2).map(cells);
  const name = (row: string[] | undefined) => {
    const first = row?.[0] ? plain(row[0]).trim() : "";
    return first ? lowerFirst(shorten(first, LEAD_MAX)) : null;
  };
  // The line axis counts cells (th, then td) in document order.
  const unit = lineUnit(selection?.subBlockId);
  if (unit !== null && header.length > 0) {
    const row = Math.floor((unit - 1) / header.length);
    return row === 0 ? null : name(body[row - 1]);
  }
  const quoted = norm(selection?.quotedText ?? "");
  if (quoted) {
    const needle = quoted.slice(0, 48);
    const hit = body.find((row) => norm(plain(row.join(" "))).includes(needle));
    if (hit) return name(hit);
  }
  return null;
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

/** The 1-based line-axis unit a sub-block id names (`blk-x.l4.w2` → 4). */
function lineUnit(subBlockId: string | null | undefined): number | null {
  if (!subBlockId) return null;
  const id = parseSidecarIdTyped(subBlockId);
  return id && id.kind === "subBlock" && id.axis.kind === "line" ? id.axis.index : null;
}

/** Markdown inline syntax out, text kept. */
function plain(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`|~~)/g, "")
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1");
}

function norm(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Cut at a word so the label still reads, with an ellipsis. */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > max / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:.—–-]+$/, "")}…`;
}

/** "Releases" → "releases", as a location reads; an acronym ("API keys")
 *  keeps its case. */
function lowerFirst(text: string): string {
  const firstWord = text.split(/\s+/)[0] ?? "";
  if (firstWord.length > 1 && firstWord === firstWord.toUpperCase()) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}
