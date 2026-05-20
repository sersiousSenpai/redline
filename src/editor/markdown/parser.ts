// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";

import { planSchema } from "./schema";
import { mintBlockId, stripSidecars } from "./sidecar";

const md = new MarkdownIt({ html: true, linkify: false, typographer: false });

/**
 * Parse plan markdown (sidecar-augmented, as the Rust parser emits) into a
 * ProseMirror document. Sidecars are consumed and assigned as `blockId`
 * attributes on the top-level blocks they precede — ids are never re-minted
 * for blocks that already carry one, preserving the comment↔block join.
 */
export function planMarkdownToDoc(
  markdown: string,
  /** Use the live editor's schema when inserting into a running editor —
   *  node types must be identity-equal to that editor's schema. */
  schemaOverride?: ReturnType<typeof planSchema>,
): PMNode {
  const schema = schemaOverride ?? planSchema();
  const { clean, ids } = stripSidecars(markdown);
  const tokens = md.parse(clean, {});
  const blocks = buildBlocks(tokens, schema);

  // One sidecar per top-level block (Rust invariant). Assign in order; mint
  // for any block lacking one (fresh user-authored content).
  const withIds = blocks.map((node, i) => {
    if (!("blockId" in node.attrs)) return node;
    const blockId = ids[i] ?? mintBlockId();
    return node.type.create(
      { ...node.attrs, blockId },
      node.content,
      node.marks,
    );
  });

  return schema.topNodeType.create(null, withIds);
}

type Schema = ReturnType<typeof planSchema>;

/** Build the top-level block nodes from a markdown-it token stream. */
function buildBlocks(tokens: Token[], schema: Schema): PMNode[] {
  const { nodes } = collectBlocks(tokens, 0, tokens.length, schema);
  return nodes;
}

function collectBlocks(
  tokens: Token[],
  start: number,
  end: number,
  schema: Schema,
): { nodes: PMNode[]; next: number } {
  const nodes: PMNode[] = [];
  let i = start;
  while (i < end) {
    const t = tokens[i];
    switch (t.type) {
      case "heading_open": {
        const level = Number(t.tag.slice(1)) || 1;
        const inline = tokens[i + 1];
        nodes.push(
          schema.nodes.heading.create(
            { level },
            inlineChildren(inline, schema),
          ),
        );
        i += 3; // open, inline, close
        break;
      }
      case "paragraph_open": {
        const inline = tokens[i + 1];
        nodes.push(
          schema.nodes.paragraph.create(null, inlineChildren(inline, schema)),
        );
        i += 3;
        break;
      }
      case "blockquote_open": {
        const close = matchClose(tokens, i, "blockquote_open", "blockquote_close");
        const inner = collectBlocks(tokens, i + 1, close, schema).nodes;
        nodes.push(schema.nodes.blockquote.create(null, inner));
        i = close + 1;
        break;
      }
      case "bullet_list_open": {
        const close = matchClose(tokens, i, "bullet_list_open", "bullet_list_close");
        nodes.push(
          schema.nodes.bulletList.create(
            null,
            listItems(tokens, i + 1, close, schema),
          ),
        );
        i = close + 1;
        break;
      }
      case "ordered_list_open": {
        const close = matchClose(tokens, i, "ordered_list_open", "ordered_list_close");
        const startAttr = t.attrGet("start");
        nodes.push(
          schema.nodes.orderedList.create(
            { start: startAttr ? Number(startAttr) : 1 },
            listItems(tokens, i + 1, close, schema),
          ),
        );
        i = close + 1;
        break;
      }
      case "fence":
      case "code_block": {
        const language =
          t.type === "fence" && t.info ? t.info.trim().split(/\s+/)[0] : null;
        const text = t.content.replace(/\n$/, "");
        nodes.push(
          schema.nodes.codeBlock.create(
            { language: language || null },
            text ? schema.text(text) : undefined,
          ),
        );
        i += 1;
        break;
      }
      case "hr": {
        nodes.push(schema.nodes.horizontalRule.create());
        i += 1;
        break;
      }
      case "table_open": {
        const close = matchClose(tokens, i, "table_open", "table_close");
        nodes.push(buildTable(tokens, i + 1, close, schema));
        i = close + 1;
        break;
      }
      case "html_block": {
        // Non-sidecar raw HTML (sidecars already stripped). Keep verbatim as a
        // paragraph so nothing is silently dropped.
        const text = t.content.replace(/\n$/, "");
        nodes.push(
          schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined),
        );
        i += 1;
        break;
      }
      default:
        i += 1;
        break;
    }
  }
  return { nodes, next: i };
}

