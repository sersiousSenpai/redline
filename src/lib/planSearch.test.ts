// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { researchQuery, researchSearchUrl, researchSeed, ridesSubmit } from "./planSearch";

describe("search from the plan", () => {
  it("builds the seed from the selection plus the instruction", () => {
    const seed = researchSeed("Use a token bucket\nper tenant", "compare with sliding window", "Rate limits");
    expect(seed).toBe(
      'From a passage in the plan "Rate limits":\n> Use a token bucket\n> per tenant\n\ncompare with sliding window',
    );
    expect(researchSeed("x", "")).toContain("prefer WebSearch");
    expect(researchQuery("Use a  token\nbucket", " compare ")).toBe("Use a token bucket — compare");
  });

  it("opens the tab on a web search for the passage", () => {
    expect(researchSearchUrl("token bucket", "vs leaky")).toBe("https://www.google.com/search?q=token%20bucket%20vs%20leaky");
  });

  it("never lets an unpromoted research comment ride a Revise", () => {
    const research = { query: "q", browseId: "b" };
    expect(ridesSubmit({ status: "draft", research })).toBe(false);
    expect(ridesSubmit({ status: "draft", research, actionable: true })).toBe(true);
    expect(ridesSubmit({ status: "draft" })).toBe(true);
    expect(ridesSubmit({ status: "reopened" })).toBe(true);
    expect(ridesSubmit({ status: "submitted" })).toBe(false);
  });
});
