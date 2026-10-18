// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveTokens } from "./derive";
import { THEMES } from "./themes";
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (c: number[]) => c.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
const contrast = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
describe("glass material", () => {
  for (const theme of THEMES) it(`${theme.name}: readable across all tiers`, () => {
    const t = deriveTokens(theme.base);
    for (const tier of [1, 2, 3] as const) {
      const [r, g, b, alpha] = t[`color-glass-${tier}`].match(/[\d.]+/g)!.map(Number);
      for (const under of [t["color-paper"], t["color-canvas"], t["color-bg-elevated"]]) {
        const bg = rgb(under).map((v, i) => v * (1 - alpha) + [r, g, b][i] * alpha);
        expect(contrast(rgb(t["color-ink"]), bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const mode of ["plan", "redline", "build", "danger"] as const)
      expect(contrast(rgb(t[`color-mode-${mode}-fg`]), rgb(t[`color-mode-${mode}-bg`]))).toBeGreaterThanOrEqual(4.5);
  });
  it("does not add opaque floating menu fills", () => {
    for (const file of ["src/components/ui/MenuSurface.tsx", "src/components/ComposerMenu.css"])
      expect(readFileSync(file, "utf8")).not.toMatch(/background:\s*["']?var\(--color-bg-elevated\)/);
    const count = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
      const file = join(dir, entry.name);
      return total + (entry.isDirectory() ? count(file) : file.endsWith(".tsx") && !file.includes(".test.") ? (readFileSync(file, "utf8").match(/background:\s*["']var\(--color-bg-elevated\)/g) ?? []).length : 0);
    }, 0);
    expect(count("src")).toBeLessThanOrEqual(138);
  });
});
