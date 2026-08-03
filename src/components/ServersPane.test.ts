import { describe, expect, it } from "vitest";
import { formatLastRun, middleTruncate } from "./ServersPane";

describe("middleTruncate", () => {
  it("leaves a short path alone", () => {
    expect(middleTruncate("/Users/me/app")).toBe("/Users/me/app");
  });

  it("keeps BOTH ends — the anchor and the identifying leaf", () => {
    const path = "/Users/me/code/clients/acme/2026/q3/frontend-web";
    const got = middleTruncate(path, 30);
    expect(got.length).toBeLessThanOrEqual(30);
    expect(got).toContain("…");
    expect(got.startsWith("/Users")).toBe(true);
    expect(got.endsWith("frontend-web")).toBe(true);
  });

  it("never truncates below a legible floor", () => {
    // Even an absurd budget must leave something on each side rather than
    // collapsing to a bare ellipsis.
    const got = middleTruncate("/a/very/long/path/to/somewhere", 4);
    expect(got).toMatch(/^.+….+$/);
  });
});

describe("formatLastRun", () => {
  const now = 1_700_000_000_000;
  const ago = (ms: number) => formatLastRun(now - ms, now);

  it("uses the coarse unit a glance wants", () => {
    expect(ago(5_000)).toBe("just now");
    expect(ago(20 * 60_000)).toBe("20m ago");
    expect(ago(3 * 3_600_000)).toBe("3h ago");
    expect(ago(2 * 86_400_000)).toBe("2d ago");
    expect(ago(60 * 86_400_000)).toBe("2mo ago");
    expect(ago(400 * 86_400_000)).toBe("1y ago");
  });

  it("a clock that skewed backwards reads as just now, never a negative", () => {
    expect(formatLastRun(now + 10_000, now)).toBe("just now");
  });
});
