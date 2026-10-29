// T2.1 — per-surface render-crash containment, asserted at the source.
//
// 14 of the 21 recorded runtime failures were WKWebView render errors and 12
// of those took the whole app down. The tree had three boundaries in 110k
// lines — header, content area, root — so a stale or cold lazy chunk in ONE
// surface blanked every surface at once. Each lazily-loaded surface now
// carries its own boundary, tagged with a region so the `render_crash`
// friction row says which surface died.
//
// This is a source guard rather than a render test on purpose: mounting eight
// surfaces (Tiptap, the browser pane, the memory surface) to prove a wrapper
// exists costs far more than reading the file, and a wrapper that is present
// in the source is present at runtime.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// vitest runs with cwd = repo root (import.meta.url is a jsdom localhost URL
// here, so it can't locate the tree).
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const APP = read("src/App.tsx");
// W6: the pane bodies left App for `src/workbench/panes/*`, one module per
// kind, and each lazily loaded body's boundary went with it.
const PANES_DIR = join(process.cwd(), "src", "workbench", "panes");
const PANES = Object.fromEntries(
  readdirSync(PANES_DIR)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => [f, readFileSync(join(PANES_DIR, f), "utf8")]),
);
const STAGE = read("src/workbench/WorkbenchStage.tsx");

/** region -> the pane module holding it and the component whose crash it
 *  has to contain. */
const SURFACES: ReadonlyArray<readonly [region: string, file: string, component: string]> = [
  ["drafter", "drafter.tsx", "PromptDrafter"],
  ["review pane", "review.tsx", "ReviewPanel"],
  ["memory", "memory.tsx", "MemorySurface"],
  ["collab plan editor", "plan.tsx", "PlanEditor"],
  ["plan editor", "plan.tsx", "PlanEditor"],
  ["browser", "browser.tsx", "BrowserPane"],
  ["chat", "chat.tsx", "ChatRoom"],
];

/** How far past the opening tag the component may sit. Generous enough for a
 *  multi-line boundary tag, tight enough that a boundary around some unrelated
 *  ancestor doesn't count. */
const WINDOW = 400;

describe("per-surface error boundaries", () => {
  it("contains the lazily loaded Repository view", () => {
    const panel = readFileSync(join(process.cwd(), "src/components/ReviewPanel.tsx"), "utf8");
    const start = panel.indexOf('<ErrorBoundary region="repository"');
    expect(start).toBeGreaterThan(-1);
    const window = panel.slice(start, start + 800);
    expect(window).toContain("fallback=");
    expect(window).toContain("<Suspense");
    expect(window).toContain("<GitRepositoryView");
  });

  for (const [region, file, component] of SURFACES) {
    it(`${region} is wrapped in a region-tagged ErrorBoundary`, () => {
      const src = PANES[file];
      expect(src, `src/workbench/panes/${file} is missing`).toBeDefined();
      const open = `<ErrorBoundary region="${region}"`;
      const at = src.indexOf(open);
      expect(
        at,
        `panes/${file} has no <ErrorBoundary region="${region}"> — a crash in ${component} would take the whole content area down with it`,
      ).toBeGreaterThan(-1);

      const window = src.slice(at, at + WINDOW);
      expect(
        window.includes(`<${component}`),
        `the "${region}" boundary does not open onto <${component}> within ${WINDOW} chars — it is guarding something else`,
      ).toBe(true);
      expect(
        window.includes("fallback="),
        `the "${region}" boundary has no fallback, so a crash there renders nothing`,
      ).toBe(true);
      // The boundary is App's no longer: one copy, in the pane module.
      expect(APP.includes(open), `App.tsx still holds the "${region}" boundary`).toBe(false);
    });
  }

  it("every pane sits in a boundary named for its kind, whatever its body", () => {
    // WorkbenchStage wraps each pane it lays out, so a body with no lazy
    // chunk of its own (a door, a file, a terminal wall) still crashes alone.
    const leaf = STAGE.slice(STAGE.indexOf("if (!isSplit(node)) {"), STAGE.indexOf("const children = node.children.map("));
    expect(leaf).toContain("<ErrorBoundary region={pane.kind} fallback={(err, reset) => <PaneFallback");
    expect(leaf).toContain("{renderPane(pane, { visible: visible && !hiddenByZoom, focused, active: shown })}");
  });

  it("every surface region is distinct", () => {
    const regions = SURFACES.map(([r]) => r);
    expect(
      new Set(regions).size,
      "two surfaces sharing a region name make the render_crash friction rows ambiguous",
    ).toBe(regions.length);
  });

  it("keeps a floor on the number of boundaries in App.tsx and its panes", () => {
    const count = [APP, ...Object.values(PANES)].reduce((n, src) => n + (src.match(/<ErrorBoundary\b/g) ?? []).length, 0);
    // The shell's own (content area, status bar, the dialog cluster, the
    // rail) + the surface boundaries above. A floor, not an exact count, so
    // adding containment never fails the test.
    expect(
      count,
      `only ${count} ErrorBoundary sites in App.tsx and its panes — surface containment regressed`,
    ).toBeGreaterThanOrEqual(11);
  });

  it("the shared fallback still routes through BoundaryFallback", () => {
    const fallback = PANES["fallback.tsx"];
    expect(
      /export const surfaceFallback\s*=/.test(fallback),
      "surfaceFallback is what gives every surface boundary a retry affordance",
    ).toBe(true);
    expect(
      /<BoundaryFallback\s+region=\{region\}/.test(fallback),
      "surfaceFallback must pass its region through, or the fallback text names the wrong surface",
    ).toBe(true);
    // Every pane module with a boundary takes its fallback from there.
    for (const [file, src] of Object.entries(PANES)) {
      if (file === "fallback.tsx" || !src.includes("<ErrorBoundary")) continue;
      expect(src, file).toContain('import { surfaceFallback } from "./fallback";');
    }
  });
});
