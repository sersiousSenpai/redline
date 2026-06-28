// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Built-in scrape schemas. These are ordinary `ScrapeSchema` values — the same
//! shape a hand-edit or a future fork would produce — chosen to exercise every
//! field type and prove the kernel is schema-agnostic. They double as a starting
//! point the user edits in the panel's JSON editor.

import { SCRAPE_SCHEMA_VERSION, type ScrapeSchema } from "./scrapeSchema";

// Big captures (full-page / article body) are capped so a runaway page can't
// wedge the WKWebView → IPC bridge; the kernel flags any truncation as a warning.
const BODY_CAP = 500_000;

export const BUILTIN_SCHEMAS: ScrapeSchema[] = [
  {
    version: SCRAPE_SCHEMA_VERSION,
    name: "Full page text",
    fields: [{ name: "body", selector: "body", type: "text", maxChars: BODY_CAP }],
  },
  {
    version: SCRAPE_SCHEMA_VERSION,
    name: "Article",
    fields: [
      { name: "title", selector: "h1", type: "text" },
      { name: "byline", selector: "[rel=author], .byline, [class*=author]", type: "text" },
      { name: "body", selector: "article, main", type: "text", maxChars: BODY_CAP },
    ],
  },
  {
    version: SCRAPE_SCHEMA_VERSION,
    name: "All links",
    fields: [
      {
        name: "links",
        selector: "",
        type: "list",
        itemSelector: "a[href]",
        itemFields: [
          { name: "text", selector: "", type: "text" },
          { name: "href", selector: "", type: "attr", attribute: "href" },
        ],
      },
    ],
  },
  {
    version: SCRAPE_SCHEMA_VERSION,
    name: "Page metadata",
    fields: [
      { name: "description", selector: "meta[name=description]", type: "attr", attribute: "content" },
      { name: "ogTitle", selector: "meta[property='og:title']", type: "attr", attribute: "content" },
      { name: "ogImage", selector: "meta[property='og:image']", type: "attr", attribute: "content" },
      { name: "canonical", selector: "link[rel=canonical]", type: "attr", attribute: "href" },
    ],
  },
];
