// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, it, expect } from "vitest";
import { tokenizeLint } from "./lintTokenize";

/** Convenience: the substrings the tokenizer picked out, paired with kind. */
function toks(text: string) {
  return tokenizeLint(text).map((t) => ({
    kind: t.kind,
    text: text.slice(t.start, t.end),
  }));
}

describe("tokenizeLint", () => {
  it("returns nothing for plain prose and empty input", () => {
    expect(tokenizeLint("")).toEqual([]);
    expect(tokenizeLint("just some ordinary words here")).toEqual([]);
  });

  it("tags numbers, including hex, decimals, grouped and percentages", () => {
    expect(toks("we shipped 42 of 3.14 at 100% (0xFF)")).toEqual([
      { kind: "num", text: "42" },
      { kind: "num", text: "3.14" },
      { kind: "num", text: "100%" },
      { kind: "punct", text: "(" },
      { kind: "num", text: "0xFF" },
      { kind: "punct", text: ")" },
    ]);
  });

  it("tags quoted strings but not apostrophes mid-word", () => {
    expect(toks('say "hello there" now')).toEqual([
      { kind: "str", text: '"hello there"' },
    ]);
    // A lone apostrophe in "don't" must not open an unterminated string.
    expect(toks("don't stop")).toEqual([]);
  });

  it("tags ALL-CAPS keywords of two or more chars", () => {
    expect(toks("the API returns a TODO note")).toEqual([
      { kind: "kw", text: "API" },
      { kind: "kw", text: "TODO" },
    ]);
    // Single capitals (sentence starts, the pronoun I) are not keywords.
    expect(toks("A cat. I ran.")).toEqual([]);
  });

  it("tags URLs and file paths ahead of their embedded dots/numbers", () => {
    const t = toks("see https://example.com/v2 and src/App.tsx and /etc/hosts");
    expect(t).toEqual([
      { kind: "url", text: "https://example.com/v2" },
      { kind: "url", text: "src/App.tsx" },
      { kind: "url", text: "/etc/hosts" },
    ]);
  });

  it("does not treat a sentence-ending word.dot as a path", () => {
    // "etc." has no letters after the final dot → not a URL, and no other
    // token kind → nothing emitted.
    expect(toks("blah blah etc. done")).toEqual([]);
  });

  it("tags brackets that give prose a code silhouette", () => {
    expect(toks("call fn[0] {x}")).toEqual([
      { kind: "punct", text: "[" },
      { kind: "num", text: "0" },
      { kind: "punct", text: "]" },
      { kind: "punct", text: "{" },
      { kind: "punct", text: "}" },
    ]);
  });
});
