// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { buildScrapeProgram, parseScrapeResult } from "./scrapeKernel";
import { SCRAPE_SCHEMA_VERSION, type ScrapeSchema } from "./scrapeSchema";

const schema = (overrides: Partial<ScrapeSchema> = {}): ScrapeSchema => ({
  version: SCRAPE_SCHEMA_VERSION,
  name: "Test",
  fields: [{ name: "body", selector: "body", type: "text" }],
  ...overrides,
});

describe("buildScrapeProgram", () => {
  it("embeds the schema as a JSON literal, not concatenated code", () => {
    // A selector full of JS/regex metacharacters must survive intact — it should
    // only ever appear inside the stringified schema, never spliced as source.
    const nasty = `a[href="x"]; alert(1); //$&$1\\`;
    const program = buildScrapeProgram(
      schema({ fields: [{ name: "x", selector: nasty, type: "text" }] }),
    );
    // The escaped form (what JSON.stringify produces) is present...
    expect(program).toContain(JSON.stringify(nasty).slice(1, -1));
    // ...and the program is one self-contained IIFE returning a string.
    expect(program.startsWith("(function(){")).toBe(true);
    expect(program).toContain("JSON.stringify");
  });

  it("is a single expression (no unescaped breakouts from the selector)", () => {
    const program = buildScrapeProgram(
      schema({ fields: [{ name: "x", selector: `"]}`, type: "text" }] }),
    );
    // The whole program must remain syntactically valid JS — Function() parses it.
    expect(() => new Function(`return ${program.replace(/^\(/, "(false&&")}`)).not.toThrow();
  });
});

describe("parseScrapeResult", () => {
  it("passes through a well-formed result", () => {
    const raw = JSON.stringify({
      ok: true,
      version: 1,
      schemaName: "Test",
      url: "https://e.com",
      title: "T",
      data: { body: "hi" },
      warnings: ["w"],
    });
    const r = parseScrapeResult(raw, schema());
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ body: "hi" });
    expect(r.warnings).toEqual(["w"]);
  });

  it("degrades garbage to { ok:false } instead of throwing", () => {
    const r = parseScrapeResult("not json at all", schema());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unparseable");
    expect(r.data).toEqual({});
  });

  it("treats an empty string (WKWebView null result) as a failure", () => {
    const r = parseScrapeResult("", schema());
    expect(r.ok).toBe(false);
  });

  it("flags a result missing the ok flag as malformed", () => {
    const r = parseScrapeResult(JSON.stringify({ data: {} }), schema());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("malformed");
  });
});
