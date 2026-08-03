// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  iconFor,
  markFor,
  markPixels,
  type RepoIconResult,
  type RepoMark,
} from "./repoIcon";

/** The real neighbours in this workspace — the logo-less repos that would
 *  otherwise be an indistinguishable row of identical chips. */
const REPOS = [
  "redline",
  "qwallah",
  "test-plans",
  "med-records-request",
  "Tijara-V3",
  "albazianlaw.com",
  "nplajobportal",
  "keyword-research-agent",
];

/** Does the orbit of 0 under z → z² + c stay bounded? Recomputed here rather
 *  than imported so the test is an independent check on the picker. */
function inMandelbrot(cx: number, cy: number, steps = 500): boolean {
  let zx = 0;
  let zy = 0;
  for (let i = 0; i < steps; i++) {
    const next = zx * zx - zy * zy + cx;
    zy = 2 * zx * zy + cy;
    zx = next;
    if (zx * zx + zy * zy > 4) return false;
  }
  return true;
}

/** Which pixels belong to the set itself — the interior is the brightest
 *  color, so it is the one that appears most often at full saturation. Instead
 *  of guessing, classify by "is this pixel the same color as the tile centre's
 *  brightest band" would be fragile; count distinct colors instead where the
 *  shape matters, and use luminance for silhouette comparisons. */
function luminance(pixels: Uint8ClampedArray, i: number): number {
  return (
    0.2126 * pixels[i * 4] + 0.7152 * pixels[i * 4 + 1] + 0.0722 * pixels[i * 4 + 2]
  );
}

describe("markFor", () => {
  it("is deterministic — a repo never changes its mark between renders", () => {
    expect(markFor("redline")).toEqual(markFor("redline"));
    // And the mark fully determines the pixels, so two equal marks paint the
    // same tile. This is the property the image cache relies on.
    const a = markFor("qwallah");
    const copy: RepoMark = { ...a };
    expect(Array.from(markPixels(copy, 24))).toEqual(
      Array.from(markPixels(a, 24)),
    );
  });

  it("always picks a c inside the Mandelbrot set, so the set is connected", () => {
    // Fatou's dichotomy: c outside the set gives Cantor dust, which at 14 px
    // reads as noise rather than a mark. This is the one property that must
    // never regress.
    for (const name of [...REPOS, "", "---", "a", ".config", "x".repeat(200)]) {
      const m = markFor(name);
      expect(
        inMandelbrot(m.cx, m.cy),
        `${name} → c=(${m.cx}, ${m.cy}) escaped; its Julia set would be dust`,
      ).toBe(true);
    }
  });

  it("frames every mark in a usable window", () => {
    for (const name of REPOS) {
      const m = markFor(name);
      expect(m.view).toBeGreaterThan(0.1);
      // The filled Julia set is contained in this radius, so a wider window
      // would only be padding.
      expect(m.view).toBeLessThanOrEqual(
        (1 + Math.sqrt(1 + 4 * Math.hypot(m.cx, m.cy))) / 2 + 1e-9,
      );
      expect(m.hue).toBeGreaterThanOrEqual(0);
      expect(m.hue).toBeLessThan(360);
    }
  });

  it("gives distinct repos distinct marks", () => {
    const hues = new Set(REPOS.map((n) => markFor(n).hue));
    expect(hues.size).toBe(REPOS.length);
    const points = new Set(
      REPOS.map((n) => {
        const m = markFor(n);
        return `${m.cx.toFixed(4)},${m.cy.toFixed(4)}`;
      }),
    );
    expect(points.size).toBe(REPOS.length);
  });

  it("gives distinct repos visibly different silhouettes, not just hues", () => {
    // Hue alone would collapse under any color-blind or low-contrast viewing,
    // so the shapes have to carry information too. Compare tiles by luminance
    // so the comparison is about form rather than color.
    //
    // Scope: this guards THESE neighbours, which is what the tab strip actually
    // shows side by side; it is not a claim of global uniqueness. Measured over
    // 60 names the median pair differs by ~23% of pixels and the worst by ~2%,
    // so a rare near-twin is possible — and is still told apart by hue.
    const size = 24;
    const shapes = REPOS.map((n) => {
      const px = markPixels(markFor(n), size);
      const mid =
        Array.from({ length: size * size }, (_, i) => luminance(px, i)).reduce(
          (a, b) => a + b,
          0,
        ) /
        (size * size);
      return Array.from({ length: size * size }, (_, i) =>
        luminance(px, i) > mid ? 1 : 0,
      );
    });
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        let differing = 0;
        for (let k = 0; k < shapes[i].length; k++) {
          if (shapes[i][k] !== shapes[j][k]) differing++;
        }
        expect(
          differing / shapes[i].length,
          `${REPOS[i]} and ${REPOS[j]} render nearly the same shape`,
        ).toBeGreaterThan(0.05);
      }
    }
  });
});

