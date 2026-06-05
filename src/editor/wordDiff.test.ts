// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { compactEditPreview, diffWords } from "./wordDiff";

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

  it("marks only the changed word in a long sentence (precision)", () => {
    // Regression for the precision-highlight contract: a single-word edit in
    // a long sentence must produce ins/del runs covering only that word —
    // the surrounding prose stays "equal" so the in-editor highlight lands
    // on the actual change, not the entire paragraph.
    const original = "The quick brown fox jumps over the lazy dog quietly.";
    const revised = "The quick brown fox leaps over the lazy dog quietly.";
    const parts = diffWords(original, revised);
    const ins = parts.filter((p) => p.kind === "insert");
    const del = parts.filter((p) => p.kind === "delete");
    expect(ins.map((p) => p.text.trim()).join("")).toBe("leaps");
    expect(del.map((p) => p.text.trim()).join("")).toBe("jumps");
    // Everything before and after the changed word survives as a single
    // contiguous equal run on each side — no spurious break-up.
    const equals = parts.filter((p) => p.kind === "equal").map((p) => p.text);
    expect(equals.some((t) => t.includes("The quick brown fox"))).toBe(true);
    expect(equals.some((t) => t.includes("over the lazy dog quietly."))).toBe(
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

describe("compactEditPreview", () => {
  it("keeps changed runs and trims long equal context with an ellipsis", () => {
    const original =
      "This is a fairly long sentence that we should edit only once.";
    const revised =
      "This is a fairly long sentence that we must edit only once.";
    const parts = compactEditPreview(original, revised, 8);
    // The change survives verbatim.
    expect(parts.some((p) => p.kind === "delete" && p.text.includes("should")))
      .toBe(true);
    expect(parts.some((p) => p.kind === "insert" && p.text.includes("must")))
      .toBe(true);
    // Long equal runs are elided.
    expect(parts.some((p) => p.kind === "equal" && p.text.includes("…"))).toBe(
      true,
    );
    // The rendered preview is far shorter than the full before+after.
    const rendered = parts.map((p) => p.text).join("");
    expect(rendered.length).toBeLessThan(original.length);
  });

  it("leaves a short edit untouched", () => {
    const parts = compactEditPreview("ship it", "ship it now");
    expect(parts.every((p) => !p.text.includes("…"))).toBe(true);
  });
});
