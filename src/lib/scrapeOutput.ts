// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The JSON output sink for a scrape: compose the result into a pretty-printed
//! JSON document and derive a safe, collision-free filename. Pure string work so
//! it unit-tests without the webview or filesystem; the actual write reuses
//! `saveNote` from `obsidian.ts`.

import type { ScrapeResult } from "./scrapeSchema";

/** Pretty-printed JSON of the full result — data plus the metadata (url, title,
 *  schema, version) and any warnings, so a saved scrape is self-describing. */
export function composeScrapeJson(result: ScrapeResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}

/** Hostname of a URL, falling back to the raw string (or "page") when unparseable. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname || "page";
  } catch {
    return "page";
  }
}

/** Reduce an arbitrary label to a filesystem-safe slug. */
function slug(value: string): string {
  return value
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** A compact local timestamp `YYYYMMDD-HHMMSS` for uniqueness. */
function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** Build a scrape's basename (no extension): `<host>-<schema>-<timestamp>`.
 *  Reuses the sanitizing approach from `clipFilename`; falls back gracefully
 *  when host or schema slug to nothing. */
export function scrapeFilename(schemaName: string, url: string, date: Date): string {
  const parts = [slug(hostnameOf(url)), slug(schemaName), stamp(date)].filter(
    Boolean,
  );
  return parts.join("-") || `scrape-${stamp(date)}`;
}

/** Ensure `base` doesn't collide with an existing `.json` file in the target
 *  dir. `existing` is the file names already present (with or without `.json`).
 *  Appends " 2", " 3", … until free — the `.json`-aware sibling of
 *  `dedupeFilename` in `obsidianClip.ts`. */
export function dedupeJsonFilename(base: string, existing: Iterable<string>): string {
  const taken = new Set<string>();
  for (const name of existing) {
    taken.add(name.replace(/\.json$/i, "").toLowerCase());
  }
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
