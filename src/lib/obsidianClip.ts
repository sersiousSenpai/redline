// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Compose an Obsidian note from a captured web page. The note leads with YAML
//! frontmatter (so Obsidian indexes url/title/saved/tags as Properties), then an
//! optional reviewer context note as a blockquote, then the page body. Pure
//! string work so it can be unit-tested without the webview or filesystem.

export interface ClipInput {
  url: string;
  title: string;
  /** Page body (selection or innerText) already reduced to plain text/markdown. */
  body: string;
  /** Free-text note the user typed at save time. Omitted from output when blank. */
  contextNote?: string;
  /** Save date; pass a Date so callers stay testable. Formatted as YYYY-MM-DD. */
  savedDate: Date;
  /** Frontmatter tags. Defaults to ["clipping"]. */
  tags?: string[];
}

/** Format a Date as a local YYYY-MM-DD string for the `saved:` field. */
export function ymd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Double-quote and escape a value for a YAML scalar (handles colons, quotes). */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build the full markdown note. Body whitespace is trimmed at the edges; the
 * context note (if any) becomes a `>` blockquote between frontmatter and body.
 */
export function composeClipNote(input: ClipInput): string {
  const tags = input.tags && input.tags.length ? input.tags : ["clipping"];
  const lines = [
    "---",
    `url: ${yamlString(input.url)}`,
    `title: ${yamlString(input.title)}`,
    `saved: ${ymd(input.savedDate)}`,
    `tags: [${tags.join(", ")}]`,
    "---",
    "",
  ];

  const note = input.contextNote?.trim();
  if (note) {
    // Each line of a multi-line note gets its own blockquote marker.
    for (const line of note.split("\n")) lines.push(`> ${line}`);
    lines.push("");
  }

  lines.push(input.body.trim());
  lines.push("");
  return lines.join("\n");
}

/**
 * Turn a page title into a safe note basename (no extension). Strips characters
 * illegal on common filesystems / in Obsidian, collapses whitespace, and falls
 * back to a dated name when the title yields nothing usable.
 */
export function clipFilename(title: string, date: Date): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]/g, " ") // FS- and Obsidian-illegal chars
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  if (cleaned) return cleaned;
  return `Web Clipping ${ymd(date)}`;
}

/**
 * Ensure `base` doesn't collide with an existing `.md` note in the target dir.
 * `existing` is the set of file names already present (with or without the .md
 * extension). Appends " 2", " 3", … until free — mirroring Finder/Obsidian.
 */
export function dedupeFilename(base: string, existing: Iterable<string>): string {
  const taken = new Set<string>();
  for (const name of existing) {
    taken.add(name.replace(/\.md$/i, "").toLowerCase());
  }
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
