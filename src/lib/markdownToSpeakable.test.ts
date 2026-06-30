// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  markdownToSpeakable,
  stripInline,
  flattenSections,
} from "./markdownToSpeakable";
import type { Section } from "../types";

describe("stripInline", () => {
  it("removes emphasis, code, and link syntax but keeps the words", () => {
    expect(stripInline("**bold** and `code` and _em_")).toBe(
      "bold and code and em",
    );
    expect(stripInline("see [the docs](https://example.com) now")).toBe(
      "see the docs now",
    );
    expect(stripInline("raw https://example.com/x trailing")).toBe(
      "raw  trailing",
    );
  });
});

describe("markdownToSpeakable", () => {
  it("announces headings as 'Section:' lead-ins", () => {
    const out = markdownToSpeakable("# Overview\n\nFirst paragraph.");
    expect(out).toContain("Section: Overview.");
    expect(out).toContain("First paragraph.");
    // No literal markdown hash is spoken.
    expect(out).not.toContain("#");
  });

  it("strips sidecar markers and HTML comments", () => {
    const md = "<!-- rl:blk-abc12345 -->\n# Title\n<!-- REDLINE_RESOLUTIONS -->\nBody.";
    const out = markdownToSpeakable(md);
    expect(out).not.toContain("rl:blk");
    expect(out).not.toContain("REDLINE");
    expect(out).toContain("Section: Title.");
  });

  it("collapses a fenced code block to a short note, not symbols", () => {
    const md = "Intro.\n\n```rust\nfn main() { let x = &y; }\n```\n\nDone.";
    const out = markdownToSpeakable(md);
    expect(out).toContain("Code block.");
    expect(out).not.toContain("fn main");
    expect(out).not.toContain("&y");
  });

  it("flattens list markers, quotes, and tables", () => {
    const md = "- first item\n- second item\n\n> a quote\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    const out = markdownToSpeakable(md);
    expect(out).toContain("first item");
    expect(out).toContain("second item");
    expect(out).toContain("a quote");
    expect(out).toContain("1, 2.");
    expect(out).not.toContain("|");
    expect(out).not.toContain("-");
  });
});

describe("flattenSections", () => {
  const sec = (
    title: string,
    children: Section[] = [],
    body = "body",
  ): Section => ({
    anchorId: `a-${title}`,
    blockId: `blk-${title}`,
    level: 1,
    title,
    bodyMarkdown: body,
    children,
    paragraphs: [],
  });

  it("visits every node depth-first in document order", () => {
    const tree = [
      sec("A", [sec("A1"), sec("A2", [sec("A2a")])]),
      sec("B"),
    ];
    const titles = flattenSections(tree).map((s) => s.title);
    expect(titles).toEqual(["A", "A1", "A2", "A2a", "B"]);
  });

  it("skips empty synthetic nodes", () => {
    const tree = [sec("", [sec("Real")], "")];
    const titles = flattenSections(tree).map((s) => s.title);
    expect(titles).toEqual(["Real"]);
  });
});
