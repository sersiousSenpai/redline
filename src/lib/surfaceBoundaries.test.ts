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
import { readFileSync } from "node:fs";
import { join } from "node:path";

// vitest runs with cwd = repo root (import.meta.url is a jsdom localhost URL
// here, so it can't locate the tree).
const APP = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");

/** region -> the component whose crash it has to contain. */
const SURFACES: ReadonlyArray<readonly [region: string, component: string]> = [
  ["drafter", "PromptDrafter"],
  ["review pane", "ReviewPanel"],
  ["memory", "MemorySurface"],
  ["runs", "OrchestrationSurface"],
  ["collab plan editor", "PlanEditor"],
  ["plan editor", "PlanEditor"],
  ["browser", "BrowserPane"],
  ["chat", "ChatRoom"],
];

/** How far past the opening tag the component may sit. Generous enough for a
 *  multi-line boundary tag, tight enough that a boundary around some unrelated
 *  ancestor doesn't count. */
const WINDOW = 400;

describe("per-surface error boundaries", () => {
  for (const [region, component] of SURFACES) {
    it(`${region} is wrapped in a region-tagged ErrorBoundary`, () => {
      const open = `<ErrorBoundary region="${region}"`;
      const at = APP.indexOf(open);
      expect(
        at,
        `App.tsx has no <ErrorBoundary region="${region}"> — a crash in ${component} would take the whole content area down with it`,
      ).toBeGreaterThan(-1);

      const window = APP.slice(at, at + WINDOW);
      expect(
        window.includes(`<${component}`),
        `the "${region}" boundary does not open onto <${component}> within ${WINDOW} chars — it is guarding something else`,
      ).toBe(true);
      expect(
        window.includes("fallback="),
        `the "${region}" boundary has no fallback, so a crash there renders nothing`,
      ).toBe(true);
    });
  }

  it("every surface region is distinct", () => {
    const regions = SURFACES.map(([r]) => r);
    expect(
      new Set(regions).size,
      "two surfaces sharing a region name make the render_crash friction rows ambiguous",
    ).toBe(regions.length);
  });

  it("keeps a floor on the number of boundaries in App.tsx", () => {
    const count = (APP.match(/<ErrorBoundary\b/g) ?? []).length;
    // 3 pre-existing (session header, content area, and the two top-level
    // shells) + the 8 surface boundaries above. A floor, not an exact count,
    // so adding containment never fails the test.
    expect(
      count,
      `only ${count} ErrorBoundary sites in App.tsx — surface containment regressed`,
    ).toBeGreaterThanOrEqual(11);
  });

  it("the shared fallback still routes through BoundaryFallback", () => {
    expect(
      /const surfaceFallback\s*=/.test(APP),
      "surfaceFallback is what gives every surface boundary a retry affordance",
    ).toBe(true);
    expect(
      /<BoundaryFallback\s+region=\{region\}/.test(APP),
      "surfaceFallback must pass its region through, or the fallback text names the wrong surface",
    ).toBe(true);
  });
});
