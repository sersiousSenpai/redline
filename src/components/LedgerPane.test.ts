// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, it, expect } from "vitest";
import { kindLabel, describeVerdict } from "./LedgerPane";

describe("kindLabel", () => {
  it("maps known ledger kinds to human labels", () => {
    expect(kindLabel("prompt")).toBe("Prompt");
    expect(kindLabel("review_verdict")).toBe("Review verdict");
    expect(kindLabel("source_trust")).toBe("Source trust");
  });

  it("falls back to the raw kind for anything unknown", () => {
    expect(kindLabel("future_kind")).toBe("future_kind");
  });
});

describe("describeVerdict", () => {
  it("reports an intact chain with count and head hash", () => {
    const s = describeVerdict({
      ok: true,
      checked: 3,
      firstBadSeq: null,
      headHash: "abcdef0123456789",
    });
    expect(s).toContain("Chain intact");
    expect(s).toContain("3 events verified");
    expect(s).toContain("head abcdef012345…");
  });

  it("singularizes a one-event chain and omits a missing head", () => {
    expect(describeVerdict({ ok: true, checked: 1, firstBadSeq: null, headHash: null })).toBe(
      "✓ Chain intact — 1 event verified",
    );
  });

  it("names the first bad seq when the chain is broken", () => {
    const s = describeVerdict({ ok: false, checked: 2, firstBadSeq: 3, headHash: null });
    expect(s).toContain("Chain broken at seq 3");
    expect(s).toContain("verified 2 before the break");
  });
});
