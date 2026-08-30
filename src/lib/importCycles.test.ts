// T2.2 — the static import graph of src/ has no cycles. Pin the zero.
//
// The render crashes this hardening batch chased looked like a cycle
// signature (a `ReferenceError` on a binding that should exist), and the
// investigation found none — the real cause was cold/stale lazy chunks, fixed
// by containment in `surfaceBoundaries.test.ts`. This test exists so that
// diagnosis stays valid: a cycle introduced later would produce exactly the
// same symptom, and finding out from a user-facing blank screen is much more
// expensive than finding out here.
//
// Hand-rolled rather than eslint-plugin-import/madge: the repo has no eslint
// config and no dependency to hang one on, and this rides the vitest run that
// already exists.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// vitest runs with cwd = repo root.
const SRC_ROOT = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

// A value `import`/`export … from "…"`, across line breaks. `import type` and
// `export type` are erased before runtime and cannot close a cycle, so they
// are excluded; `import { type A, b }` is NOT — it still emits the import.
// Barring `;`, quotes and backticks from the gap keeps the lazy match from
// running past the end of its own statement.
const FROM_RE =
  /(?:^|\n)[ \t]*(?:import|export)\s+(?!type[\s{])(?:[^;'"`]{0,600}?\s)?from\s*["']([^"']+)["']/g;
// Side-effect imports have no `from` clause but are still edges.
const BARE_RE = /(?:^|\n)[ \t]*import\s+["']([^"']+)["']/g;
// `await import("…")` is deliberately NOT an edge: a dynamic import is a
// separate chunk and a cycle through one is not an initialization hazard.

function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const re of [FROM_RE, BARE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push(m[1]);
  }
  return out;
}

/** Resolve a relative specifier to a source file, or null for a package,
 *  an asset, or anything outside the TS graph. */
function resolveEdge(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec.split("?")[0]);
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (/\.tsx?$/.test(cand) && existsSync(cand) && statSync(cand).isFile()) {
      return cand;
    }
  }
  return null;
}

const files = sourceFiles(SRC_ROOT);
const graph = new Map<string, string[]>(
  files.map((f) => [
    f,
    specifiers(readFileSync(f, "utf8"))
      .map((s) => resolveEdge(f, s))
      .filter((s): s is string => s !== null),
  ]),
);

/** First cycle found, as repo-relative paths, or null. */
function findCycle(): string[] | null {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(files.map((f) => [f, WHITE]));
  const stack: string[] = [];

  const walk = (node: string): string[] | null => {
    color.set(node, GREY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GREY) {
        const from = stack.indexOf(next);
        return [...stack.slice(from), next].map((p) => relative(SRC_ROOT, p));
      }
      if (c === WHITE) {
        const found = walk(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const f of files) {
    if ((color.get(f) ?? WHITE) === WHITE) {
      const found = walk(f);
      if (found) return found;
    }
  }
  return null;
}

describe("import cycles", () => {
  it("the static import graph of src/ is acyclic", () => {
    const cycle = findCycle();
    expect(
      cycle && cycle.join(" -> "),
      "a static import cycle leaves one module's bindings undefined at the other's " +
        "module-eval time — the ReferenceError render crash, delivered as a blank " +
        "surface. Break it with a dynamic import() or by hoisting the shared piece " +
        "into its own module",
    ).toBe(null);
  });

  it("actually built a graph (a silently empty walk would pass vacuously)", () => {
    expect(files.length).toBeGreaterThan(200);
    const edges = [...graph.values()].reduce((n, e) => n + e.length, 0);
    expect(edges, "no resolved relative imports — the resolver regressed").toBeGreaterThan(400);
  });
});
