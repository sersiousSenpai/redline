// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { DEFAULT_LINT, LINTS, getLint, isLintName } from "./lint";

describe("lint catalog", () => {
  it("defaults to Off (opt-in coloring) and Off leads the list", () => {
    expect(isLintName(DEFAULT_LINT)).toBe(true);
    expect(DEFAULT_LINT).toBe("off");
    expect(LINTS[0].name).toBe("off");
    // Off carries no preview swatches (it is plain prose).
    expect(getLint("off").swatches).toBeUndefined();
  });

  it("ships the Cyberpunk theme with a preview palette", () => {
    const cp = getLint("cyberpunk");
    expect(cp.label).toBe("Cyberpunk");
    expect(cp.swatches && cp.swatches.length).toBeGreaterThan(0);
  });

  it("has unique names and a non-empty label/description per entry", () => {
    const names = LINTS.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
    for (const l of LINTS) {
      expect(l.label.length).toBeGreaterThan(0);
      expect(l.description.length).toBeGreaterThan(0);
    }
  });
});

describe("isLintName", () => {
  it("accepts known lint slugs", () => {
    expect(isLintName("off")).toBe(true);
    expect(isLintName("cyberpunk")).toBe(true);
  });

  it("rejects unknown or non-string values", () => {
    expect(isLintName("synthwave")).toBe(false);
    expect(isLintName("")).toBe(false);
    expect(isLintName(null)).toBe(false);
    expect(isLintName(42)).toBe(false);
  });
});

describe("getLint", () => {
  it("falls back to the first entry (Off) for an unknown name", () => {
    expect(getLint("does-not-exist")).toBe(LINTS[0]);
  });
});
