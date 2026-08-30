// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// A browser tab's working list, as a pure module.
//
// The per-tab chat was built as a conversation about a *page*. But the
// strongest real use is a user watching their own dev server on `localhost`,
// and there the thing they want isn't only a conversation — it's a running list
// of what needs to change, built up while they click around, then handed to
// Claude Code in one piece. Everything here is the part of that with no I/O:
// which sections a template shows, whether a URL is their own dev server, and
// what the handed-off document says.

import type { BrowseList, BrowseListItem } from "../types";
import { normalizeLocator } from "./pageLocator";

// ── Templates ───────────────────────────────────────────────────────────────

export type ItemKind = "bug" | "fix" | "improvement" | "note";

/** Templates are DATA, not schema. Adding one is an entry in `TEMPLATES` and
 *  nothing else: the Rust side stores `template` as an opaque string and the
 *  two tables never learn what a "bug" is. */
export interface ListTemplate {
  /** Persisted in `browse_lists.template`. */
  id: string;
  label: string;
  blurb: string;
  /** Which sections the list renders, in this order, and which chips an item
   *  can cycle through. */
  kinds: ItemKind[];
  defaultKind: ItemKind;
}

export const TEMPLATES: ListTemplate[] = [
  {
    id: "bugs-fixes-improvements",
    label: "Bugs / Fixes / Improvements",
    blurb: "Triage what you see while clicking around your own dev server.",
    kinds: ["bug", "fix", "improvement"],
    defaultKind: "bug",
  },
  {
    id: "punch-list",
    label: "Punch list",
    blurb: "One flat list. Everything is just a thing to do.",
    kinds: ["note"],
    defaultKind: "note",
  },
  {
    id: "design-feedback",
    label: "Design feedback",
    blurb: "Notes and suggested improvements on how it looks and feels.",
    kinds: ["note", "improvement"],
    defaultKind: "note",
  },
];

/** The fallback is load-bearing, not defensive noise: a row persisted under a
 *  template id that a later release renames or drops must still render its
 *  items. `punch-list` shows everything as one flat section, so no item can be
 *  hidden by a template it no longer matches. */
export const FALLBACK_TEMPLATE = TEMPLATES[1];

export function templateFor(id: string | null | undefined): ListTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? FALLBACK_TEMPLATE;
}

export const KIND_LABEL: Record<ItemKind, string> = {
  bug: "Bug",
  fix: "Fix",
  improvement: "Improvement",
  note: "Note",
};

/** The section an item belongs to. An item whose `kind` isn't in this template
 *  (because the template was switched under it) still has to appear somewhere —
 *  it lands in the first section rather than vanishing. */
export function sectionFor(template: ListTemplate, kind: string): ItemKind {
  return (template.kinds as string[]).includes(kind)
    ? (kind as ItemKind)
    : template.kinds[0];
}

/** The kind chip cycles through this template's kinds. A single-kind template
 *  makes the chip a label, which is why the caller checks `kinds.length`. */
export function nextKind(template: ListTemplate, kind: string): ItemKind {
  const i = template.kinds.indexOf(sectionFor(template, kind));
  return template.kinds[(i + 1) % template.kinds.length];
}

// ── Is this the user's own dev server? ──────────────────────────────────────

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/** Is this URL a local dev server?
 *
 *  Deliberately NOT `omnibox.ts`'s localhost regex: that one parses a bare
 *  address-bar *input* to decide "navigate or search", so it happily matches
 *  the string `localhost` typed into any field. This takes a RESOLVED URL and
 *  answers a different question — one whose false positive would auto-offer a
 *  punch list on somebody else's website.
 *
 *  Any port; `http`/`https` only (a `file://` page under a path containing
 *  "localhost" is not a dev server); and `*.localhost` because frameworks route
 *  subdomains there. `localhost.evil.com` is a normal public host and must not
 *  match — which is why this compares the parsed hostname rather than
 *  substring-matching the URL. */
export function isLocalhostUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  return host.endsWith(".localhost");
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/** The port a URL actually talks to, with the scheme's default filled in. */
function effectivePort(u: URL): string {
  return u.port || DEFAULT_PORTS[u.protocol] || "";
}

/** Do these two URLs mean "the same tab"?
 *
 *  Strict string equality was the old rule and it never held, because `t.url`
 *  does not stay equal to the URL a tab was opened with: a 1s poll overwrites
 *  it with whatever the webview settled on. For a dev server the identity is
 *  the PORT, not the URL — the Localhost card links `http://localhost:3000`,
 *  the app redirects to `/dashboard`, and the poll rewrites the tab to
 *  `http://localhost:3000/dashboard`. Three strings, one server, and the third
 *  click should focus the tab you already have open rather than stack a fourth.
 *
 *  So: loopback matches on the effective port across every loopback host and
 *  either scheme (`127.0.0.1:3000` IS `http://localhost:3000/`). Everything
 *  else matches on a normalized origin + path + query — trailing-slash and
 *  hash insensitive, since neither reaches the server. Anything unparseable on
 *  either side falls back to exact equality: never widen a match we can't
 *  reason about.
 *
 *  The deliberate consequence: two tabs on different PATHS of the same
 *  localhost port collapse to one. That is what "the localhost tab" means for
 *  a dev server, and it is the reported behaviour. */
