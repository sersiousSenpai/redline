// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { diffWords } from "./wordDiff";

describe("diffWords", () => {
  it("returns a single equal run for identical text", () => {
    expect(diffWords("the plan is fine", "the plan is fine")).toEqual([
      { kind: "equal", text: "the plan is fine" },
    ]);
  });

  it("marks an inserted word", () => {
    const d = diffWords("ship it", "ship it now");
    expect(d.map((p) => p.kind)).toContain("insert");
    expect(d.filter((p) => p.kind === "insert").map((p) => p.text).join(""))
      .toContain("now");
  });

  it("marks a deleted word", () => {
    const d = diffWords("ship it now", "ship it");
    expect(d.some((p) => p.kind === "delete" && p.text.includes("now"))).toBe(
      true,
    );
  });

  it("reconstructs both sides losslessly", () => {
    const a = "alpha beta gamma";
    const b = "alpha delta gamma epsilon";
    const d = diffWords(a, b);
    const original = d
      .filter((p) => p.kind !== "insert")
      .map((p) => p.text)
      .join("");
    const revised = d
      .filter((p) => p.kind !== "delete")
      .map((p) => p.text)
      .join("");
    expect(original).toBe(a);
    expect(revised).toBe(b);
  });
});
