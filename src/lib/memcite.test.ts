// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { extractCitations, MAX_CLASS_CHIPS, MAX_SEQ_CHIPS } from "./memcite";

describe("extractCitations", () => {
  it("pulls seq citations inline and parenthesized, deduped in order", () => {
    const c = extractCitations(
      "You approved the removal (#1042), after debating it in #987 and again (#1042).",
    );
    expect(c.seqs).toEqual([1042, 987]);
    expect(c.classes).toEqual([]);
  });

  it("pulls class citations in double brackets, deduped case-insensitively", () => {
    const c = extractCitations(
      "Filed under [[Loop Engineering]] — see also [[loop engineering]] and [[Auth]].",
    );
    expect(c.classes).toEqual(["Loop Engineering", "Auth"]);
  });

  it("never treats markdown headings or identifiers as seqs", () => {
    const c = extractCitations("# Heading\n\n## 2 things\nsee item x#3 and file#4");
    expect(c.seqs).toEqual([]);
  });

  it("ignores citations inside fenced blocks and inline code", () => {
    const c = extractCitations(
      "Real cite #12.\n```\ncurl #99 [[Fake]]\n```\nAnd `#77` in code, but [[Real]] here.",
    );
    expect(c.seqs).toEqual([12]);
    expect(c.classes).toEqual(["Real"]);
  });

  it("survives an unterminated fence (a truncated reply)", () => {
    const c = extractCitations("Cite #5 then\n```bash\ncurl #99\nnever closed");
    expect(c.seqs).toEqual([5]);
  });

  it("caps the chip rows", () => {
    const seqBody = Array.from({ length: 40 }, (_, i) => `(#${i + 1})`).join(" ");
    expect(extractCitations(seqBody).seqs).toHaveLength(MAX_SEQ_CHIPS);
    const classBody = Array.from({ length: 10 }, (_, i) => `[[C${i}]]`).join(" ");
    expect(extractCitations(classBody).classes).toHaveLength(MAX_CLASS_CHIPS);
  });

  it("returns empty for a reply with no citations", () => {
    expect(extractCitations("The record doesn't answer this.")).toEqual({
      seqs: [],
      classes: [],
    });
  });
});
