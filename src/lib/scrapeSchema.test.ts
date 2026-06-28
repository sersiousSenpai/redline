// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  migrateSchema,
  SCRAPE_SCHEMA_VERSION,
  validateSchema,
} from "./scrapeSchema";

const valid = {
  version: SCRAPE_SCHEMA_VERSION,
  name: "Article",
  fields: [
    { name: "title", selector: "h1", type: "text" },
    {
      name: "links",
      selector: "",
      type: "list",
      itemSelector: "a[href]",
      itemFields: [{ name: "href", selector: "", type: "attr", attribute: "href" }],
    },
  ],
};

describe("validateSchema", () => {
  it("accepts a well-formed schema and returns a clean copy", () => {
    const s = validateSchema(valid);
    expect(s.name).toBe("Article");
    expect(s.fields).toHaveLength(2);
    expect(s.fields[1].itemFields?.[0].attribute).toBe("href");
  });

  it("rejects a non-object", () => {
    expect(() => validateSchema("nope")).toThrow();
    expect(() => validateSchema(null)).toThrow();
  });

  it("rejects an empty or missing fields array", () => {
    expect(() => validateSchema({ version: 1, name: "x", fields: [] })).toThrow(
      /non-empty/,
    );
    expect(() => validateSchema({ version: 1, name: "x" })).toThrow();
  });

  it("rejects an unknown field type", () => {
    expect(() =>
      validateSchema({
        version: 1,
        name: "x",
        fields: [{ name: "a", selector: "p", type: "bogus" }],
      }),
    ).toThrow(/type/);
  });

  it("rejects a field with no name", () => {
    expect(() =>
      validateSchema({
        version: 1,
        name: "x",
        fields: [{ name: "  ", selector: "p", type: "text" }],
      }),
    ).toThrow(/name/);
  });
});

describe("migrateSchema", () => {
  it("is the identity transform at the current version", () => {
    expect(migrateSchema(valid)).toEqual(validateSchema(valid));
  });

  it("clamps an unknown future version down to the current one", () => {
    const s = migrateSchema({ ...valid, version: SCRAPE_SCHEMA_VERSION + 9 });
    expect(s.version).toBe(SCRAPE_SCHEMA_VERSION);
  });
});

describe("SCRAPE_SCHEMA_VERSION", () => {
  it("is a positive integer (drift guard)", () => {
    expect(Number.isInteger(SCRAPE_SCHEMA_VERSION)).toBe(true);
    expect(SCRAPE_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });
});
