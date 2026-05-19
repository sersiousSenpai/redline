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
  const parts: string[] = [];
  doc.forEach((block) => {
    const body = serializeBlock(block, "");
    if (opts.sidecars && block.attrs && block.attrs.blockId) {
      parts.push(`${sidecarComment(block.attrs.blockId)}\n${body}`);
    } else {
      parts.push(body);
    }
  });
  return parts.join("\n\n") + "\n";
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
      return "```" + lang + "\n" + node.textContent + "\n```";
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
      let n = node.attrs.start ?? 1;
      return serializeList(node, () => `${n++}. `, indent);
    }
    case "table":
      return serializeTable(node);
    default:
      // listItem is handled by serializeList; any unknown block → inline text.
      return serializeInline(node);
  }
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