function listItems(
  tokens: Token[],
  start: number,
  end: number,
  schema: Schema,
): PMNode[] {
  const items: PMNode[] = [];
  let i = start;
  while (i < end) {
    if (tokens[i].type === "list_item_open") {
      const close = matchClose(tokens, i, "list_item_open", "list_item_close");
      const inner = collectBlocks(tokens, i + 1, close, schema).nodes;
      items.push(schema.nodes.listItem.create(null, inner));
      i = close + 1;
    } else {
      i += 1;
    }
  }
  return items;
}

function buildTable(
  tokens: Token[],
  start: number,
  end: number,
  schema: Schema,
): PMNode {
  const rows: PMNode[] = [];
  let i = start;
  while (i < end) {
    if (tokens[i].type === "tr_open") {
      const trClose = matchClose(tokens, i, "tr_open", "tr_close");
      const cells: PMNode[] = [];
      let j = i + 1;
      while (j < trClose) {
        const cellType = tokens[j].type;
        if (cellType === "th_open" || cellType === "td_open") {
          const isHeader = cellType === "th_open";
          const cClose = matchClose(
            tokens,
            j,
            cellType,
            isHeader ? "th_close" : "td_close",
          );
          const inline = tokens[j + 1];
          const para = schema.nodes.paragraph.create(
            null,
            inline ? inlineChildren(inline, schema) : undefined,
          );
          const nodeType = isHeader
            ? schema.nodes.tableHeader
            : schema.nodes.tableCell;
          cells.push(nodeType.create(null, para));
          j = cClose + 1;
        } else {
          j += 1;
        }
      }
      rows.push(schema.nodes.tableRow.create(null, cells));
      i = trClose + 1;
    } else {
      i += 1;
    }
  }
  return schema.nodes.table.create(null, rows);
}

/** Convert an `inline` token's children into text/hardBreak nodes with marks. */
function inlineChildren(inline: Token | undefined, schema: Schema): PMNode[] {
  if (!inline || !inline.children) return [];
  const out: PMNode[] = [];
  let marks: readonly Mark[] = [];
  const addMark = (m: Mark) => {
    marks = m.addToSet(marks);
  };
  const rmMark = (type: string) => {
    marks = marks.filter((mk) => mk.type.name !== type);
  };
  for (const c of inline.children) {
    switch (c.type) {
      case "text":
        if (c.content) out.push(schema.text(c.content, marks));
        break;
      case "softbreak":
        out.push(schema.text(" ", marks));
        break;
      case "hardbreak":
        out.push(schema.nodes.hardBreak.create());
        break;
      case "code_inline":
        out.push(
          schema.text(c.content, schema.marks.code.create().addToSet(marks)),
        );
        break;
      case "strong_open":
        addMark(schema.marks.bold.create());
        break;
      case "strong_close":
        rmMark("bold");
        break;
      case "em_open":
        addMark(schema.marks.italic.create());
        break;
      case "em_close":
        rmMark("italic");
        break;
      case "s_open":
        addMark(schema.marks.strike.create());
        break;
      case "s_close":
        rmMark("strike");
        break;
      case "link_open":
        addMark(schema.marks.link.create({ href: c.attrGet("href") || "" }));
        break;
      case "link_close":
        rmMark("link");
        break;
      case "image": {
        const alt = c.content || "";
        const src = c.attrGet("src") || "";
        out.push(schema.text(`![${alt}](${src})`, marks));
        break;
      }
      case "html_inline":
        if (c.content) out.push(schema.text(c.content, marks));
        break;
      default:
        if (c.content) out.push(schema.text(c.content, marks));
        break;
    }
  }
  return out;
}

/** Index of the close token matching the open token at `openIdx`. */
function matchClose(
  tokens: Token[],
  openIdx: number,
  openType: string,
  closeType: string,
): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].type === openType) depth += 1;
    else if (tokens[i].type === closeType) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}
