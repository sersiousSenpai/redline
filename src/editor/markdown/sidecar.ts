// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * JS mirror of the Rust sidecar contract in `src-tauri/src/parser.rs`
 * (`parse_sidecar_id`, `apply_injections`, `mint_block_id`). The block id is
 * the stable comment↔block join key; it travels through markdown as an HTML
 * comment so it survives the reparse-on-load model.
 */

// Wide regex: gates the comment-shape and the `rl:` prefix, then delegates
// id-grammar validation to `parseSidecarIdTyped`. This keeps the wire-format
// validation in one place (the SidecarId parser) and stops the regex from
// growing every time the grammar does.
const SIDECAR_SHAPE_RE = /^<!--\s*rl:([A-Za-z0-9_.-]+)\s*-->$/;

/** Axis a sub-block sidecar addresses against. Mirrors `parser::SubAxis`. */
export type SubAxis =
  | { kind: "line"; index: number }
  | { kind: "sentence"; index: number };

/** 1-based inclusive word range under a [`SubAxis`]. */
export interface WordRange {
  start: number;
  end: number;
}

/** Parsed form of the redline sidecar id. Mirrors `parser::SidecarId`. */
export type SidecarId =
  | { kind: "block"; blockId: string }
  | {
      kind: "subBlock";
      blockId: string;
      axis: SubAxis;
      words: WordRange | null;
    };

/** Block id this sidecar lives under — always present. */
export function sidecarBlockId(id: SidecarId): string {
  return id.blockId;
}

/** Canonical string form — inverse of `parseSidecarIdTyped`. Round-trips
 *  byte-identically with the roundtrip gate. */
export function sidecarIdToString(id: SidecarId): string {
  if (id.kind === "block") return id.blockId;
  let out = id.blockId;
  if (id.axis.kind === "line") out += `.l${id.axis.index}`;
  else out += `.s${id.axis.index}`;
  if (id.words) {
    out += `.w${id.words.start}`;
    if (id.words.end !== id.words.start) out += `-w${id.words.end}`;
  }
  return out;
}

/** Parse the inner id string (no `<!-- rl:` / `-->` wrappers). Returns
 *  `null` for any malformed input — empty pieces, double dots, missing
 *  indices, reversed word ranges, leading/trailing dots, unknown axes. */
export function parseSidecarIdTyped(s: string): SidecarId | null {
  const parts = s.split(".");
  const blockPart = parts[0];
  if (!blockPart.startsWith("blk-")) return null;
  const rest = blockPart.slice(4);
  if (rest.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(rest)) return null;
  if (parts.length === 1) {
    return { kind: "block", blockId: blockPart };
  }
  const axisPart = parts[1];
  const axis = parseAxis(axisPart);
  if (!axis) return null;
  let words: WordRange | null = null;
  if (parts.length >= 3) {
    if (parts.length > 3) return null; // trailing garbage
    const w = parseWordRange(parts[2]);
    if (!w) return null;
    words = w;
  }
  return { kind: "subBlock", blockId: blockPart, axis, words };
}

function parseAxis(p: string): SubAxis | null {
  if (p.startsWith("l")) {
    const n = parseIndex(p.slice(1));
    return n == null ? null : { kind: "line", index: n };
  }
  if (p.startsWith("s")) {
    const n = parseIndex(p.slice(1));
    return n == null ? null : { kind: "sentence", index: n };
  }
  return null;
}

function parseWordRange(p: string): WordRange | null {
  if (!p.startsWith("w")) return null;
  const body = p.slice(1);
  if (body.length === 0) return null;
  const dash = body.indexOf("-w");
  if (dash === -1) {
    const n = parseIndex(body);
    return n == null ? null : { start: n, end: n };
  }
  const start = parseIndex(body.slice(0, dash));
  const end = parseIndex(body.slice(dash + 2));
  if (start == null || end == null || end < start) return null;
  return { start, end };
}

function parseIndex(s: string): number | null {
  if (!/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

/** If `line` (trimmed) is exactly a redline sidecar, return its canonical
 *  id string (`blk-…` plus optional sub-block suffix). Sub-block ids
 *  round-trip transparently — the wire form stays an opaque string for
 *  callers that don't need to introspect. */
export function parseSidecarId(line: string): string | null {
  const m = SIDECAR_SHAPE_RE.exec(line.trim());
  if (!m) return null;
  const parsed = parseSidecarIdTyped(m[1]);
  return parsed ? sidecarIdToString(parsed) : null;
}

/** Mirror of Rust `mint_block_id`: `blk-` + first 8 hex of a v4 UUID. */
export function mintBlockId(): string {
  const u =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(16).slice(2).padEnd(8, "0");
  return `blk-${u.slice(0, 8)}`;
}

export function sidecarComment(blockId: string): string {
  return `<!-- rl:${blockId} -->`;
}

export interface StrippedMarkdown {
  /** Markdown with sidecar lines removed. */
  clean: string;
  /** Block ids in document order — one per top-level block the Rust parser
   *  stamped. Index i corresponds to the i-th top-level block. */
  ids: string[];
}

/**
 * Remove sidecar lines and collect their ids in order. The Rust parser injects
 * `<!-- rl:blk-… -->\n` immediately before each top-level block, so dropping
 * those whole lines yields the original block markdown and an ordered id list.
 */
export function stripSidecars(markdown: string): StrippedMarkdown {
  const ids: string[] = [];
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const id = parseSidecarId(line);
    if (id !== null) {
      ids.push(id);
    } else {
      out.push(line);
    }
  }
  return { clean: out.join("\n"), ids };
}
