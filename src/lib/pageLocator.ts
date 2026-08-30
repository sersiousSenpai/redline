// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Where on the page a working-list item is about — the "pointer" half of a
// list line.
//
// A list item written during a GUI walkthrough is a sentence about a *thing on
// a screen*: "line spacing is off". Read a week later, or by an agent that
// never saw the screen, it is unactionable — which is what forced the user to
// spend a sentence describing the component before they could describe the
// problem.
//
// The fix has two halves and this module is the deterministic one. The in-page
// selection shim (`selection_shim_js` in src-tauri/src/lib.rs) hands back a
// structured description of the element the user highlighted; `fallbackLocator`
// turns it into a short pointer phrase with no agent in the loop, so an item is
// anchored the instant it is written. The `browse_locator` seat then refines
// that phrase in the background (see src-tauri/src/browse_locate.rs) — a
// *better* name, never the only chance at one.
//
// Everything here is pure: the shim's payload crossed a JSON boundary out of an
// arbitrary web page, so nothing in it is trusted or assumed present.

/** The element description the shim captures around a selection. Every field
 *  is optional: the shim gathers what the DOM happens to offer, and a page that
 *  offers nothing must degrade to "no pointer", never to a crash. */
export interface RawLocator {
  /** Lowercase tag name of the element the selection sits in. */
  tag?: string;
  /** Explicit `role`, or the implicit one the shim maps from the tag. */
  role?: string;
  /** An accessible-ish name: aria-label, labelled text, placeholder, alt,
   *  title, or the element's own short text. */
  name?: string;
  id?: string;
  /** `data-testid` / `data-test` / `data-cy` — the most intentional name a
   *  component ever carries, because a human chose it for a human. */
  testId?: string;
  /** A few meaningful class names (framework hash-classes filtered out). */
  classes?: string[];
  /** A short ancestor chain, e.g. `main > section.jobs > form.search`. */
  path?: string;
  /** The nearest labelled region ancestor — a `<section aria-label>`, a card,
   *  a `<nav>`. */
  landmark?: string;
  /** Text of the closest heading above the selection. */
  heading?: string;
  /** The highlighted passage itself, clamped by the shim. */
  text?: string;
  /** The element's own markup, clamped.
   *
   *  For the background naming agent ONLY — it is the difference between
   *  guessing from a tag name and reading the component. Nothing on the
   *  deterministic path looks at it, so a page that refuses `outerHTML` costs
   *  a better phrase and nothing else. Deliberately not whitespace-collapsed
   *  the way the other fields are: this is markup, not prose. */
  html?: string;
}

/** A selection the shim is still holding — what "the user has something
 *  highlighted right now" means to the panel. */
export interface PageSelection {
  text: string;
  locator: RawLocator | null;
  /** `Date.now()` in the PAGE, at the moment the selection settled. Only ever
   *  compared against other page timestamps (to notice a new selection), never
   *  against the host's clock. */
  ts: number;
}

/** What one capture of the live page yields: where it is, and what — if
 *  anything — the user has highlighted on it. */
export interface PageContext {
  url: string;
  title: string;
  selection: PageSelection | null;
}

/** The longest pointer worth showing. A phrase past this stopped being a
 *  pointer and became a second sentence, which is the user's job. */
export const MAX_LOCATOR_CHARS = 80;

/** Framework-generated class prefixes. A styled-components `sc-bdVaJa` or an
 *  Emotion `css-1a2b3c` names a stylesheet, not a component. */
const GENERATED_PREFIX = /^(sc|css|jsx|ng|svelte|emotion|chakra|mui)-/i;

/** A hash: long enough to be generated, and mixing letters with digits the way
 *  a human name does not. `x7f2` yes; `h2`, `col6`, `title` no.
 *
 *  This distinction is the whole reason class filtering is worth writing: a
 *  CSS-modules class is `Search_input__x7f2` and a BEM class is
 *  `job-card__title`, and the naive "has a double underscore" rule that catches
 *  the first one throws away the second — which is the single most useful class
 *  name a page ever offers. So the test is on the SEGMENT, not the separator. */
