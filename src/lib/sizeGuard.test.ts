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
  it("keeps the Repository view behind its own lazy chunk", () => {
    const panel = files.find(({ rel }) => rel === "components/ReviewPanel.tsx")!.text;
    expect(panel).toMatch(/const GitRepositoryView = lazy\(\(\) => import\(["']\.\/git\/GitRepositoryView["']\)\)/);
    // Nothing outside the git client may import it statically.
    const offenders = files.filter(({ rel, text }) =>
      !rel.startsWith("components/git/") && /from\s+["'][^"']*components\/git\/|from\s+["']\.\/git\//.test(text),
    ).map(({ rel }) => rel);
    expect(offenders, "the git client loads only through the lazy GitRepositoryView boundary").toEqual([]);
  });

  it("keeps the Branches graph lazy inside the git client", () => {
    const view = files.find(({ rel }) => rel === "components/git/GitRepositoryView.tsx")!.text;
    expect(view).toMatch(/const BranchGraphView = lazy\(\(\) => import\(["']\.\/BranchGraphView["']\)\)/);
    const offenders = files.filter(({ rel, text }) => rel !== "components/git/BranchGraphView.test.tsx" && /from\s+["'][^"']*BranchGraphView["']/.test(text)).map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("keeps Three.js behind the Map-only lazy scene boundary", () => {
    const surface = files.find(({ rel }) => rel === "components/MemorySurface.tsx")!.text;
    const map = files.find(({ rel }) => rel === "components/MemoryMap.tsx")!.text;
    expect(surface).toMatch(/const MemoryMapTab = lazy\(/);
    expect(map).toMatch(/const Scene = lazy\(/);
    const offenders = files.filter(({ rel, text }) =>
      !rel.startsWith("components/memory-cosmos/") && /from\s+["']three(?:\/[^"']*)?["']/.test(text),
    ).map(({ rel }) => rel);
    expect(offenders, "Three.js belongs inside the lazily loaded Cosmos renderer").toEqual([]);
  });

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

  it("App.tsx keeps the Localhost surface lazy", () => {
    // No vendor family, just ~10 kB of surface opened on demand, which sat on
    // the boot path by omission until boot JS reached its ceiling.
    const app = files.find(({ rel }) => rel === "App.tsx")!;
    expect(app.text).toMatch(/const ServersPane = lazy\(/);
    expect(app.text).not.toMatch(/import \{ ServersPane \} from/);
  });

  // The markdown-rendering stack. `MarkdownView` value-imports markdown-it,
  // markdown-it-task-lists and highlight.js with its grammars — ~670 kB of source
  // that reached the boot path through ONE chain: App → CommentCard →
  // CommentThread → MarkdownView. These pin the chain's root.
  for (const name of [
    "CommentCard",
    "ReviewPanel",
    "ReviewDiscussionPane",
    "ReadmeModal",
  ]) {
    it(`App.tsx keeps ${name} lazy — it is the markdown stack's boot path`, () => {
      const app = files.find(({ rel }) => rel === "App.tsx");
      expect(app).toBeDefined();
      expect(
        new RegExp(`const ${name} = lazy\\(`).test(app!.text),
        `${name} statically imported drags markdown-it + highlight.js onto the boot path`,
      ).toBe(true);
    });
  }

  it("MarkdownView is never a static import of App", () => {
    // Directly, or through any component App still imports statically. The
    // per-component pins above are the readable failure; this is the backstop
    // for a NEW static import that reaches it by some other route.
    const app = files.find(({ rel }) => rel === "App.tsx");
    expect(app!.text).not.toMatch(
      /^import\s(?!type\b)[^;]*from\s+["']\.\/components\/MarkdownView["']/m,
    );
  });

  it("the settings BODIES are lazy; the settings trigger is not", () => {
    // The gear is chrome and has to be in the static header. The seat chart
    // and the extension marketplace behind it are two of the heaviest
    // components in the app, behind a click most launches never make. Both
    // shells' top bars mount the gear through SettingsGear (C1 moved it out
    // of the classic Header so the flow top bar shares it).
    const gear = files.find(({ rel }) => rel === "components/SettingsGear.tsx");
    expect(gear).toBeDefined();
    for (const name of ["AgentSeats", "ExtensionsPanel"]) {
      expect(
        new RegExp(`const ${name} = lazy\\(`).test(gear!.text),
        `${name} is a static import of the gear`,
      ).toBe(true);
      expect(gear!.text).not.toMatch(
        new RegExp(`^import \\{ ${name} \\} from`, "m"),
      );
    }
    // …and the trigger itself stays static, or the gear would suspend: in
    // the gear module, and in both top bars that mount it.
    expect(gear!.text).toMatch(/^import \{ SettingsMenu, settingsRow \} from "\.\/SettingsMenu";/m);
    const header = files.find(({ rel }) => rel === "components/Header.tsx")!.text;
    expect(header).toMatch(/^import \{ SettingsGear \} from "\.\/SettingsGear";/m);
    const flowBar = files.find(({ rel }) => rel === "shell/FlowTopBar.tsx")!.text;
    expect(flowBar).toMatch(/^import \{ SettingsGear, type SettingsGearProps \} from "\.\.\/components\/SettingsGear";/m);
  });

  it("the settings rows' controls ride one lazy chunk, warmed at the gear", () => {
    // Mode, theme, font, linting, notifications and surfaces render only
    // inside the open menu; static, they were 16 kB of boot JS (measured
    // 2026-10-10).
    const gear = files.find(({ rel }) => rel === "components/SettingsGear.tsx")!.text;
    for (const name of ["ModeToggle", "ThemePicker", "FontPicker", "LintPicker", "AlertSettings", "ShellSettings"]) {
      expect(gear).toContain(`const ${name} = settingsRow("${name}");`);
    }
    const app = files.find(({ rel }) => rel === "App.tsx")!.text;
    expect(app).toContain('const SurfacesPanel = settingsRow("SurfacesPanel");');
    // Only the chunk's own barrel imports them.
    const rows = ["ModeToggle", "ThemePicker", "FontPicker", "LintPicker", "AlertSettings", "SurfacesPanel", "ShellSettings"];
    const offenders = files
      .filter(({ rel }) => rel !== "components/settingsRows.ts" && !/\.test\.tsx?$/.test(rel))
      .filter(({ text }) => rows.some((name) => new RegExp(`^import (?!type\\b)[^;]*from "[./]*(?:components/)?${name}"`, "m").test(text)))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
    const menu = files.find(({ rel }) => rel === "components/SettingsMenu.tsx")!.text;
    expect(menu).toContain('const loadRows = () => import("./settingsRows");');
    expect(menu).toMatch(/onPointerEnter=\{warmRows\}\s+onFocus=\{warmRows\}/);
  });

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

  it("highlight.js is never imported through the full barrel", () => {
    const offenders = files
      .filter(({ text }) => /from\s+["']highlight\.js["']/.test(text))
      .map(({ rel }) => rel);
    expect(
      offenders,
      'use `import hljs from "highlight.js/lib/core"` plus lowlight\'s `common` grammars — the barrel is ~1.9 MB of grammars',
    ).toEqual([]);
  });

  it("highlight.js grammars bundle once, as the ES modules the editor's code blocks use", () => {
    // The package's `lib/common` registers the CommonJS build of each grammar.
    // lowlight (the editor's code blocks) imports the ES build of the same
    // grammars, so a `lib/common` import anywhere ships every one twice:
    // ~140 kB of dist, measured 2026-10-10.
    const offenders = files
      .filter(({ text }) => /from\s+["']highlight\.js\/(lib|es)\/(common|languages\/)/.test(text))
      .map(({ rel }) => rel);
    expect(offenders, "register lowlight's `common` grammars on highlight.js/lib/core").toEqual([]);
    const view = files.find(({ rel }) => rel === "components/MarkdownView.tsx")!.text;
    expect(view).toMatch(/import hljs from "highlight\.js\/lib\/core";/);
    expect(view).toMatch(/import \{ common \} from "lowlight";/);
  });

  it("build analysis is never written into dist", () => {
    // `dist/` is embedded into the binary by Tauri and measured by
    // `distTotalBytes`. A treemap written there inflates the number it exists
    // to explain, and ships a developer artifact to users on any build that
    // ran with ANALYZE set. `scripts/check-size.mjs` fails the built output;
    // this catches the config change that would cause it.
    const config = readFileSync(join(process.cwd(), "vite.config.ts"), "utf8");
    const call = config.match(/visualizer\(\{[^}]*\}\)/);
    expect(call, "the visualizer plugin call moved or vanished").not.toBe(null);
    expect(call![0]).not.toMatch(/filename:\s*["'`]dist\//);
    expect(call![0]).toContain("build-analysis/");
  });

  it("the responsiveness probe is fetched only when switched on", () => {
    // main.tsx and App reach it through perfProbeSwitch's dynamic import, so a
    // release build that never opts in never loads it.
    const offenders = files
      .filter(({ rel, text }) => !/\.test\.tsx?$/.test(rel) && /from\s+["'][^"']*\/perfProbe["']/.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
    const sw = files.find(({ rel }) => rel === "lib/perfProbeSwitch.ts")!.text;
    expect(sw).toMatch(/import\(["']\.\/perfProbe["']\)/);
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
