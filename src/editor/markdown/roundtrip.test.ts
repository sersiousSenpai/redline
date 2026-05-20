// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { planMarkdownToDoc } from "./parser";
import { planDocToMarkdown } from "./serializer";
import { stripSidecars } from "./sidecar";

/**
 * Phase 0 release gate (see plan): markdown → PM → sidecar-markdown must be a
 * fixed point (idempotent) and blockId-stable. This is the JS mirror of the
 * Rust `parse_plan_with_sidecars` idempotency invariant; if it drifts, an
 * unedited block would read as a phantom `edit` and spam the comment pane.
 */

// Sidecar-augmented, in the exact shape the Rust parser emits: one
// `<!-- rl:blk-… -->` immediately before every top-level block.
const RICH_PLAN = [
  "<!-- rl:blk-aaaa1111 -->",
  "# Plan Title",
  "",
  "<!-- rl:blk-bbbb2222 -->",
  "Intro paragraph with **bold**, *italic*, `code`, ~~strike~~ and a",
  "[link](https://example.com).",
  "",
  "<!-- rl:blk-cccc3333 -->",
  "## Approach",
  "",
  "<!-- rl:blk-dddd4444 -->",
  "- First bullet",
  "- Second bullet",
  "",
  "<!-- rl:blk-eeee5555 -->",
  "1. Step one",
  "2. Step two",
  "",
  "<!-- rl:blk-ffff6666 -->",
  "```rust",
  "fn main() {}",
  "```",
  "",
  "<!-- rl:blk-aaaa7777 -->",
  "> A quoted line.",
  "",
  "<!-- rl:blk-bbbb8888 -->",
  "| Col A | Col B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
].join("\n");

const ALL_IDS = [
  "blk-aaaa1111",
  "blk-bbbb2222",
  "blk-cccc3333",
  "blk-dddd4444",
  "blk-eeee5555",
  "blk-ffff6666",
  "blk-aaaa7777",
  "blk-bbbb8888",
];

describe("plan markdown round-trip", () => {
  it("is a fixed point: serialize(parse(x)) == serialize(parse(serialize(parse(x))))", () => {
    const c1 = planDocToMarkdown(planMarkdownToDoc(RICH_PLAN), {
      sidecars: true,
    });
    const c2 = planDocToMarkdown(planMarkdownToDoc(c1), { sidecars: true });
    expect(c2).toBe(c1);
  });

  it("preserves every blockId across reparse", () => {
    const c1 = planDocToMarkdown(planMarkdownToDoc(RICH_PLAN), {
      sidecars: true,
    });
    const c2 = planDocToMarkdown(planMarkdownToDoc(c1), { sidecars: true });
    expect(stripSidecars(c1).ids).toEqual(ALL_IDS);
    expect(stripSidecars(c2).ids).toEqual(ALL_IDS);
  });

  it("emits exactly one sidecar per top-level block", () => {
    const doc = planMarkdownToDoc(RICH_PLAN);
    expect(doc.childCount).toBe(ALL_IDS.length);
    const out = planDocToMarkdown(doc, { sidecars: true });
    expect(stripSidecars(out).ids.length).toBe(doc.childCount);
  });

  it("clean serialization carries no sidecars", () => {
    const out = planDocToMarkdown(planMarkdownToDoc(RICH_PLAN), {
      sidecars: false,
    });
    expect(out).not.toMatch(/rl:blk-/);
  });

  it("round-trips block content (headings, list, code, table, quote)", () => {
    const md = planDocToMarkdown(planMarkdownToDoc(RICH_PLAN), {
      sidecars: false,
    });
    expect(md).toContain("# Plan Title");
    expect(md).toContain("## Approach");
    expect(md).toContain("- First bullet");
    expect(md).toContain("1. Step one");
    expect(md).toContain("```rust");
    expect(md).toContain("fn main() {}");
    expect(md).toContain("> A quoted line.");
    expect(md).toContain("| Col A | Col B |");
    expect(md).toContain("**bold**");
    expect(md).toContain("~~strike~~");
    expect(md).toContain("[link](https://example.com)");
  });
});
