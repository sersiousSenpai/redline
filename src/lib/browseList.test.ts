// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { BrowseListItem } from "../types";
import {
  FALLBACK_TEMPLATE,
  isLocalhostUrl,
  nextKind,
  quoteItem,
  renderListMarkdown,
  sameTabUrl,
  sectionFor,
  templateFor,
  TEMPLATES,
} from "./browseList";

const item = (
  body: string,
  kind: string,
  sortIdx: number,
  done = false,
): BrowseListItem => ({
  id: `i${sortIdx}`,
  browseId: "b1",
  kind,
  body,
  done,
  sortIdx,
  createdAt: 0,
  updatedAt: 0,
});

describe("templateFor", () => {
  it("finds a shipped template by id", () => {
    expect(templateFor("bugs-fixes-improvements").kinds).toEqual([
      "bug",
      "fix",
      "improvement",
    ]);
  });

  it("falls back rather than stranding a row", () => {
    // The rule: a rename or a removal in a later release must not make an
    // existing list unrenderable. The fallback is flat, so nothing hides.
    expect(templateFor("a-template-from-the-future")).toBe(FALLBACK_TEMPLATE);
    expect(templateFor(null)).toBe(FALLBACK_TEMPLATE);
    expect(templateFor(undefined)).toBe(FALLBACK_TEMPLATE);
    expect(FALLBACK_TEMPLATE.kinds).toHaveLength(1);
  });

  it("every template's defaultKind is one it actually shows", () => {
    for (const t of TEMPLATES) expect(t.kinds).toContain(t.defaultKind);
  });
});

describe("sectionFor / nextKind", () => {
  const bfi = templateFor("bugs-fixes-improvements");

  it("keeps an item in its own section", () => {
    expect(sectionFor(bfi, "improvement")).toBe("improvement");
  });

  it("re-homes an item whose kind this template doesn't show", () => {
    // Switching template under a list must not make items disappear.
    expect(sectionFor(bfi, "note")).toBe("bug");
  });

  it("cycles the chip through the template's kinds and wraps", () => {
    expect(nextKind(bfi, "bug")).toBe("fix");
    expect(nextKind(bfi, "improvement")).toBe("bug");
    // A single-kind template cycles to itself rather than throwing.
    expect(nextKind(FALLBACK_TEMPLATE, "note")).toBe("note");
  });
});

describe("isLocalhostUrl", () => {
  it("accepts the dev servers people actually run", () => {
    expect(isLocalhostUrl("http://localhost:5173/x")).toBe(true);
    expect(isLocalhostUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalhostUrl("http://[::1]:8080")).toBe(true);
    expect(isLocalhostUrl("http://0.0.0.0:8000/")).toBe(true);
    expect(isLocalhostUrl("https://app.localhost")).toBe(true);
    // No port at all, and https on loopback.
    expect(isLocalhostUrl("http://localhost")).toBe(true);
    expect(isLocalhostUrl("https://localhost:8443/admin?x=1")).toBe(true);
  });

  it("rejects a public host that merely starts with localhost", () => {
    // The whole reason this parses rather than substring-matches: a false
    // positive auto-offers a punch list on somebody else's website.
    expect(isLocalhostUrl("https://localhost.evil.com")).toBe(false);
    expect(isLocalhostUrl("https://notlocalhost")).toBe(false);
    expect(isLocalhostUrl("https://example.com/localhost")).toBe(false);
  });

  it("rejects a bare address-bar input — this takes RESOLVED urls", () => {
    // omnibox.ts's regex answers "navigate or search" about typed text and
    // would match these. Reusing it here was the trap.
    expect(isLocalhostUrl("localhost")).toBe(false);
    expect(isLocalhostUrl("localhost:5173")).toBe(false);
  });

  it("rejects non-http schemes and nothing at all", () => {
    expect(isLocalhostUrl("file:///Users/me/localhost/index.html")).toBe(false);
    expect(isLocalhostUrl("about:blank")).toBe(false);
    expect(isLocalhostUrl("")).toBe(false);
    expect(isLocalhostUrl(null)).toBe(false);
  });
});

