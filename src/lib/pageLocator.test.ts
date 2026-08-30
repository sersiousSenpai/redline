// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  fallbackLocator,
  humanizeIdent,
  MAX_LOCATOR_CHARS,
  meaningfulClass,
  normalizeLocator,
  parseLocator,
  parsePageContext,
  parseSelection,
} from "./pageLocator";

// What this file pins is the promise that makes the pointer trustworthy: it is
// resolved from what the page ACTUALLY said, with no model in the loop, and it
// declines to guess rather than inventing a name. A wrong pointer is worse than
// none — it aims the reader at the wrong component.

describe("meaningfulClass", () => {
  it("keeps a BEM name and drops a CSS-modules hash", () => {
    // The distinction the whole filter exists for. A naive "has a double
    // underscore" rule catches `Search_input__x7f2` and throws away
    // `job-card__title` — the single most useful class a page ever offers.
    expect(meaningfulClass("job-card__title")).toBe(true);
    expect(meaningfulClass("Search_input__x7f2")).toBe(false);
  });

  it("drops styled-components and Emotion ids", () => {
    expect(meaningfulClass("sc-bdVaJa")).toBe(false);
    expect(meaningfulClass("css-1a2b3c")).toBe(false);
  });

  it("drops Tailwind utilities — they say how it looks, not what it is", () => {
    for (const c of ["px-4", "text-sm", "bg-red-500", "flex", "md:hidden", "w-full"]) {
      expect(meaningfulClass(c), c).toBe(false);
    }
  });

  it("keeps a component name that merely LOOKS like a utility", () => {
    // Matching utilities by shape rather than by vocabulary throws these away.
    for (const c of ["user-profile", "JobCard", "results-grid", "job-card"]) {
      expect(meaningfulClass(c), c).toBe(true);
    }
    // …and the vocabulary rescue covers the overlap.
    expect(meaningfulClass("list-item")).toBe(true);
    expect(meaningfulClass("text-field")).toBe(true);
  });

  it("keeps a word with a counter on the end", () => {
    expect(meaningfulClass("heading2")).toBe(true);
  });
});

describe("humanizeIdent", () => {
  it("spells an identifier the way its author would say it", () => {
    expect(humanizeIdent("job-card-title")).toBe("job card title");
    expect(humanizeIdent("jobCardTitle")).toBe("job card title");
    expect(humanizeIdent("job_card_title")).toBe("job card title");
    expect(humanizeIdent("JobCardTitle")).toBe("job card title");
    expect(humanizeIdent("PLAJobCard")).toBe("pla job card");
  });
});

