// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flashPaint, hueOf, isRedHue } from "./FlashOverlay";

const SRC = join(__dirname, "..");

describe("the plan-arrival pulse is amber, never red (the last walk's RGB 53,26,29)", () => {
  it("paints the amber token for no pick, the old default, and any red picked since", () => {
    for (const red of ["", "  ", "#e8553d", "#E8553D", "#ff2600", "#f00", "#cc0000", "rgb(232, 85, 61)", "#ff3b6b", "red", "tomato"]) {
      expect(flashPaint(red)).toBe("var(--color-warning)");
    }
    expect(flashPaint(null)).toBe("var(--color-warning)");
  });

  it("keeps a picked colour that is not a red", () => {
    for (const ok of ["#d6c060", "#3d85c6", "#6aa84f", "#e69138", "#888888"]) expect(flashPaint(ok)).toBe(ok);
    expect(hueOf("#ff2600")!.hue).toBeLessThan(10);
    expect(isRedHue("#e69138")).toBe(false); // orange-amber stays a pick
    expect(hueOf("var(--x)")).toBeNull();
  });

  it("no stylesheet gives a flash or arrival rule a red hue", () => {
    const css: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".css")) css.push(readFileSync(path, "utf8"));
      }
    };
    walk(SRC);
    // Every rule or keyframes block whose selector names a flash or an
    // arrival, with its body.
    const blocks: { head: string; body: string }[] = [];
    for (const text of css) {
      const re = /([^{}]*(?:flash|arriv)[^{}]*)\{((?:[^{}]|\{[^{}]*\})*)\}/gi;
      for (const m of text.matchAll(re)) blocks.push({ head: m[1].trim(), body: m[2] });
    }
    expect(blocks.some((b) => /redline-flash/.test(b.head))).toBe(true);
    const reds: string[] = [];
    for (const { head, body } of blocks) {
      for (const color of body.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:red|crimson|tomato|orangered)\b|var\(--color-(?:danger|error|selection|redline)[^)]*\)/gi) ?? []) {
        if (/^var\(/.test(color) || isRedHue(color)) reds.push(`${head}: ${color}`);
      }
    }
    expect(reds).toEqual([]);
    // The overlay's own source paints only through `flashPaint`.
    const overlay = readFileSync(join(__dirname, "FlashOverlay.tsx"), "utf8");
    expect(overlay).toMatch(/background: flashPaint\(color\)/);
  });
});