function hashySegment(seg: string): boolean {
  if (seg.length < 4) return false;
  if (!/\d/.test(seg) || !/[a-z]/i.test(seg)) return false;
  // `heading2`, `col6`, `h1` — a word with a counter on the end is a name.
  return !/^[a-z]+\d{1,3}$/i.test(seg);
}

/** Tailwind-shaped utilities describe how a thing LOOKS. Matched by their own
 *  prefix vocabulary rather than by shape, because the shape of a utility
 *  (`lowercase-words-with-dashes`) is also the shape of a good component name:
 *  a shape rule throws away `user-profile` to catch `text-sm`. */
const UTILITY_PREFIX =
  /^-?(?:[a-z]+:)*(?:p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|w|h|min|max|text|font|leading|tracking|bg|border|rounded|shadow|flex|grid|gap|space|items|justify|self|order|col|row|inset|top|bottom|left|right|z|opacity|overflow|object|cursor|select|pointer|transition|duration|ease|delay|animate|ring|outline|divide|place|content|whitespace|break|truncate|align|sr|hidden|block|inline|absolute|relative|fixed|sticky|static|antialiased|uppercase|lowercase|capitalize|italic|underline|first|last|odd|even|group|peer|aspect|basis|grow|shrink|filter|blur|backdrop|scale|rotate|translate|skew|origin|resize|scroll|snap|touch|will|decoration|indent|from|via|to|fill|stroke|clear|float|visible|invisible|collapse|isolate|mix)(?:-|$)/;

/** …unless the utility's own words name a component anyway (`list-item`,
 *  `text-field`, `search-bar`). The rescue is why the prefix list can be
 *  aggressive without costing real names. */
const MEANINGFUL_UTILITY =
  /(card|search|job|nav|header|footer|sidebar|modal|dialog|menu|toolbar|panel|list|item|row|cell|form|field|button|badge|avatar|banner|hero|tab|table|chip|tile|widget|input|label|title|heading|link|icon|thumb|filter|sort|page|post|user|profile|comment|result)/i;

/** Was this identifier written by a framework rather than by a person?
 *
 *  The same question for a class (`css-1a2b3c`) and for an id (`radix-r1k9f3`,
 *  React's `:r0:`), so it is asked in one place — an id that survives this
 *  check is about to be shown to the user as the name of a component. */
function generatedIdent(raw: string): boolean {
  if (raw.includes(":")) return true; // React `useId`, e.g. `:r0:`
  if (GENERATED_PREFIX.test(raw)) return true;
  return raw.split(/[-_]+/).filter(Boolean).some(hashySegment);
}

/** Is this class name worth showing a human? */
export function meaningfulClass(cls: string): boolean {
  const c = cls.trim();
  if (c.length < 2 || c.length > 40) return false;
  if (generatedIdent(c)) return false;
  if (UTILITY_PREFIX.test(c) && !MEANINGFUL_UTILITY.test(c)) return false;
  return true;
}

/** The noun a tag/role implies, so a pointer reads as a thing rather than as
 *  markup: `input` → "field", not "input element". Empty means "the tag adds
 *  nothing" — a `div` is not a kind of anything. */
const CONTROL_NOUN: Record<string, string> = {
  input: "field",
  textarea: "field",
  select: "dropdown",
  option: "option",
  button: "button",
  a: "link",
  img: "image",
  svg: "icon",
  video: "video",
  table: "table",
  thead: "table header",
  tbody: "table body",
  tr: "row",
  td: "cell",
  th: "column header",
  ul: "list",
  ol: "list",
  li: "list item",
  nav: "nav",
  form: "form",
  label: "label",
  header: "header",
  footer: "footer",
  aside: "sidebar",
  main: "main area",
  section: "section",
  article: "card",
  dialog: "dialog",
  summary: "disclosure",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
};