describe("fallbackLocator", () => {
  it("prefers a test id — a human chose that name for a human", () => {
    expect(
      fallbackLocator({ tag: "div", testId: "job-card-title", classes: ["px-4"] }),
    ).toBe("Job card title");
  });

  it("names a control by its accessible name plus what it is", () => {
    expect(fallbackLocator({ tag: "input", name: "Search jobs" })).toBe(
      "Search jobs field",
    );
    expect(fallbackLocator({ tag: "button", name: "Apply now" })).toBe(
      "Apply now button",
    );
  });

  it("does not say the noun twice", () => {
    expect(fallbackLocator({ tag: "input", role: "searchbox", name: "Search field" })).toBe(
      "Search field",
    );
    // Nor bolt one onto a name that already ends in a component word:
    // "Job search bar field" reads like a translation.
    expect(fallbackLocator({ tag: "input", testId: "job-search-bar" })).toBe(
      "Job search bar",
    );
    expect(fallbackLocator({ tag: "div", testId: "job-card" })).toBe("Job card");
  });

  it("ignores a name that is just the passage the user highlighted", () => {
    // The note is already about that text; repeating it points at nothing.
    const out = fallbackLocator({
      tag: "p",
      name: "we are hiring",
      text: "We are hiring",
      classes: ["job-blurb"],
    });
    expect(out).toBe("Job blurb");
  });

  it("falls back through id, then class, then region, then the bare noun", () => {
    // "Search panel" already ends in a component word — "section" would just
    // be the markup talking.
    expect(fallbackLocator({ tag: "section", id: "search-panel" })).toBe("Search panel");
    expect(fallbackLocator({ tag: "section", id: "recent-jobs" })).toBe(
      "Recent jobs section",
    );
    expect(fallbackLocator({ tag: "div", classes: ["css-1x2y3z", "job-card"] })).toBe(
      "Job card",
    );
    expect(fallbackLocator({ tag: "button", landmark: "Recent jobs" })).toBe(
      "Button in Recent jobs",
    );
    expect(fallbackLocator({ tag: "a", heading: "Saved searches" })).toBe(
      "Link under Saved searches",
    );
    expect(fallbackLocator({ tag: "button" })).toBe("Button");
  });

  it("declines rather than inventing when the page offered nothing", () => {
    // An unanchored item is fine. A made-up anchor is not.
    expect(fallbackLocator({ tag: "div" })).toBe("");
    expect(fallbackLocator({ tag: "div", classes: ["flex", "px-2"] })).toBe("");
    expect(fallbackLocator(null)).toBe("");
    expect(fallbackLocator(undefined)).toBe("");
  });

  it("skips a generated id the way it skips a generated class", () => {
    expect(fallbackLocator({ tag: "div", id: "radix-r1k9f3", classes: ["job-card"] })).toBe(
      "Job card",
    );
  });

  it("clamps a page that offers a paragraph as a name", () => {
    const out = fallbackLocator({ tag: "div", testId: "x ".repeat(120) });
    expect(out.length).toBeLessThanOrEqual(MAX_LOCATOR_CHARS + 1);
  });
});

describe("parseLocator / parseSelection / parsePageContext", () => {
  // Everything here crossed a JSON boundary out of an arbitrary web page.
  it("drops fields of the wrong type instead of storing them", () => {
    const loc = parseLocator({ tag: 42, name: { evil: true }, classes: "nope", id: "ok" });
    expect(loc).toEqual({
      tag: undefined,
      role: undefined,
      name: undefined,
      id: "ok",
      testId: undefined,
      classes: undefined,
      path: undefined,
      landmark: undefined,
      heading: undefined,
      text: undefined,
      html: undefined,
    });
  });

  it("carries the markup for the naming agent without letting it name anything", () => {
    // `html` is evidence for the background agent, not a candidate phrase: a
    // pointer built out of raw markup would be unreadable.
    const loc = parseLocator({ tag: "div", html: "<div   class='x'>hi</div>" });
    expect(loc?.html).toBe("<div   class='x'>hi</div>"); // markup, not prose
    expect(fallbackLocator(loc)).toBe("");
  });

  it("calls an object of nothing no locator at all", () => {
    expect(parseLocator({ tag: "", name: "   " })).toBeNull();
    expect(parseLocator("a string")).toBeNull();
    expect(parseLocator(null)).toBeNull();
  });

  it("treats a selection with no text as no selection", () => {
    // Which is also how the shim reports "the user cleared it".
    expect(parseSelection({ text: "   ", ts: 5 })).toBeNull();
    expect(parseSelection({ text: "hi", ts: "not a number" })?.ts).toBe(0);
  });

  it("needs a URL to be a page at all", () => {
    expect(parsePageContext({ title: "no url here" })).toBeNull();
    const page = parsePageContext({
      url: "http://localhost:3000/jobs",
      title: "Jobs",
      sel: { text: "Search jobs", ts: 7, locator: { tag: "input" } },
    });
    expect(page?.url).toBe("http://localhost:3000/jobs");
    expect(page?.selection?.locator?.tag).toBe("input");
  });
});

describe("normalizeLocator", () => {
  it("never carries the separator the renderer owns", () => {
    // Baking it in would double it up: `[Search bar —] — line spacing is off`.
    expect(normalizeLocator("Search bar —")).toBe("Search bar");
    expect(normalizeLocator("  Search   bar  ")).toBe("Search bar");
    expect(normalizeLocator(null)).toBe("");
  });
});