export function sameTabUrl(a: string, b: string): boolean {
  if (a === b) return true;
  let ua: URL;
  let ub: URL;
  try {
    ua = new URL(a);
    ub = new URL(b);
  } catch {
    return false;
  }
  const hostA = ua.hostname.toLowerCase();
  const hostB = ub.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(hostA) || LOOPBACK_HOSTS.has(hostB)) {
    // One side loopback and the other not is two different machines.
    if (!LOOPBACK_HOSTS.has(hostA) || !LOOPBACK_HOSTS.has(hostB)) return false;
    return effectivePort(ua) === effectivePort(ub);
  }
  if (ua.protocol !== ub.protocol) return false;
  if (hostA !== hostB) return false;
  if (effectivePort(ua) !== effectivePort(ub)) return false;
  const path = (u: URL) => u.pathname.replace(/\/+$/, "");
  return path(ua) === path(ub) && ua.search === ub.search;
}

// ── Pages ───────────────────────────────────────────────────────────────────

/** The identity of a *page* for grouping purposes.
 *
 *  A list built during a GUI walkthrough is written across many screens, and
 *  the question each item silently answers is "where was I when I saw this".
 *  So items group by the page they were written on, not by the one URL the list
 *  happened to be started from.
 *
 *  Normalization is deliberately narrow. Host is lowercased and a trailing
 *  slash dropped, because `/jobs` and `/jobs/` are one screen. The query string
 *  and the hash are KEPT: `?tab=applied` and `#/settings` are how real apps
 *  address a screen, and folding them together would merge two pages the user
 *  visited separately and file their notes under one heading.
 *
 *  Explicitly NOT `sameTabUrl`: that one answers "is this the same dev server"
 *  and collapses every path on a localhost port into one tab, which is right
 *  for tab identity and exactly wrong here — collapsing paths is the bug this
 *  grouping exists to fix. An unparseable URL is its own key rather than being
 *  merged into "no page". */
