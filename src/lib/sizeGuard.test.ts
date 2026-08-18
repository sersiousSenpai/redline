// Source-level bundle-size guards (docs/perf-budget.md "Size budget").
//
// The main chunk's budget (scripts/size-budget.json) is enforced on built
// output; these assertions catch the *change that causes* a regression at PR
// time: a heavy module quietly becoming a static import of the entry chunk.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// vitest runs with cwd = repo root (import.meta.url is a jsdom localhost URL
// here, so it can't locate the tree).
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

const files = sourceFiles(SRC_ROOT).map((path) => ({
  path,
  rel: relative(SRC_ROOT, path),
  text: readFileSync(path, "utf8"),
}));

describe("size guard", () => {
  it("mermaid is never a static import (dynamic-only keeps it off the main chunk)", () => {
    const offenders = files
      .filter(({ text }) => /from\s+["']mermaid["']/.test(text))
      .map(({ rel }) => rel);
    expect(offenders, "use `await import(\"mermaid\")` instead").toEqual([]);
  });

  it("docx is only imported inside the docx adapter", () => {
    const offenders = files
      .filter(({ rel }) => !rel.startsWith("editor/adapters/docx/"))
      .filter(({ text }) => /from\s+["']docx["']/.test(text))
      .map(({ rel }) => rel);
    expect(offenders, "docx belongs behind the adapter socket").toEqual([]);
  });

  it("the docx adapter itself is only reached dynamically", () => {
    const offenders = files
      .filter(({ rel }) => !rel.startsWith("editor/adapters/docx/"))
      .filter(({ text }) => /from\s+["'][^"']*adapters\/docx/.test(text))
      .map(({ rel }) => rel);
    expect(offenders, "use `import(\"./editor/adapters/docx/…\")`").toEqual([]);
  });

  it("App.tsx keeps PlanEditor lazy", () => {
    const app = files.find(({ rel }) => rel === "App.tsx");
    expect(app).toBeDefined();
    expect(
      /const PlanEditor = lazy\(/.test(app!.text),
      "PlanEditor statically imported would drag Tiptap into the main chunk",
    ).toBe(true);
  });

  // B1d lazy boundaries. Each of these surfaces carries a vendor family the
  // boot path must not pay for (Tiptap/prosemirror, the audio+discussion
  // stack, the markdown→PM parser + block serializer).
  for (const name of [
    "PromptDrafter",
    "VoicePanel",
    "ShareSnapshotDialog",
    "MemorySurface",
  ]) {
    it(`App.tsx keeps ${name} lazy`, () => {
      const app = files.find(({ rel }) => rel === "App.tsx");
      expect(app).toBeDefined();
      expect(
        new RegExp(`const ${name} = lazy\\(`).test(app!.text),
        `${name} statically imported would drag its vendor family into the main chunk`,
      ).toBe(true);
    });
  }

  it("xterm is value-imported only inside lib/xtermLoader.ts (types are fine)", () => {
    const offenders = files
      .filter(({ rel }) => rel !== "lib/xtermLoader.ts")
      .filter(({ text }) =>
        /import\s+(?!type\b)[^;]*from\s+["']@xterm\//.test(text),
      )
      .map(({ rel }) => rel);
    expect(
      offenders,
      "construct xterm via lib/xtermLoader (load-once) — a value import puts ~390 kB on the main chunk",
    ).toEqual([]);
  });

  it("highlight.js is only imported via lib/common, never the full barrel", () => {
    const offenders = files
      .filter(({ text }) => /from\s+["']highlight\.js["']/.test(text))
      .map(({ rel }) => rel);
    expect(
      offenders,
      'use `import hljs from "highlight.js/lib/common"` — the barrel is ~1.9 MB of grammars',
    ).toEqual([]);
  });

  it("App.tsx reaches the section projections via sectionMaps, not docModel", () => {
    const app = files.find(({ rel }) => rel === "App.tsx");
    expect(app).toBeDefined();
    expect(
      /import\s[^;]*from\s+["']\.\/editor\/docModel["']/.test(app!.text),
      "editor/docModel value-imports the serializer + TrackChanges chain (whole Tiptap universe); the pure projections live in editor/sectionMaps",
    ).toBe(false);
  });
});
