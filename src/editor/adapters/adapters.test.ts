// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { planMarkdownToDoc, planDocToMarkdown, stripSidecars } from "../markdown";
import { getAdapter, listAdapters, markdownAdapter } from "./index";
import { docxAdapter } from "./docx/exporter";
import { bookmarkName } from "./docx/nodeToDocx";

/** One plan exercising every M1-mapped node and mark type. */
const RICH_PLAN = [
  "<!-- rl:blk-aaaa1111 -->",
  "# Plan Title",
  "",
  "<!-- rl:blk-bbbb2222 -->",
  "Intro with **bold**, *italic*, `code`, ~~strike~~ and a",
  "[link](https://example.com).",
  "",
  "<!-- rl:blk-cccc3333 -->",
  "- First bullet",
  "- Second bullet",
  "  - Nested bullet",
  "",
  "<!-- rl:blk-dddd4444 -->",
  "1. Step one",
  "2. Step two",
  "",
  "<!-- rl:blk-eeee5555 -->",
  "```rust",
  "fn main() {}",
  "```",
  "",
  "<!-- rl:blk-ffff6666 -->",
  "> A quoted line.",
  "",
  "<!-- rl:blk-aaaa7777 -->",
  "| Col A | Col B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "<!-- rl:blk-bbbb8888 -->",
  "---",
  "",
  "<!-- rl:blk-cccc9999 -->",
  "```mermaid",
  "graph TD",
  "A-->B",
  "```",
  "",
  "<!-- rl:blk-dddd0000 -->",
  "Line one\\",
  "Line two",
  "",
].join("\n");

async function exportDocxXml(markdown: string) {
  const doc = planMarkdownToDoc(markdown);
  const bytes = (await docxAdapter.export({
    doc,
    anchors: new Map(),
    comments: [],
  })) as Uint8Array;
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zip.file("word/document.xml")!.async("string");
  const relsXml = await zip
    .file("word/_rels/document.xml.rels")!
    .async("string");
  return { bytes, documentXml, relsXml, zip };
}

describe("adapter registry (Phase 0)", () => {
  it("exposes the markdown and docx adapters", () => {
    expect(getAdapter("markdown")).toBe(markdownAdapter);
    expect(getAdapter("docx")).toBe(docxAdapter);
    const ids = listAdapters().map((a) => a.id);
    expect(ids).toContain("markdown");
    expect(ids).toContain("docx");
  });

  it("markdown adapter reproduces the canonical serializer output", async () => {
    const doc = planMarkdownToDoc(RICH_PLAN);
    const out = await markdownAdapter.export({
      doc,
      anchors: new Map(),
      comments: [],
    });
    expect(out).toBe(planDocToMarkdown(doc, { sidecars: false }));
    // Fixed point with the parser, sidecars stripped (same invariant the
    // round-trip suite gates — proven here through the registry seam).
    expect(planMarkdownToDoc(out as string).textContent).toBe(
      planMarkdownToDoc(stripSidecars(RICH_PLAN).clean).textContent,
    );
  });
});

describe("docx adapter (M1)", () => {
  it("produces a valid zip with OOXML content types", async () => {
    const { zip } = await exportDocxXml(RICH_PLAN);
    expect(zip.file("[Content_Types].xml")).toBeTruthy();
    expect(zip.file("word/document.xml")).toBeTruthy();
  });

  it("maps headings to Word heading styles", async () => {
    const { documentXml } = await exportDocxXml(RICH_PLAN);
    expect(documentXml).toContain('w:val="Heading1"');
    expect(documentXml).toContain("Plan Title");
  });

  it("maps inline marks to run properties", async () => {
    const { documentXml } = await exportDocxXml(RICH_PLAN);
    expect(documentXml).toContain("<w:b/>"); // bold
    expect(documentXml).toContain("<w:i/>"); // italic
    expect(documentXml).toContain("<w:strike/>"); // strike
    expect(documentXml).toContain("Courier New"); // inline code font
  });

  it("maps links to ExternalHyperlink with a relationship", async () => {
    const { documentXml, relsXml } = await exportDocxXml(RICH_PLAN);
    expect(documentXml).toContain("<w:hyperlink");
    expect(relsXml).toContain("https://example.com");
  });

  it("maps bullet, nested, and ordered lists to numbering", async () => {
    const { documentXml } = await exportDocxXml(RICH_PLAN);
    expect(documentXml).toContain("<w:numPr>");
    expect(documentXml).toContain("First bullet");
    expect(documentXml).toContain("Nested bullet");
    expect(documentXml).toContain('<w:ilvl w:val="1"/>'); // nested level
    expect(documentXml).toContain("Step one");
  });

  it("maps tables to w:tbl with header and body cells", async () => {
    const { documentXml } = await exportDocxXml(RICH_PLAN);
    expect(documentXml).toContain("<w:tbl>");
    for (const cell of ["Col A", "Col B", "1", "2"]) {
      expect(documentXml).toContain(cell);
    }
  });

  it("renders code blocks as shaded monospace and degrades mermaid to text", async () => {
    const { documentXml } = await exportDocxXml(RICH_PLAN);
    expect(documentXml).toContain("fn main() {}");
    expect(documentXml).toContain('w:fill="F2F2F2"');
    // Mermaid: the v1 decision — fenced source text, no embedded image.
    expect(documentXml).toContain("graph TD");
    expect(documentXml).not.toContain("<w:drawing>");
  });

  it("maps blockquote, horizontal rule, and hard break", async () => {
    const { documentXml } = await exportDocxXml(RICH_PLAN);
    expect(documentXml).toContain("A quoted line.");
    expect(documentXml).toContain("<w:pBdr>"); // HR bottom border / quote bar
    expect(documentXml).toContain("<w:br/>"); // hard break
    expect(documentXml).toContain("Line two");
  });

  it("stamps blockIds as Word bookmarks", async () => {
    const { documentXml } = await exportDocxXml(RICH_PLAN);
    expect(bookmarkName("blk-aaaa1111")).toBe("rl_blk_aaaa1111");
    expect(documentXml).toContain('w:name="rl_blk_aaaa1111"');
  });

  it("exports tracked changes in their accepted form", async () => {
    const doc = planMarkdownToDoc("Base paragraph.\n");
    const schema = doc.type.schema;
    const para = schema.nodes.paragraph.create(null, [
      schema.text("Keep "),
      schema.text("gone", [schema.marks.rl_del.create()]),
      schema.text("added", [schema.marks.rl_ins.create()]),
    ]);
    const tracked = schema.nodes.doc.create(null, [para]);
    const bytes = (await docxAdapter.export({
      doc: tracked,
      anchors: new Map(),
      comments: [],
    })) as Uint8Array;
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Keep ");
    expect(xml).toContain("added");
    expect(xml).not.toContain("gone");
    // Accepted form means no native Word revision marks in v1.
    expect(xml).not.toContain("<w:ins ");
    expect(xml).not.toContain("<w:del ");
  });
});
