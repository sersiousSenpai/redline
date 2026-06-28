// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  clipFilename,
  composeClipNote,
  dedupeFilename,
  ymd,
} from "./obsidianClip";

const DATE = new Date(2026, 5, 21, 9, 30); // 2026-06-21 local

describe("composeClipNote", () => {
  it("leads with YAML frontmatter including the url", () => {
    const note = composeClipNote({
      url: "https://example.com/article",
      title: "The Article",
      body: "Body text.",
      savedDate: DATE,
    });
    expect(note.startsWith("---\n")).toBe(true);
    expect(note).toContain('url: "https://example.com/article"');
    expect(note).toContain('title: "The Article"');
    expect(note).toContain("saved: 2026-06-21");
    expect(note).toContain("tags: [clipping]");
    expect(note).toContain("Body text.");
  });

  it("escapes quotes and colons in title/url", () => {
    const note = composeClipNote({
      url: "https://x.com/a?q=1:2",
      title: 'He said "hi": really',
      body: "b",
      savedDate: DATE,
    });
    expect(note).toContain('title: "He said \\"hi\\": really"');
  });

  it("renders a multi-line context note as a blockquote", () => {
    const note = composeClipNote({
      url: "u",
      title: "t",
      body: "body",
      contextNote: "line one\nline two",
      savedDate: DATE,
    });
    expect(note).toContain("> line one\n> line two");
  });

  it("omits the blockquote when the context note is blank", () => {
    const note = composeClipNote({
      url: "u",
      title: "t",
      body: "body",
      contextNote: "   ",
      savedDate: DATE,
    });
    expect(note).not.toContain(">");
  });

  it("honors custom tags", () => {
    const note = composeClipNote({
      url: "u",
      title: "t",
      body: "b",
      tags: ["clipping", "research"],
      savedDate: DATE,
    });
    expect(note).toContain("tags: [clipping, research]");
  });
});

describe("clipFilename", () => {
  it("strips filesystem- and Obsidian-illegal characters", () => {
    expect(clipFilename('a/b:c*?"<>|#^[]', DATE)).toBe("a b c");
  });

  it("collapses whitespace and trims", () => {
    expect(clipFilename("  Hello   World  ", DATE)).toBe("Hello World");
  });

  it("falls back to a dated name when nothing usable remains", () => {
    expect(clipFilename("///", DATE)).toBe("Web Clipping 2026-06-21");
    expect(clipFilename("", DATE)).toBe("Web Clipping 2026-06-21");
  });
});

describe("dedupeFilename", () => {
  it("returns the base when free", () => {
    expect(dedupeFilename("Note", ["Other.md"])).toBe("Note");
  });

  it("appends an incrementing suffix on collision (case-insensitive, .md aware)", () => {
    expect(dedupeFilename("Note", ["note.md"])).toBe("Note 2");
    expect(dedupeFilename("Note", ["Note.md", "Note 2.md"])).toBe("Note 3");
  });
});

describe("ymd", () => {
  it("zero-pads month and day", () => {
    expect(ymd(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