describe("renderListMarkdown", () => {
  const list = { template: "bugs-fixes-improvements", title: null };
  const items = [
    item("nav overlaps the logo", "bug", 0),
    item("empty state has no copy", "improvement", 1),
    item("debounce the search", "fix", 2),
    item("second bug", "bug", 3, true),
  ];

  it("follows the template's section order, not the items' order", () => {
    const md = renderListMarkdown(list, items);
    const order = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(order).toEqual(["Bug", "Fix", "Improvement"]);
  });

  it("restarts numbering within each section", () => {
    // So "item 3" in the panel is "item 3" in the handoff — the panel numbers
    // per section too.
    const md = renderListMarkdown(list, items);
    expect(md).toContain("1. nav overlaps the logo");
    expect(md).toContain("1. debounce the search");
    expect(md).toContain("1. empty state has no copy");
  });

  it("strikes done items rather than dropping them", () => {
    // What was already handled is context the agent needs.
    expect(renderListMarkdown(list, items)).toContain("2. ~~second bug~~");
  });

  it("carries a provenance line naming the tab", () => {
    const md = renderListMarkdown(list, items, {
      url: "http://localhost:5173/settings",
      title: "Settings — MyApp",
    });
    expect(md).toContain("From **Settings — MyApp** — http://localhost:5173/settings");
  });

  it("orders by sortIdx, not by array position", () => {
    const md = renderListMarkdown({ template: "punch-list", title: null }, [
      item("second", "note", 5),
      item("first", "note", 1),
    ]);
    expect(md.indexOf("first")).toBeLessThan(md.indexOf("second"));
  });

  it("drops the section heading for a one-kind template", () => {
    const md = renderListMarkdown({ template: "punch-list", title: "Today" }, [
      item("do the thing", "note", 0),
    ]);
    expect(md).toContain("# Today");
    expect(md).not.toContain("## Note");
    expect(md).toContain("1. do the thing");
  });

  it("folds a multi-line body into one numbered entry", () => {
    const md = renderListMarkdown({ template: "punch-list", title: null }, [
      item("first line\nsecond line", "note", 0),
    ]);
    expect(md).toContain("1. first line second line");
  });

  it("still renders an item whose kind the template stopped showing", () => {
    const md = renderListMarkdown(list, [item("orphan", "note", 0)]);
    expect(md).toContain("orphan");
  });

  it("says so plainly when there is nothing on it", () => {
    expect(renderListMarkdown(list, [])).toContain("nothing on the list yet");
  });

  it("titles from the list, falling back to the template's label", () => {
    expect(renderListMarkdown({ template: "punch-list", title: "  " }, [])).toContain(
      "# Punch list",
    );
  });
});

describe("quoteItem", () => {
  it("quotes the item under the number the panel shows", () => {
    expect(quoteItem({ body: "nav overlaps the logo" }, 3)).toBe(
      "> Item 3: nav overlaps the logo\n\n",
    );
  });

  it("quotes every line, and leaves the caret below the block", () => {
    // A trailing blank line: the user's question is theirs, not part of the
    // item they're asking about.
    expect(quoteItem({ body: "one\ntwo" }, 1)).toBe("> Item 1: one\n> two\n\n");
  });
});

describe("sameTabUrl", () => {
  // The reported bug in three strings: the Localhost card links one URL, the
  // 1s poll rewrites `t.url` to the webview's canonical form, and the app
  // redirects to a path. Three strings, one dev server, and clicking "Open"
  // again must focus the tab you already have rather than stack a fourth.
  it("matches a dev server by port, whatever the path or host spelling", () => {
    expect(sameTabUrl("http://localhost:3000", "http://localhost:3000/")).toBe(true);
    expect(sameTabUrl("http://localhost:3000", "http://localhost:3000/dashboard")).toBe(
      true,
    );
    expect(sameTabUrl("http://127.0.0.1:3000/x", "http://localhost:3000")).toBe(true);
    // The omnibox forces https:// on a typed address; same server.
    expect(sameTabUrl("https://localhost:3000", "http://localhost:3000")).toBe(true);
  });

  it("keeps two dev servers apart, and loopback apart from the world", () => {
    expect(sameTabUrl("http://localhost:3000", "http://localhost:5173")).toBe(false);
    expect(sameTabUrl("http://localhost:3000", "http://example.com:3000")).toBe(false);
  });

  it("is trailing-slash and hash insensitive off loopback", () => {
    expect(sameTabUrl("https://example.com/a/", "https://example.com/a")).toBe(true);
    expect(sameTabUrl("https://example.com/a#top", "https://example.com/a")).toBe(true);
    expect(sameTabUrl("https://example.com:443/a", "https://example.com/a")).toBe(true);
  });

  it("still treats a public site's paths and queries as separate pages", () => {
    // Only loopback collapses paths — a dev server's identity is its port,
    // a website's is its page.
    expect(sameTabUrl("https://example.com/a", "https://example.com/b")).toBe(false);
    expect(sameTabUrl("https://example.com/a?x=1", "https://example.com/a?x=2")).toBe(
      false,
    );
    expect(sameTabUrl("https://example.com/a", "http://example.com/a")).toBe(false);
  });

  it("falls back to strict equality when either side won't parse", () => {
    // Never widen a match we can't reason about.
    expect(sameTabUrl("not a url", "https://example.com")).toBe(false);
    expect(sameTabUrl("not a url", "not a url")).toBe(true);
  });
});
