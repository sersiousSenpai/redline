// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { BrowseListItem } from "../types";
import {
  FALLBACK_TEMPLATE,
  groupByPage,
  isLocalhostUrl,
  nextKind,
  pageKeyOf,
  pageLabelOf,
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
  extra: Partial<BrowseListItem> = {},
): BrowseListItem => ({
  id: `i${sortIdx}`,
  browseId: "b1",
  kind,
  body,
  done,
  sortIdx,
  pageUrl: null,
  pageTitle: null,
  locator: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

/** An item written on a page, which after this change is every item. */
const onPage = (
  body: string,
  kind: string,
  sortIdx: number,
  pageUrl: string,
  extra: Partial<BrowseListItem> = {},
): BrowseListItem => item(body, kind, sortIdx, false, { pageUrl, ...extra });

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

describe("pageKeyOf", () => {
  it("treats a trailing slash and a host's case as the same screen", () => {
    expect(pageKeyOf("http://LocalHost:3000/jobs/")).toBe(
      pageKeyOf("http://localhost:3000/jobs"),
    );
  });

  it("keeps the query and the hash — those ARE how apps address a screen", () => {
    // Folding these together would merge two screens the user visited
    // separately and file both sets of notes under one heading.
    expect(pageKeyOf("http://localhost:3000/jobs?tab=applied")).not.toBe(
      pageKeyOf("http://localhost:3000/jobs"),
    );
    expect(pageKeyOf("http://localhost:3000/#/settings")).not.toBe(
      pageKeyOf("http://localhost:3000/#/profile"),
    );
  });

  it("does NOT collapse paths the way tab identity does", () => {
    // `sameTabUrl` says these are one tab, which is right for tabs and exactly
    // wrong here: collapsing paths is the bug this grouping exists to fix.
    const a = "http://localhost:3000/jobs";
    const b = "http://localhost:3000/settings";
    expect(sameTabUrl(a, b)).toBe(true);
    expect(pageKeyOf(a)).not.toBe(pageKeyOf(b));
  });

  it("gives an unparseable or absent URL a key of its own", () => {
    expect(pageKeyOf("")).toBe("");
    expect(pageKeyOf(null)).toBe("");
    expect(pageKeyOf("not a url")).toBe("not a url");
  });
});

describe("pageLabelOf", () => {
  it("labels a dev server by its path — the host is the same on every item", () => {
    expect(pageLabelOf("http://localhost:3000/jobs/42")).toBe("/jobs/42");
    expect(pageLabelOf("http://localhost:3000/")).toBe("/");
  });

  it("keeps the host off-origin, where the host is the news", () => {
    expect(pageLabelOf("https://example.com/pricing")).toBe("example.com/pricing");
  });

  it("adds the page's own title, but not when it just repeats the host", () => {
    expect(pageLabelOf("http://localhost:3000/jobs", "Jobs — PLA")).toBe(
      "Jobs — PLA — /jobs",
    );
    // What the tab poll writes when it has nothing better.
    expect(pageLabelOf("http://localhost:3000/jobs", "localhost:3000")).toBe("/jobs");
  });

  it("says so plainly when there is no page", () => {
    expect(pageLabelOf(null)).toBe("No page recorded");
  });
});

describe("groupByPage", () => {
  const jobs = "http://localhost:3000/jobs";
  const settings = "http://localhost:3000/settings";

  it("opens a section per page, in the order the user walked them", () => {
    const sections = groupByPage([
      onPage("a", "bug", 0, jobs),
      onPage("b", "bug", 1, settings),
    ]);
    expect(sections.map((s) => s.label)).toEqual(["/jobs", "/settings"]);
  });

  it("appends to a page's existing section when the user comes back", () => {
    // The reported behaviour: page one, page two, back to page one — and the
    // third item joins the FIRST section rather than opening a third.
    const sections = groupByPage([
      onPage("a", "bug", 0, jobs),
      onPage("b", "bug", 1, settings),
      onPage("c", "bug", 2, `${jobs}/`),
    ]);
    expect(sections).toHaveLength(2);
    expect(sections[0].items.map((i) => i.body)).toEqual(["a", "c"]);
  });

  it("orders by sortIdx, so a drag still means what it looked like", () => {
    const sections = groupByPage([
      onPage("second", "bug", 5, jobs),
      onPage("first", "bug", 1, jobs),
    ]);
    expect(sections[0].items.map((i) => i.body)).toEqual(["first", "second"]);
  });

  it("still draws items written before Redline recorded a page", () => {
    // An item the panel doesn't draw is an item the user loses.
    const sections = groupByPage([item("legacy", "bug", 0)]);
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe("");
    expect(sections[0].label).toBe("No page recorded");
  });
});

describe("renderListMarkdown", () => {
  const list = { template: "bugs-fixes-improvements", title: null };
  const jobs = "http://localhost:3000/jobs";
  const settings = "http://localhost:3000/settings";
  const items = [
    onPage("nav overlaps the logo", "bug", 0, jobs),
    onPage("empty state has no copy", "improvement", 1, jobs),
    onPage("debounce the search", "fix", 2, settings),
    item("second bug", "bug", 3, true, { pageUrl: settings }),
  ];

  it("sections by PAGE, in the order the user walked them", () => {
    const md = renderListMarkdown(list, items);
    const order = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(order).toEqual(["/jobs", "/settings"]);
    // The full URL rides under the heading: the label is a path, and the agent
    // receiving this has to be able to open the thing.
    expect(md).toContain(jobs);
  });

  it("restarts numbering within each page", () => {
    // So "item 2" in the panel is "item 2" in the handoff — the panel numbers
    // per section too, and a section is now a page.
    const md = renderListMarkdown(list, items);
    expect(md).toContain("1. **bug** · nav overlaps the logo");
    expect(md).toContain("2. **improvement** · empty state has no copy");
    expect(md).toContain("1. **fix** · debounce the search");
  });

  it("marks which words are Redline's and which are the user's", () => {
    // The receiving agent gets a line written by two authors. It has to act on
    // the note and merely navigate by the location.
    const md = renderListMarkdown(list, [
      onPage("line spacing is off", "bug", 0, jobs, { locator: "Search bar" }),
    ]);
    expect(md).toContain("1. **bug** · [Search bar] — line spacing is off");
    expect(md).toContain("resolved by Redline from the page");
    expect(md).toContain("the user's own words");
  });

  it("claims no legend it doesn't honour", () => {
    // A one-kind template with no pointers writes bare notes, and must not
    // announce a format the document doesn't use.
    const md = renderListMarkdown({ template: "punch-list", title: "Today" }, [
      onPage("do the thing", "note", 0, jobs),
    ]);
    expect(md).not.toContain("resolved by Redline");
    expect(md).toContain("1. do the thing");
  });

  it("strikes done items rather than dropping them", () => {
    // What was already handled is context the agent needs.
    expect(renderListMarkdown(list, items)).toContain("2. **bug** · ~~second bug~~");
  });

  it("strikes the pointer along with the note, as one statement", () => {
    const md = renderListMarkdown(list, [
      item("fixed already", "bug", 0, true, { pageUrl: jobs, locator: "Search bar" }),
    ]);
    expect(md).toContain("~~[Search bar] — fixed already~~");
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
      onPage("second", "note", 5, jobs),
      onPage("first", "note", 1, jobs),
    ]);
    expect(md.indexOf("first")).toBeLessThan(md.indexOf("second"));
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
    expect(quoteItem({ body: "nav overlaps the logo", locator: null }, 3)).toBe(
      "> Item 3: nav overlaps the logo\n\n",
    );
  });

  it("quotes every line, and leaves the caret below the block", () => {
    // A trailing blank line: the user's question is theirs, not part of the
    // item they're asking about.
    expect(quoteItem({ body: "one\ntwo", locator: null }, 1)).toBe(
      "> Item 1: one\n> two\n\n",
    );
  });

  it("carries the pointer, so the agent knows what is being asked about", () => {
    // The difference between asking about "line spacing is off" and asking
    // about the search bar.
    expect(
      quoteItem({ body: "line spacing is off", locator: "Search bar" }, 2),
    ).toBe("> Item 2: [Search bar] — line spacing is off\n\n");
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
