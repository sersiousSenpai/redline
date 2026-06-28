// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  composeScrapeJson,
  dedupeJsonFilename,
  scrapeFilename,
} from "./scrapeOutput";
import type { ScrapeResult } from "./scrapeSchema";

const DATE = new Date(2026, 5, 21, 9, 30, 5); // 2026-06-21 09:30:05 local

const result: ScrapeResult = {
  ok: true,
  version: 1,
  schemaName: "Article",
  url: "https://example.com/post",
  title: "A Post",
  data: { title: "A Post", body: "Hello" },
  warnings: [],
};

describe("composeScrapeJson", () => {
  it("produces valid, pretty-printed JSON of the full result", () => {
    const out = composeScrapeJson(result);
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.body).toBe("Hello");
    expect(out).toContain("\n  "); // indented
  });
});

describe("scrapeFilename", () => {
  it("combines host, schema slug and a timestamp", () => {
    const name = scrapeFilename("Article", "https://example.com/post", DATE);
    expect(name).toBe("example.com-Article-20260621-093005");
  });

  it("sanitizes illegal characters and falls back when empty", () => {
    const name = scrapeFilename("a/b:c?", "not a url", DATE);
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name.length).toBeGreaterThan(0);
  });
});

describe("dedupeJsonFilename", () => {
  it("returns the base when free", () => {
    expect(dedupeJsonFilename("scrape", [])).toBe("scrape");
  });

  it("appends a counter against existing .json files (case-insensitive)", () => {
    expect(dedupeJsonFilename("scrape", ["scrape.json"])).toBe("scrape 2");
    expect(dedupeJsonFilename("Scrape", ["scrape.json", "scrape 2.json"])).toBe(
      "Scrape 3",
    );
  });
});
