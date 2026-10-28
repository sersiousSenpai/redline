// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// ⌘P quick open (W4): the project's files, walked once per open with the
// same `list_dir` the Files rail uses, and a fuzzy rank over their paths.
// Pure but for the injected lister, so both halves are unit-tested.

export interface ListedEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** Folders never worth walking: dependencies, build output, VCS state. */
export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  ".idea",
  "Pods",
  "DerivedData",
]);

export const INDEX_CAP = 8000;

/** Every file under `root` as a path relative to it, breadth first so the
 *  shallow files land before a deep tree eats the cap. `lister` failures on
 *  one folder skip that folder. At most `concurrency` listings in flight. */
export async function indexFiles(
  root: string,
  lister: (path: string) => Promise<ListedEntry[]>,
  { cap = INDEX_CAP, concurrency = 8, signal }: { cap?: number; concurrency?: number; signal?: { aborted: boolean } } = {},
): Promise<{ files: string[]; truncated: boolean }> {
  const base = root.replace(/\/+$/, "");
  const files: string[] = [];
  let queue: string[] = [base];
  let truncated = false;
  while (queue.length && !truncated && !signal?.aborted) {
    const next: string[] = [];
    for (let i = 0; i < queue.length && !truncated; i += concurrency) {
      const batch = queue.slice(i, i + concurrency);
      const listed = await Promise.all(batch.map((dir) => lister(dir).catch(() => [] as ListedEntry[])));
      if (signal?.aborted) break;
      for (const entries of listed) {
        for (const e of entries) {
          if (e.isDir) {
            if (!SKIP_DIRS.has(e.name)) next.push(e.path);
          } else if (files.length < cap) {
            files.push(e.path.startsWith(`${base}/`) ? e.path.slice(base.length + 1) : e.path);
          } else {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
    }
    queue = next;
  }
  return { files, truncated };
}

/** A fuzzy score for `query` against `path` (higher is better), or null
 *  when the letters do not appear in order. Matches in the file name, at a
 *  word start, and in runs score more; shorter paths win ties. */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const p = path.toLowerCase();
  const nameStart = p.lastIndexOf("/") + 1;
  let score = 0;
  let at = -1;
  let run = 0;
  for (const ch of q) {
    const found = p.indexOf(ch, at + 1);
    if (found < 0) return null;
    const boundary = found === 0 || "/._- ".includes(p[found - 1]);
    run = found === at + 1 ? run + 1 : 0;
    score += 1 + (boundary ? 3 : 0) + (found >= nameStart ? 2 : 0) + run * 2;
    at = found;
  }
  // The whole query inside the file name outranks a scattered match.
  if (p.slice(nameStart).includes(q)) score += 10;
  return score - path.length * 0.01;
}

/** The best `limit` paths for `query`, best first. An empty query lists the
 *  shallowest files first. */
export function rankFiles(query: string, files: readonly string[], limit = 50): string[] {
  if (!query.trim()) {
    return [...files].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, limit);
  }
  const scored: { path: string; score: number }[] = [];
  for (const path of files) {
    const score = fuzzyScore(query, path);
    if (score !== null) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((s) => s.path);
}
