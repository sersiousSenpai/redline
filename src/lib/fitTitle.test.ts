// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { fitTitle, keepHyphens } from "./fitTitle";

/** A column that holds `max` characters, as a measurer would report it. */
const column = (max: number) => {
  const tried: string[] = [];
  const fits = (text: string) => { tried.push(text); return text.length <= max; };
  return { fits, tried };
};
const LONG = "MachineOS Desk: native LiDAR capture, gaussian-splat preview and the calibration loop for the second sensor head";

describe("fitTitle", () => {
  it("returns the whole title when it fits", () => {
    expect(fitTitle("Auth rewrite", column(40).fits)).toBe("Auth rewrite");
  });

  it("cuts only between words, and every word it keeps is whole", () => {
    const shown = fitTitle(LONG, column(60).fits);
    expect(shown.endsWith("…")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(60);
    const kept = shown.slice(0, -1).split(" ");
    expect(kept).toEqual(LONG.split(" ").slice(0, kept.length).map((word, i) => (i === kept.length - 1 ? word.replace(/[,:]$/, "") : word)));
  });

  it("keeps as many words as fit, not fewer", () => {
    const shown = fitTitle(LONG, column(60).fits);
    const next = LONG.split(" ").slice(0, shown.slice(0, -1).split(" ").length + 1).join(" ");
    expect(`${next}…`.length).toBeGreaterThan(60);
  });

  it("drops trailing punctuation before the ellipsis", () => {
    expect(fitTitle("Voice runtime: keep barge-in alive", column(16).fits)).toBe("Voice runtime…");
    expect(fitTitle("One, two, three four five", column(10).fits)).toBe("One, two…");
    expect(fitTitle("Plan · the billing export", column(8).fits)).toBe("Plan…");
    expect(fitTitle("Draft — and then some more", column(8).fits)).toBe("Draft…");
    expect(fitTitle("Draft – and then some more", column(8).fits)).toBe("Draft…");
    expect(fitTitle("Plan; the billing export", column(8).fits)).toBe("Plan…");
  });

  it("never yields a partial word, even when nothing but the first fits", () => {
    for (let max = 1; max < LONG.length; max++) {
      const shown = fitTitle(LONG, column(max).fits).slice(0, -1);
      for (const word of shown.split(" ")) expect(LONG).toMatch(new RegExp(`(^| )${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[,:]?( |$)`));
    }
  });

  it("keeps a single over-long first word whole; the stylesheet clips it", () => {
    expect(fitTitle("Supercalifragilistic", column(5).fits)).toBe("Supercalifragilistic");
    expect(fitTitle("Supercalifragilistic expialidocious", column(5).fits)).toBe("Supercalifragilistic…");
  });

  it("measures a few dozen candidates at most", () => {
    const { fits, tried } = column(60);
    fitTitle(`${LONG} ${LONG} ${LONG}`, fits);
    expect(tried.length).toBeLessThanOrEqual(8);
  });
});

describe("keepHyphens", () => {
  it("makes a hyphen between letters non-breaking", () => {
    expect(keepHyphens("keep barge-in from killing the warm session")).toBe("keep barge\u2011in from killing the warm session");
    expect(keepHyphens("gaussian-splat Qwen3-TTS")).toBe("gaussian\u2011splat Qwen3-TTS");
    expect(keepHyphens("état-major")).toBe("état\u2011major");
  });

  it("leaves dashes that are not inside a word alone", () => {
    expect(keepHyphens("Front Door - polish")).toBe("Front Door - polish");
    expect(keepHyphens("v2-3 and 10-11")).toBe("v2-3 and 10-11");
    expect(keepHyphens("re-")).toBe("re-");
  });
});
