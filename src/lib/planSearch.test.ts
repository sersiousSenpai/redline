// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { browserTarget, researchQuery, researchSearchUrl, researchSeed, ridesSubmit } from "./planSearch";

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

describe("browserTarget", () => {
  it("opens what looks like an address and searches for anything else", () => {
    expect(browserTarget("https://example.com/x")).toBe("https://example.com/x");
    expect(browserTarget("example.com")).toBe("https://example.com");
    expect(browserTarget("docs.rs/tokio")).toBe("https://docs.rs/tokio");
    expect(browserTarget("localhost:5173")).toBe("http://localhost:5173");
    expect(browserTarget(":7676/health")).toBe("http://localhost:7676/health");
    expect(browserTarget("portable-pty resize race")).toBe("https://www.google.com/search?q=portable-pty%20resize%20race");
    expect(browserTarget("what is tauri.conf")).toBe("https://www.google.com/search?q=what%20is%20tauri.conf");
  });
});
