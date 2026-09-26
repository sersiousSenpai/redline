import { describe, expect, it } from "vitest";
import { appearanceCss, DEFAULT_APPEARANCE, normalizeAppearance, siteKey } from "./browserAppearance";
describe("site appearance", () => {
  it("does not invert sites merely requesting their dark theme", () => {
    expect(appearanceCss({ ...DEFAULT_APPEARANCE, website: "dark" })).toBe("");
    expect(appearanceCss({ ...DEFAULT_APPEARANCE, website: "forced" })).toContain("invert(1)");
  });
  it("keeps reading changes independent and bounded", () => {
    expect(normalizeAppearance({ zoom: Infinity, brightness: -5 })).toMatchObject({ zoom: 1, brightness: .5 });
    expect(appearanceCss({ ...DEFAULT_APPEARANCE, brightness: .8 })).toBe("body{filter:brightness(0.8)!important}");
    expect(siteKey("https://example.org/a?q=secret")).toBe("https://example.org");
  });
});
