// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { DEFAULT_FONT, FONTS, getFont, isFontName } from "./fonts";

describe("fonts catalog", () => {
  it("includes San Francisco and sets it as the default", () => {
    expect(isFontName(DEFAULT_FONT)).toBe(true);
    expect(DEFAULT_FONT).toBe("san-francisco");
    const sf = getFont(DEFAULT_FONT);
    expect(sf.label).toBe("San Francisco");
    // The SF stack resolves to the OS system font on Apple platforms.
    expect(sf.stack).toContain("-apple-system");
  });

  it("has unique names and a non-empty stack for every entry", () => {
    const names = FONTS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    for (const f of FONTS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.stack.length).toBeGreaterThan(0);
    }
  });
});

describe("isFontName", () => {
  it("accepts known font slugs", () => {
    expect(isFontName("san-francisco")).toBe(true);
    expect(isFontName("new-york")).toBe(true);
  });

  it("rejects unknown or non-string values", () => {
    expect(isFontName("comic-sans")).toBe(false);
    expect(isFontName("")).toBe(false);
    expect(isFontName(null)).toBe(false);
    expect(isFontName(42)).toBe(false);
  });
});

describe("getFont", () => {
  it("resolves a known name to its entry", () => {
    expect(getFont("futura").label).toBe("Futura");
  });

  it("falls back to the first entry for an unknown name", () => {
    expect(getFont("does-not-exist")).toBe(FONTS[0]);
  });
});
