// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/**
 * JS mirror of the Rust sidecar contract in `src-tauri/src/parser.rs`
 * (`parse_sidecar_id`, `apply_injections`, `mint_block_id`). The block id is
 * the stable comment↔block join key; it travels through markdown as an HTML
 * comment so it survives the reparse-on-load model.
 */

const SIDECAR_RE = /^<!--\s*rl:(blk-[A-Za-z0-9_-]+)\s*-->$/;

/** If `line` (trimmed) is exactly a redline sidecar, return its block id. */
export function parseSidecarId(line: string): string | null {
  const m = SIDECAR_RE.exec(line.trim());
  return m ? m[1] : null;
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
