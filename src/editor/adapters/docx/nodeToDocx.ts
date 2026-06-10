// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  Bookmark,
  BorderStyle,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { ParagraphChild } from "docx";

/** Monospace face for code blocks and inline code. */
const CODE_FONT = "Courier New";
const CODE_SHADE = "F2F2F2";
const RULE_COLOR = "999999";

const HEADING_BY_LEVEL = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/** Numbering reference for ordered lists; each top-level list gets its own
 *  instance so numbering restarts per list instead of continuing globally. */
export const ORDERED_REF = "rl-ordered";

/** Document-level numbering config consumed by the exporter's `Document`. */
export function orderedNumberingConfig() {
  return {
    config: [
      {
        reference: ORDERED_REF,
        levels: [0, 1, 2, 3, 4].map((level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          style: {
            paragraph: {
              indent: { left: 720 * (level + 1), hanging: 360 },
            },
          },
        })),
      },
    ],
  };
}

/** Word bookmark names must start with a letter and use [A-Za-z0-9_]. */
export function bookmarkName(blockId: string): string {
  return `rl_${blockId.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

interface BlockOpts {
  /** Wrap the block's inline content in a bookmark carrying its blockId —
   *  cheap insurance for a future .docx → Redline round-trip. */
  blockId?: string;
  /** Inherited paragraph dressing (blockquote indent/border). */
  quote?: boolean;
}

interface ListCtx {
  level: number;
  /** `{ ref, instance }` for ordered lists, or "bullet". */
  numbering: "bullet" | { instance: number };
}

/** Walk a plan document's top-level blocks into docx children. */
export function docToDocxChildren(doc: PMNode): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  let orderedInstance = 0;
  doc.forEach((block) => {
    const blockId =
      typeof block.attrs?.blockId === "string" ? block.attrs.blockId : undefined;
    out.push(
      ...blockToDocx(block, { blockId }, () => orderedInstance++),
    );
  });
  return out;
}

function blockToDocx(
  node: PMNode,
  opts: BlockOpts,
  nextOrderedInstance: () => number,
): (Paragraph | Table)[] {
  switch (node.type.name) {
    case "heading": {
      const level = Math.min(Math.max(node.attrs.level ?? 1, 1), 6);
      return [
        new Paragraph({
          heading: HEADING_BY_LEVEL[level - 1],
          children: inlineChildren(node, opts.blockId),
        }),
      ];
    }
    case "paragraph":
      return [
        new Paragraph({
          children: inlineChildren(node, opts.blockId),
          ...quoteProps(opts.quote),
        }),
      ];
    case "codeBlock":
      // One shaded monospace paragraph per source line. Mermaid blocks take
      // this same path by design — the explicit v1 decision is to degrade a
      // diagram to its fenced code text; rasterizing the rendered diagram is
      // a follow-up gated on image support.
      return codeBlockToDocx(node, opts);
    case "horizontalRule":
      return [
        new Paragraph({
          children: [],
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE_COLOR },
          },
        }),
      ];
    case "blockquote": {
      const out: (Paragraph | Table)[] = [];
      node.forEach((child, _off, idx) => {
        out.push(
          ...blockToDocx(
            child,
            { quote: true, blockId: idx === 0 ? opts.blockId : undefined },
            nextOrderedInstance,
          ),
        );
      });
      return out;
    }
    case "bulletList":
      return listToDocx(node, { level: 0, numbering: "bullet" }, nextOrderedInstance);
    case "orderedList":
      return listToDocx(
        node,
        { level: 0, numbering: { instance: nextOrderedInstance() } },
        nextOrderedInstance,
      );
    case "table":
      return [tableToDocx(node)];
    default:
      // Unknown block → its text as a plain paragraph (mirrors the markdown
      // serializer's fallback).
      return [new Paragraph({ children: inlineChildren(node, opts.blockId) })];
  }
}

function quoteProps(quote: boolean | undefined) {
  if (!quote) return {};
  return {
    indent: { left: 360 },
    border: {
      left: { style: BorderStyle.SINGLE, size: 18, color: "C9C9C9" },
    },
  } as const;
}

function codeBlockToDocx(node: PMNode, opts: BlockOpts): Paragraph[] {
  const lines = node.textContent.split("\n");
  return lines.map(
    (line, idx) =>
      new Paragraph({
        children: wrapBookmark(
          [new TextRun({ text: line, font: CODE_FONT, size: 20 })],
          idx === 0 ? opts.blockId : undefined,
        ),
        shading: { type: ShadingType.CLEAR, fill: CODE_SHADE },
        ...quoteProps(opts.quote),
      }),
  );
}

/** Nested lists map to docx numbering levels: a child bulletList/orderedList
 *  inside a listItem renders its paragraphs one level deeper. */
function listToDocx(
  list: PMNode,
  ctx: ListCtx,
  nextOrderedInstance: () => number,
): Paragraph[] {
  const out: Paragraph[] = [];
  list.forEach((item) => {
    // listItem children: paragraphs and (possibly) nested lists.
    item.forEach((child) => {
      if (child.type.name === "bulletList") {
        out.push(
          ...listToDocx(
            child,
            { level: ctx.level + 1, numbering: "bullet" },
            nextOrderedInstance,
          ),
        );
      } else if (child.type.name === "orderedList") {
        out.push(
          ...listToDocx(
            child,
            {
              level: ctx.level + 1,
              numbering: { instance: nextOrderedInstance() },
            },
            nextOrderedInstance,
          ),
        );
      } else if (child.type.name === "paragraph") {
        out.push(
          new Paragraph({
            children: inlineChildren(child, undefined),
            ...(ctx.numbering === "bullet"
              ? { bullet: { level: ctx.level } }
              : {
                  numbering: {
                    reference: ORDERED_REF,
                    level: ctx.level,
                    instance: ctx.numbering.instance,
                  },
                }),
          }),
        );
      } else {
        // Code block / blockquote inside a list item: emit indented, unnumbered.
        out.push(
          ...(blockToDocx(child, { quote: true }, nextOrderedInstance).filter(
            (b): b is Paragraph => b instanceof Paragraph,
          )),
        );
      }
    });
  });
  return out;
}

function tableToDocx(table: PMNode): Table {
  const rows: TableRow[] = [];
  table.forEach((row) => {
    const cells: TableCell[] = [];
    row.forEach((cell) => {
      const isHeader = cell.type.name === "tableHeader";
      const para = cell.firstChild ?? cell;
      cells.push(
        new TableCell({
          children: [
            new Paragraph({ children: inlineChildren(para, undefined, isHeader) }),
          ],
        }),
      );
    });
    rows.push(new TableRow({ children: cells }));
  });
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

function wrapBookmark(
  children: ParagraphChild[],
  blockId: string | undefined,
): ParagraphChild[] {
  if (!blockId) return children;
  return [new Bookmark({ id: bookmarkName(blockId), children })];
}

/**
 * Inline content → TextRuns, with adjacent linked runs grouped under one
 * `ExternalHyperlink`. Tracked changes export in their **accepted** form,
 * mirroring the markdown serializer's accept-all rule: an `rl_del` run
 * contributes nothing; an `rl_ins` run contributes its text as if accepted.
 */
function inlineChildren(
  node: PMNode,
  blockId: string | undefined,
  forceBold = false,
): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  let linkHref: string | null = null;
  let linkRuns: TextRun[] = [];
  let pendingBreaks = 0;

  const flushLink = () => {
    if (linkHref && linkRuns.length) {
      out.push(new ExternalHyperlink({ link: linkHref, children: linkRuns }));
    }
    linkHref = null;
    linkRuns = [];
  };

  node.forEach((child) => {
    if (child.type.name === "hardBreak") {
      pendingBreaks += 1;
      return;
    }
    if (!child.isText) return;
    // Accepted form of tracked changes (see docstring).
    if (child.marks.some((m) => m.type.name === "rl_del")) return;
    const marks = child.marks.filter((m) => m.type.name !== "rl_ins");
    const link = marks.find((m) => m.type.name === "link");
    const has = (n: string) => marks.some((m) => m.type.name === n);
    const run = new TextRun({
      text: child.text ?? "",
      bold: forceBold || has("bold"),
      italics: has("italic"),
      strike: has("strike"),
      ...(has("code")
        ? {
            font: CODE_FONT,
            shading: { type: ShadingType.CLEAR, fill: CODE_SHADE },
          }
        : {}),
      ...(link ? { style: "Hyperlink" } : {}),
      ...(pendingBreaks ? { break: pendingBreaks } : {}),
    });
    pendingBreaks = 0;

    if (link) {
      const href = String(link.attrs.href ?? "");
      if (linkHref !== null && linkHref !== href) flushLink();
      linkHref = href;
      linkRuns.push(run);
    } else {
      flushLink();
      out.push(run);
    }
  });
  flushLink();
  if (pendingBreaks > 0) out.push(new TextRun({ break: pendingBreaks }));
  return wrapBookmark(out, blockId);
}
