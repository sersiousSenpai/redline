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

// ── The handoff document ────────────────────────────────────────────────────

/** The tab a list was built against, for the provenance line. */
export interface ListSource {
  url?: string | null;
  title?: string | null;
}

/** A numbered entry is one line. A body the user typed with ⇧⏎ newlines still
 *  has to render as a single numbered item, so it folds. */
const oneLine = (body: string) => body.replace(/\s*\n+\s*/g, " ").trim();

/** Render the list as the markdown BOTH handoffs send.
 *
 *  One function on purpose. "Open in Drafter" and "Send to Claude Code" are
 *  two buttons over one list, and if each built its own document they would
 *  eventually disagree about what the list said — the exact failure that makes
 *  a handoff untrustworthy.
 *
 *  Sections follow the template's order; numbering restarts within each
 *  section, so "item 3" in the panel is "item 3" in the document. Done items
 *  are struck rather than dropped: what you decided was already handled is
 *  context the agent needs, not noise. */
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

  const ordered = [...items].sort((a, b) => a.sortIdx - b.sortIdx);
  let wrote = false;
  for (const kind of template.kinds) {
    const inSection = ordered.filter((i) => sectionFor(template, i.kind) === kind);
    if (inSection.length === 0) continue;
    wrote = true;
    // A one-kind template's section heading would just repeat the title.
    if (template.kinds.length > 1) out.push(`## ${KIND_LABEL[kind]}`, "");
    inSection.forEach((item, i) => {
      const body = oneLine(item.body);
      out.push(`${i + 1}. ${item.done ? `~~${body}~~` : body}`);
    });
    out.push("");
  }
  if (!wrote) out.push("_(nothing on the list yet)_", "");

  return out.join("\n").trimEnd() + "\n";
}

/** The quote block `💬` drops into the page-discussion composer. The index is
 *  the one shown in the panel, so the user and the agent are pointing at the
 *  same line. */
export function quoteItem(item: Pick<BrowseListItem, "body">, index: number): string {
  const lines = item.body.trim().split("\n");
  const head = `> Item ${index}: ${lines[0] ?? ""}`.trimEnd();
  const rest = lines.slice(1).map((line) => `> ${line}`.trimEnd());
  // The trailing blank line is what leaves the caret below the quote rather
  // than inside it — the user's question is theirs, not part of the item.
  return [head, ...rest, "", ""].join("\n");
}
