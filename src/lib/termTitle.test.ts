// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { elide, workFromTitle, workSignal } from "./termTitle";

const DIR = "/Users/dev/redline";

describe("workFromTitle", () => {
  it("keeps a title that names actual work", () => {
    expect(workFromTitle("npm run dev", DIR)).toBe("npm run dev");
    expect(workFromTitle("✳ Repo bubbles — editing", DIR)).toBe(
      "✳ Repo bubbles — editing",
    );
  });

  it("keeps only what follows a user@host prefix", () => {
    expect(workFromTitle("dev@mac: npm run dev", DIR)).toBe("npm run dev");
  });

  it("drops the default cwd titles a shell writes", () => {
    expect(workFromTitle("~/redline", DIR)).toBeNull();
    expect(workFromTitle("/Users/dev/redline", DIR)).toBeNull();
    expect(workFromTitle("dev@mac: ~/redline", DIR)).toBeNull();
    expect(workFromTitle("./scripts", DIR)).toBeNull();
  });

  it("drops a title that just repeats the folder the row already shows", () => {
    expect(workFromTitle("redline", DIR)).toBeNull();
    // Same word, different terminal: with no cwd known it says something.
    expect(workFromTitle("redline", null)).toBe("redline");
  });

  it("drops a title that just names the shell", () => {
    expect(workFromTitle("zsh", DIR)).toBeNull();
    expect(workFromTitle("-zsh", DIR)).toBeNull();
    expect(workFromTitle("Bash", DIR)).toBeNull();
  });

  it("survives empty, blank and control-laden titles", () => {
    expect(workFromTitle(null, DIR)).toBeNull();
    expect(workFromTitle(undefined, DIR)).toBeNull();
    expect(workFromTitle("   ", DIR)).toBeNull();
    expect(workFromTitle("cargo test", DIR)).toBe("cargo test");
  });

  it("elides a very long title", () => {
    const long = "x".repeat(120);
    const out = workFromTitle(long, DIR)!;
    expect(out).toHaveLength(64);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("workSignal", () => {
  it("prefers a held plan over whatever the title says", () => {
    expect(workSignal("Repo bubbles in the tab bar", "npm run dev", DIR)).toEqual({
      text: "Repo bubbles in the tab bar",
      held: true,
    });
  });

  it("falls back to the title when no plan is held", () => {
    expect(workSignal(null, "npm run dev", DIR)).toEqual({
      text: "npm run dev",
      held: false,
    });
  });

  it("is null when neither source knows anything", () => {
    expect(workSignal(null, "~/redline", DIR)).toBeNull();
    expect(workSignal("", "", DIR)).toBeNull();
    expect(workSignal(undefined, undefined, null)).toBeNull();
  });

  it("normalizes a multi-line plan heading", () => {
    expect(workSignal("  Repo\n bubbles  ", null, DIR)).toEqual({
      text: "Repo bubbles",
      held: true,
    });
  });
});

describe("elide", () => {
  it("leaves short strings alone and marks long ones", () => {
    expect(elide("short", 10)).toBe("short");
    expect(elide("abcdefghijkl", 6)).toBe("abcde…");
  });
});