const ROLE_NOUN: Record<string, string> = {
  searchbox: "search field",
  textbox: "field",
  combobox: "dropdown",
  listbox: "dropdown",
  button: "button",
  link: "link",
  tab: "tab",
  tabpanel: "panel",
  dialog: "dialog",
  menu: "menu",
  menuitem: "menu item",
  navigation: "nav",
  banner: "header",
  contentinfo: "footer",
  complementary: "sidebar",
  main: "main area",
  region: "section",
  article: "card",
  list: "list",
  listitem: "list item",
  table: "table",
  row: "row",
  cell: "cell",
  grid: "grid",
  gridcell: "cell",
  heading: "heading",
  img: "image",
  alert: "alert",
  status: "status",
  form: "form",
  search: "search",
  toolbar: "toolbar",
  checkbox: "checkbox",
  radio: "radio",
  switch: "toggle",
  slider: "slider",
  progressbar: "progress bar",
};

/** `job-card-title` / `jobCardTitle` / `job_card_title` → `job card title`.
 *  Identifiers are how a component's author named it, and that name is usually
 *  the best one available — it just has to be spelled for a reader. */
export function humanizeIdent(raw: string): string {
  return raw
    .replace(/[_\-.:/]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Collapse whitespace and clamp. A pointer is one line by construction — the
 *  shim can hand back an element whose "name" is three paragraphs of text. */
function tidy(raw: string | undefined | null, max = MAX_LOCATOR_CHARS): string {
  const t = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= max) return t;
  // Cut on a word boundary when there is one near the limit, so a clamped
  // pointer still reads as words rather than as a severed token.
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Sentence case: the pointer sits at the head of a list line, so it reads as
 *  a label. Only the first character is touched, which is what leaves a real
 *  product name or an acronym ("PLA job card") exactly as the page wrote it —
 *  title-casing here would rewrite the page's own words. */
export function sentenceCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** The noun this element is a kind of, if any. */
function nounFor(loc: RawLocator): string {
  const role = (loc.role ?? "").trim().toLowerCase();
  if (role && ROLE_NOUN[role]) return ROLE_NOUN[role];
  const tag = (loc.tag ?? "").trim().toLowerCase();
  return CONTROL_NOUN[tag] ?? "";
}

/** Words that already say "this is a component". A name ending in one is
 *  finished: `job-search-bar` is a search bar, and "Job search bar field" reads
 *  like a translation. */
const NOUN_TAIL =
  /\b(bar|field|input|box|button|btn|link|card|list|item|row|cell|menu|nav|navigation|panel|dropdown|select|picker|toggle|switch|slider|tab|tabs|table|form|header|footer|sidebar|banner|hero|modal|dialog|drawer|popover|tooltip|toolbar|badge|chip|tile|widget|icon|image|img|avatar|label|title|heading|caption|text|grid|container|wrapper|section|area|region|control|checkbox|radio|search|filter|sort|pagination|breadcrumb|stepper|accordion|carousel|calendar|editor|viewer|preview|thumbnail|logo|spinner|loader|alert|toast|notification|counter|meter|progress|chart|graph|map|player|video|audio)$/i;

/** Is `noun` already said by `name`? "Search field" + noun "field" must not
 *  become "Search field field", and neither must "Job search bar" + "field". */
function saysNoun(name: string, noun: string): boolean {
  if (!noun) return true;
  if (new RegExp(`\\b${noun.replace(/\s+/g, "\\s+")}\\b`, "i").test(name)) return true;
  return NOUN_TAIL.test(name.trim());
}

/** Join a name and its noun the way a person would: "Search" + "field" →
 *  "Search field"; "Apply now" + "button" → "Apply now button". */
function withNoun(name: string, noun: string): string {
  const n = tidy(name);
  if (!n) return sentenceCase(noun);
  if (saysNoun(n, noun)) return sentenceCase(n);
  return sentenceCase(tidy(`${n} ${noun}`));
}

/** The deterministic pointer — what the item is anchored to before any agent
 *  has run, and what it keeps if none ever does.
 *
 *  The order is a confidence order, not a preference: `testId` and `name` were
 *  written BY a human FOR a human and say what the component is; a heading or
 *  landmark says which region it is in, which is weaker but still orienting;
 *  a class name is a guess; the bare tag is the last honest thing left. When
 *  nothing qualifies this returns `""` — an unanchored item is fine, a made-up
 *  anchor is not. */
export function fallbackLocator(loc: RawLocator | null | undefined): string {
  if (!loc) return "";
  const noun = nounFor(loc);

  const testId = tidy(loc.testId);
  if (testId) return withNoun(humanizeIdent(testId), noun);

  const name = tidy(loc.name);
  // A "name" that is really the highlighted passage says nothing new — the
  // note the user is writing is already about that text.
  const text = tidy(loc.text, 200);
  if (name && name.length <= 48 && name.toLowerCase() !== text.toLowerCase()) {
    return withNoun(name, noun);
  }

  const id = tidy(loc.id);
  if (id && id.length <= 40 && !generatedIdent(id)) {
    return withNoun(humanizeIdent(id), noun);
  }

  const cls = (loc.classes ?? []).map((c) => tidy(c)).find(meaningfulClass);
  if (cls) return withNoun(humanizeIdent(cls), noun);

  const landmark = tidy(loc.landmark, 40);
  if (landmark) return noun ? sentenceCase(tidy(`${noun} in ${landmark}`)) : sentenceCase(landmark);

  const heading = tidy(loc.heading, 40);
  if (heading) return noun ? sentenceCase(tidy(`${noun} under ${heading}`)) : sentenceCase(heading);

  return noun ? sentenceCase(noun) : "";
}

/** Read the shim's `__redline_page` payload. Same discipline as
 *  `parseSelectionEvents`: this is JSON from an arbitrary web page, so a field
 *  of the wrong type is dropped rather than propagated into the DB. */
export function parsePageContext(raw: unknown): PageContext | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url : "";
  if (!url) return null;
  return {
    url,
    title: typeof o.title === "string" ? o.title.slice(0, 300) : "",
    selection: parseSelection(o.sel),
  };
}

/** One selection, or `null`. A selection with no text is not a selection —
 *  which is also how the shim reports "the user cleared it". */
export function parseSelection(raw: unknown): PageSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (!text) return null;
  return {
    text,
    locator: parseLocator(o.locator),
    ts: typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : 0,
  };
}

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
};

export function parseLocator(raw: unknown): RawLocator | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const classes = Array.isArray(o.classes)
    ? o.classes.filter((c): c is string => typeof c === "string").slice(0, 6)
    : undefined;
  const html =
    typeof o.html === "string" && o.html.trim() ? o.html.slice(0, 1500) : undefined;
  const loc: RawLocator = {
    tag: str(o.tag, 24)?.toLowerCase(),
    role: str(o.role, 32)?.toLowerCase(),
    name: str(o.name, 160),
    id: str(o.id, 80),
    testId: str(o.testId, 80),
    classes,
    path: str(o.path, 400),
    landmark: str(o.landmark, 120),
    heading: str(o.heading, 160),
    text: str(o.text, 400),
    html,
  };
  // An object of nothing but `undefined` is not a locator.
  return Object.values(loc).some((v) => (Array.isArray(v) ? v.length > 0 : !!v))
    ? loc
    : null;
}

/** The pointer as the DB stores it: clamped, whitespace-collapsed, and never
 *  carrying the `—` that joins it to the note (that separator belongs to the
 *  renderer, and baking it in would double up). */
export function normalizeLocator(raw: string | null | undefined): string {
  return tidy(String(raw ?? "").replace(/\s*[—–-]\s*$/, ""));
}
