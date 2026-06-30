// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, it, expect } from "vitest";
import { resolveOmniboxInput } from "./omnibox";

const SEARCH = "https://www.google.com/search?q=";

describe("resolveOmniboxInput", () => {
  it("returns null for empty / whitespace input", () => {
    expect(resolveOmniboxInput("")).toBeNull();
    expect(resolveOmniboxInput("   ")).toBeNull();
  });

  it("passes through inputs that already have a scheme", () => {
    expect(resolveOmniboxInput("https://example.com/a?b=c")).toBe(
      "https://example.com/a?b=c",
    );
    expect(resolveOmniboxInput("http://example.com")).toBe(
      "http://example.com",
    );
    expect(resolveOmniboxInput("mailto:hi@example.com")).toBe(
      "mailto:hi@example.com",
    );
    expect(resolveOmniboxInput("about:blank")).toBe("about:blank");
  });

  it("adds https:// to a bare domain", () => {
    expect(resolveOmniboxInput("github.com")).toBe("https://github.com");
    expect(resolveOmniboxInput("github.com/anthropics")).toBe(
      "https://github.com/anthropics",
    );
    expect(resolveOmniboxInput("news.ycombinator.com")).toBe(
      "https://news.ycombinator.com",
    );
  });

  it("treats localhost and IPs as URLs", () => {
    expect(resolveOmniboxInput("localhost:3000")).toBe(
      "https://localhost:3000",
    );
    expect(resolveOmniboxInput("127.0.0.1:8080/x")).toBe(
      "https://127.0.0.1:8080/x",
    );
  });

  it("searches multi-word queries", () => {
    expect(resolveOmniboxInput("best pizza near me")).toBe(
      SEARCH + encodeURIComponent("best pizza near me"),
    );
  });

  it("searches a single word with no dot", () => {
    expect(resolveOmniboxInput("redline")).toBe(
      SEARCH + encodeURIComponent("redline"),
    );
  });

  it("searches a dotted phrase that contains spaces", () => {
    expect(resolveOmniboxInput("what is rust vs. go")).toBe(
      SEARCH + encodeURIComponent("what is rust vs. go"),
    );
  });

  it("does not treat a malformed dotted token as a host", () => {
    // empty label after the dot, and a non-alpha TLD → both search, not navigate
    expect(resolveOmniboxInput("foo.")).toBe(SEARCH + encodeURIComponent("foo."));
    expect(resolveOmniboxInput("hello.world!")).toBe(
      SEARCH + encodeURIComponent("hello.world!"),
    );
  });

  it("encodes query characters safely", () => {
    expect(resolveOmniboxInput("c++ & rust")).toBe(
      SEARCH + encodeURIComponent("c++ & rust"),
    );
  });
});