describe("markPixels", () => {
  it("fills an opaque RGBA buffer of the requested size", () => {
    const px = markPixels(markFor("redline"), 16);
    expect(px.length).toBe(16 * 16 * 4);
    for (let i = 0; i < 16 * 16; i++) expect(px[i * 4 + 3]).toBe(255);
  });

  it("draws an actual figure — neither an empty tile nor a solid block", () => {
    // The two ways a generated mark fails silently. Every repo's tile must have
    // real body AND real background.
    const size = 32;
    for (const name of REPOS) {
      const px = markPixels(markFor(name), size);
      const lums = Array.from({ length: size * size }, (_, i) =>
        luminance(px, i),
      );
      const brightest = Math.max(...lums);
      const body = lums.filter((l) => l > brightest * 0.75).length;
      const fraction = body / (size * size);
      expect(fraction, `${name} tile is too sparse`).toBeGreaterThan(0.08);
      expect(fraction, `${name} tile is a solid block`).toBeLessThan(0.75);
    }
  });

  it("keeps the set centred, as its z → −z symmetry implies", () => {
    // A mark that drifts off-centre stops reading as an emblem. Every filled
    // Julia set is symmetric through the origin, and the window is centred
    // there, so the tile must be symmetric under a 180° rotation.
    const size = 24;
    const px = markPixels(markFor("qwallah"), size);
    for (let i = 0; i < size * size; i++) {
      const opposite = size * size - 1 - i;
      expect(Math.abs(luminance(px, i) - luminance(px, opposite))).toBeLessThan(
        1e-9,
      );
    }
  });
});

describe("iconFor", () => {
  const withLogo: RepoIconResult = {
    root: "/Users/me/redline",
    name: "redline",
    dataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
  };

  it("uses the repo's logo when it ships one", () => {
    expect(iconFor(withLogo, "src").src).toBe(withLogo.dataUrl);
  });

  it("still carries the generated mark alongside a logo, as the decode fallback", () => {
    const icon = iconFor(withLogo, "src");
    // Derived from the REPO name, not the tab's label — an `<img>` that fails
    // to decode must not suddenly start describing the folder.
    expect(icon.mark).toEqual(markFor("redline"));
  });

  it("degrades to the generated mark when the repo has no logo", () => {
    const icon = iconFor({ ...withLogo, dataUrl: null }, "src");
    expect(icon.src).toBeNull();
    expect(icon.mark).toEqual(markFor("redline"));
  });

  it("falls back to the label while the lookup is still pending", () => {
    const icon = iconFor(undefined, "zsh");
    expect(icon.src).toBeNull();
    expect(icon.mark).toEqual(markFor("zsh"));
    expect(icon.tint).toBe(`hsl(${markFor("zsh").hue} 55% 45%)`);
  });

  it("prefers the label over an empty repo name", () => {
    // `repo_icon` on "/" has no basename to report; the tab's own label is the
    // only thing left that means anything.
    expect(iconFor({ root: "/", name: "", dataUrl: null }, "zsh").mark).toEqual(
      markFor("zsh"),
    );
  });
});