export function pageKeyOf(url: string | null | undefined): string {
  const raw = (url ?? "").trim();
  if (!raw) return "";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}${u.hash}`;
}

/** The heading a page section shows.
 *
 *  The path is the label, not the host: during a walkthrough every item is on
 *  the same origin and repeating `localhost:3000` on every heading is pure
 *  noise, while `/jobs/42` is the thing the user is actually looking at. An
 *  off-origin page keeps its host, because there the host IS the news. The
 *  page's own `<title>` rides along when it adds something the path doesn't. */
export function pageLabelOf(
  url: string | null | undefined,
  title?: string | null,
): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  const raw = (url ?? "").trim();
  if (!raw) return t || "No page recorded";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return t || raw;
  }
  const path = `${u.pathname.replace(/\/+$/, "") || "/"}${u.search}${u.hash}`;
  const where = isLocalhostUrl(raw) ? path : `${u.host}${path === "/" ? "" : path}`;
  if (!t) return where;
  // A title that just repeats the host (what the tab poll writes when it has
  // nothing better) adds nothing to a label that already names the path.
  if (t.toLowerCase() === u.host.toLowerCase()) return where;
  return `${t} — ${where}`;
}

/** One page's worth of a list. */
export interface PageSection {
  /** `pageKeyOf` of the items in it. `""` is the legacy/uncaptured group. */
  key: string;
  label: string;
  /** The full URL, for the heading's tooltip and the handoff document. */
  url: string | null;
  items: BrowseListItem[];
}

/** Group a list into page sections, in the user's own order.
 *
 *  Sections are ordered by where their FIRST item sits in the list, so the
 *  sections appear in the order the user walked the app — and coming back to a
 *  page they already have a section for appends to that section rather than
 *  opening a second one further down. Within a section the items keep
 *  `sortIdx`, so a drag still means what it looked like.
 *
 *  Items with no captured page (written before this existed, or captured on a
 *  page whose URL we could not read) collect under one "No page recorded"
 *  section rather than being hidden — an item the panel does not draw is an
 *  item the user loses. */
export function groupByPage(items: BrowseListItem[]): PageSection[] {
  const ordered = [...items].sort((a, b) => a.sortIdx - b.sortIdx);
  const byKey = new Map<string, PageSection>();
  for (const item of ordered) {
    const key = pageKeyOf(item.pageUrl);
    let section = byKey.get(key);
    if (!section) {
      section = {
        key,
        label: pageLabelOf(item.pageUrl, item.pageTitle),
        url: item.pageUrl ?? null,
        items: [],
      };
      byKey.set(key, section);
    }
    section.items.push(item);
  }
  return [...byKey.values()];
}

// ── The handoff document ────────────────────────────────────────────────────

/** The tab a list was built against, for the provenance line. */
export interface ListSource {
  url?: string | null;
  title?: string | null;
}

/** A numbered entry is one line. A body the user typed with ⇧⏎ newlines still
 *  has to render as a single numbered item, so it folds. */
const oneLine = (body: string) => body.replace(/\s*\n+\s*/g, " ").trim();

/** One item as the handoff writes it: `**kind** · [location] — note`.
 *
 *  The bracketing is not decoration. The receiving agent gets a line that mixes
 *  two authors — a pointer Redline resolved from the DOM and a sentence the
 *  user typed — and it has to know which is which: it should act on the note
 *  and merely *navigate* by the location. The legend in `renderListMarkdown`
 *  states that contract once, and this shape is what it describes.
 *
 *  Every piece is optional and drops out cleanly: a single-kind template writes
 *  no kind, an item written without a highlight writes no bracket, and an item
 *  with neither is just the user's sentence. */
export function formatItemLine(
  item: Pick<BrowseListItem, "body" | "kind" | "done" | "locator">,
  template: ListTemplate,
): string {
  const parts: string[] = [];
  if (template.kinds.length > 1) {
    parts.push(`**${KIND_LABEL[sectionFor(template, item.kind)].toLowerCase()}**`);
  }
  const locator = normalizeLocator(item.locator);
  const body = oneLine(item.body);
  const said = locator ? `[${locator}] — ${body}` : body;
  parts.push(item.done ? `~~${said}~~` : said);
  return parts.join(" · ");
}

/** Render the list as the markdown BOTH handoffs send.
 *
 *  One function on purpose. "Open in Drafter" and "Send to Claude Code" are
 *  two buttons over one list, and if each built its own document they would
 *  eventually disagree about what the list said — the exact failure that makes
 *  a handoff untrustworthy.
 *
 *  Sections are PAGES, in the order the user walked them, each headed by its
 *  own URL: the receiving agent's first question about "line spacing is off" is
 *  which screen, and a single provenance line at the top of the document
 *  answered that only for a list that never left one page. Numbering restarts
 *  within each page, so "item 3" in the panel is "item 3" in the document.
 *
 *  Done items are struck rather than dropped: what you decided was already
 *  handled is context the agent needs, not noise. */
export function renderListMarkdown(
  list: Pick<BrowseList, "template" | "title">,
  items: BrowseListItem[],
  source?: ListSource,
): string {
  const template = templateFor(list.template);
  const heading = list.title?.trim() || template.label;
  const out: string[] = [`# ${heading}`, ""];

  const provenance = [
    source?.title?.trim() ? `**${source.title.trim()}**` : null,
    source?.url?.trim() || null,
  ].filter(Boolean);
  if (provenance.length) {
    out.push(`From ${provenance.join(" — ")}`, "");
  }

  const sections = groupByPage(items);
  // State the format once, so the agent reading this can tell Redline's words
  // from the user's. Only claimed when the document actually contains one.
  const legendParts = [
    template.kinds.length > 1 ? "`**kind**`" : null,
    sections.some((s) => s.items.some((i) => normalizeLocator(i.locator)))
      ? "`[location]`"
      : null,
  ].filter(Boolean) as string[];
  if (legendParts.length) {
    out.push(
      `Each item reads ${legendParts.join(" · ")} · the note. ` +
        `${legendParts.join(" and ")} ${legendParts.length > 1 ? "were" : "was"} ` +
        "resolved by Redline from the page; everything after them is the user's " +
        "own words.",
      "",
    );
  }

  let wrote = false;
  for (const section of sections) {
    wrote = true;
    out.push(`## ${section.label}`, "");
    if (section.url && section.url.trim() !== section.label) {
      out.push(section.url.trim(), "");
    }
    section.items.forEach((item, i) => {
      out.push(`${i + 1}. ${formatItemLine(item, template)}`);
    });
    out.push("");
  }
  if (!wrote) out.push("_(nothing on the list yet)_", "");

  return out.join("\n").trimEnd() + "\n";
}

/** The quote block `💬` drops into the page-discussion composer. The index is
 *  the one shown in the panel, so the user and the agent are pointing at the
 *  same line. The location pointer rides along — it is the difference between
 *  asking about "line spacing is off" and asking about the search bar. */
export function quoteItem(
  item: Pick<BrowseListItem, "body" | "locator">,
  index: number,
): string {
  const locator = normalizeLocator(item.locator);
  const lines = item.body.trim().split("\n");
  const head = `> Item ${index}: ${locator ? `[${locator}] — ` : ""}${lines[0] ?? ""}`.trimEnd();
  const rest = lines.slice(1).map((line) => `> ${line}`.trimEnd());
  // The trailing blank line is what leaves the caret below the quote rather
  // than inside it — the user's question is theirs, not part of the item.
  return [head, ...rest, "", ""].join("\n");
}
