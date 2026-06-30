// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import { parseSnapshot, snapshotSummary, type PageSnapshot } from "./domSnapshot";

describe("parseSnapshot", () => {
  it("parses a well-formed snapshot and fills missing arrays", () => {
    const raw = JSON.stringify({
      url: "https://example.com",
      title: "Example",
      selection: "",
      text: "hello",
    });
    const snap = parseSnapshot(raw);
    expect(snap).not.toBeNull();
    expect(snap?.url).toBe("https://example.com");
    expect(snap?.title).toBe("Example");
    expect(snap?.headings).toEqual([]);
    expect(snap?.links).toEqual([]);
  });

  it("returns null for garbage / non-JSON", () => {
    expect(parseSnapshot("")).toBeNull();
    expect(parseSnapshot("not json")).toBeNull();
  });

  it("returns null when the url field is missing", () => {
    expect(parseSnapshot(JSON.stringify({ title: "no url" }))).toBeNull();
  });
});

describe("snapshotSummary", () => {
  const base: PageSnapshot = {
    url: "https://example.com",
    title: "Example Domain",
    selection: "",
    text: "",
    headings: [],
    links: [],
  };

  it("summarizes title with heading/link counts", () => {
    const snap: PageSnapshot = {
      ...base,
      headings: [{ tag: "h1", text: "A" }],
      links: [
        { text: "x", href: "https://a" },
        { text: "y", href: "https://b" },
      ],
    };
    expect(snapshotSummary(snap)).toBe("Example Domain — 1 heading, 2 links");
  });

  it("falls back to the URL when there is no title", () => {
    expect(snapshotSummary({ ...base, title: "" })).toBe("https://example.com");
  });

  it("returns just the title when there is nothing to count", () => {
    expect(snapshotSummary(base)).toBe("Example Domain");
  });
});
