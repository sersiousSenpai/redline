#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Headless walk of the workbench: the REAL App (src/main.tsx → App.tsx)
//! booted in headless Chrome against the fake backend in
//! fixtures/app-qa/services.ts, driven through the walk's scenes with real
//! clicks and keys, and captured.
//!
//!   node scripts/app-visual-qa.mjs [--scene home,door-tab,plan,agent,agent-cli,browser,sidebar]
//!       [--theme aurora,basic,studio] [--size 1440x900,1100x720,900x640]
//!       [--out docs/app-qa] [--probes fixtures/app-qa/probes.json]
//!       [--keep-going] [--motion on] [--clock live]
//!
//! Scenes (DRIVES below), each booted fresh from the `workbench` seed:
//!   home      boot: Home's door tab, the Front Door island landed on its plate
//!   door-tab  ⌘T (the native menu's `menu-new-tab`): a second door tab
//!   plan      a plan session picked in the sidebar: its [Plan][Agent] set
//!   agent     the Agent tab: the session's conversation, Chat | CLI header
//!   agent-cli the Agent tab showing its PTY (the CLI radio)
//!   browser   the door's "Open in the browser" destination with an address
//!   sidebar   Places + a project group: at 1440×900 (the whole sidebar) and
//!             at 900×640 (the narrow pose) unless --size is given
//!
//! Per scene × theme × size it writes `<scene>.png` — `-<theme>` appended
//! for a theme other than aurora, `-<w>x<h>` when more than one size runs
//! for that scene. One `report.json` holds, per run: which drive steps ran,
//! the probes from probes.json measured against the workbench spec, the
//! copy check, a WCAG contrast sweep over the whole page, console errors,
//! and every command App invoked that the fake backend has no handler for.
//! There are no reference boards for the workbench: nothing is composited.

import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = "fixtures/app-qa";
const service = path.join(root, fixture, "services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Flags ──────────────────────────────────────────────────────────────────
function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const list = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean);
const ALL_SCENES = ["home", "door-tab", "plan", "agent", "agent-cli", "browser", "sidebar", "rail-plan-discussion", "rail-plan-talk", "rail-plan-files", "rail-plan-changes", "rail-browser-talk", "rail-browser-files", "rail-browser-changes", "rail-folded", "quick-open", "file-pane"];
const SCENES = list(flag("scene", ALL_SCENES.join(",")));
const THEMES = list(flag("theme", "aurora"));
const sizeFlag = flag("size", null);
const parseSize = (s) => {
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (!m) throw new Error(`Bad --size ${s}: want <width>x<height>`);
  return { width: +m[1], height: +m[2] };
};
const SIZES = sizeFlag ? list(sizeFlag).map(parseSize) : [{ width: 1440, height: 900 }];
const output = path.resolve(root, flag("out", "docs/app-qa"));
const probesFile = path.resolve(root, flag("probes", `${fixture}/probes.json`));
const keepGoing = !!flag("keep-going", false);
const motion = flag("motion", "off");
const clockMode = flag("clock", "frozen");
for (const s of SCENES) if (!ALL_SCENES.includes(s)) throw new Error(`Unknown scene ${s}`);

/** Per scene: the seed (`?board=`, a scenarios.ts id or alias) and, for a
 *  scene that reads best at one size, the sizes it runs at when --size is
 *  not given. */
const SCENE = {
  home: { board: "workbench" },
  "door-tab": { board: "workbench" },
  plan: { board: "workbench" },
  agent: { board: "workbench" },
  "agent-cli": { board: "workbench" },
  browser: { board: "workbench" },
  sidebar: { board: "workbench", sizes: [{ width: 1440, height: 900 }, { width: 900, height: 640 }] },
  "rail-plan-discussion": { board: "workbench" },
  "rail-plan-talk": { board: "workbench" },
  "rail-plan-files": { board: "workbench" },
  "rail-plan-changes": { board: "workbench" },
  "rail-browser-talk": { board: "workbench" },
  "rail-browser-files": { board: "workbench" },
  "rail-browser-changes": { board: "workbench" },
  "rail-folded": { board: "workbench" },
  "quick-open": { board: "workbench" },
  "file-pane": { board: "workbench" },
};
const sizesFor = (scene) => (sizeFlag ? SIZES : SCENE[scene].sizes ?? SIZES);

// ── Drives ─────────────────────────────────────────────────────────────────
//
// How each scene's state is reached, with real input: CDP mouse events at an
// element's centre, `Input.insertText` for typing, key events for keys, and
// `emit` for what the native menu would send (the fake's `listen` hears
// `window.__qa.emit`). A step finds its target like a probe does (`css`
// candidates, then `text` / `textStarts` scoped by `within`, then
// `.closest(up)`). Steps marked `optional` are recorded as skipped when
// their target is absent and the drive carries on.

const PLAN_ROW = "Din roadmap: next steps";
const AT_HOME = [
  { do: "waitFor", expr: "!!document.querySelector('.rl-wb-door-plate')", timeout: 15000, why: "Home's door tab is the active pane" },
  { do: "waitFor", expr: "!!document.querySelector('.rl-fd-island')", timeout: 15000, why: "the Front Door island is on the plate" },
];
const SELECT_PLAN = [
  { do: "click", within: ".rl-sb", text: PLAN_ROW, up: "button", why: "pick the roadmap plan's sidebar row" },
  { do: "waitFor", expr: "!!document.querySelector('.rl-plan-pane h1')", timeout: 15000, why: "the Plan tab shows the plan's h1" },
];
const OPEN_AGENT = [
  ...SELECT_PLAN,
  { do: "click", css: [".rl-wb-strip [role=tab][title='Agent']"], why: "the set's Agent tab" },
  { do: "waitFor", expr: "!!document.querySelector('.rl-agent-pane .rl-convo')", timeout: 15000, why: "the session's conversation in the Agent pane" },
];
// The right rail (W4): a tab of the rail, by its data attribute.
const RAIL_TAB = (tab) => [
  { do: "click", css: [`.rl-rail-tab[data-rail-tab=${tab}]`], why: `the rail's ${tab} tab` },
  { do: "waitFor", expr: `!!document.querySelector('.rl-rail[data-rail-tab=${tab}]')`, timeout: 8000, why: `the rail shows ${tab}` },
];
const OPEN_BROWSER = [
  ...AT_HOME,
  { do: "click", css: [".rl-fd-island .rl-composer-chip[aria-label=Destination]", ".rl-composer-chip[aria-label=Destination]"], why: "open the door's destination menu" },
  { do: "click", within: ".rl-composer-menu", text: "Open in the browser", up: "button", why: "pick Open in the browser" },
  { do: "click", css: [".rl-fd-island .rl-fd-input", ".rl-fd-input"], why: "put the caret in the door's box" },
  { do: "type", text: "https://example.com", why: "type an address" },
  { do: "key", key: "Enter", why: "⏎: the door tab becomes the browser" },
  { do: "waitFor", expr: "!!document.querySelector('.rl-rail[data-rail-tab=talk]')", timeout: 15000, why: "the browser's rail leads with Talk" },
];
const PLAN_FILES = [
  ...SELECT_PLAN,
  ...RAIL_TAB("files"),
  { do: "waitFor", expr: "[...document.querySelectorAll('.rl-rail .rl-file-row')].some(r => r.textContent.includes('src'))", timeout: 8000, why: "the project tree" },
  { do: "click", within: ".rl-rail", text: "src", up: ".rl-file-row", why: "open src" },
  { do: "click", within: ".rl-rail", text: "jobs", up: ".rl-file-row", why: "open src/jobs" },
];
const DRIVES = {
  "rail-plan-discussion": [...SELECT_PLAN, { do: "waitFor", expr: "!!document.querySelector('.rl-rail[data-rail-tab=discussion] .rl-fb-pile')", timeout: 8000, why: "the Discussion piles" }],
  "rail-plan-talk": [...SELECT_PLAN, ...RAIL_TAB("talk")],
  "rail-plan-files": PLAN_FILES,
  "rail-plan-changes": [...SELECT_PLAN, ...RAIL_TAB("changes")],
  "rail-browser-talk": OPEN_BROWSER,
  "rail-browser-files": [...OPEN_BROWSER, ...RAIL_TAB("files")],
  "rail-browser-changes": [...OPEN_BROWSER, ...RAIL_TAB("changes")],
  "rail-folded": [
    ...SELECT_PLAN,
    { do: "click", css: [".rl-rail-strip button[aria-label='Hide the rail']"], why: "◨ folds the rail" },
    { do: "waitFor", expr: "!!document.querySelector('.rl-rail-edge')", timeout: 8000, why: "the edge strip" },
  ],
  "quick-open": [
    ...SELECT_PLAN,
    { do: "key", key: "p", modifiers: 4, why: "⌘P: go to a file" },
    { do: "waitFor", expr: "!!document.querySelector('.rl-qo-row')", timeout: 8000, why: "the folder's files" },
    { do: "type", text: "queue", why: "type a file name" },
  ],
  "file-pane": [
    ...PLAN_FILES,
    { do: "click", within: ".rl-rail", text: "queue.ts", up: ".rl-file-row", why: "preview queue.ts" },
    { do: "waitFor", expr: "!!document.querySelector('.rl-wb-strip [role=tab][data-preview]')", timeout: 8000, why: "a preview tab" },
  ],
  home: AT_HOME,
  "door-tab": [
    ...AT_HOME,
    { do: "emit", event: "menu-new-tab", payload: null, why: "⌘T / File ▸ New Tab: a second door tab" },
    { do: "waitFor", expr: "document.querySelectorAll('.rl-wb-strip [role=tab]').length >= 2", timeout: 8000, why: "a second tab in the strip" },
  ],
  plan: SELECT_PLAN,
  agent: OPEN_AGENT,
  "agent-cli": [
    ...OPEN_AGENT,
    { do: "click", within: ".rl-agent-head", text: "CLI", up: "[role=radio]", why: "CLI in the header's Chat | CLI segment" },
    { do: "waitFor", expr: "!!document.querySelector('.rl-agent-pane .rl-agent-cli')", timeout: 8000, why: "the pane shows its PTY" },
  ],
  browser: [
    ...AT_HOME,
    { do: "click", css: [".rl-fd-island .rl-composer-chip[aria-label=Destination]", ".rl-composer-chip[aria-label=Destination]"], why: "open the door's destination menu" },
    { do: "click", within: ".rl-composer-menu", text: "Open in the browser", up: "button", why: "pick Open in the browser" },
    { do: "click", css: [".rl-fd-island .rl-fd-input", ".rl-fd-input"], why: "put the caret in the door's box" },
    { do: "type", text: "https://example.com", why: "type an address" },
    { do: "key", key: "Enter", why: "⏎: the door tab becomes the browser" },
    { do: "waitFor", expr: "!!document.querySelector('.rl-wb-strip [role=tab][aria-selected=true] svg.lucide-globe') || !!document.querySelector('.rl-wb-pane [data-browser-pane], .rl-wb-pane .rl-browser, .rl-wb-pane .rl-bp')", timeout: 15000, why: "the active tab is the browser" },
  ],
  sidebar: [
    ...AT_HOME,
    { do: "waitFor", expr: "!!document.querySelector('.rl-sb .rl-sb-places') && !!document.querySelector('.rl-sb .rl-sb-section .rl-sb-label')", timeout: 8000, why: "the Places and a project group" },
  ],
};

const temporary = await mkdtemp(path.join(tmpdir(), "redline-app-qa-"));
const report = {
  startedAt: new Date().toISOString(),
  fixture,
  scenes: SCENES,
  themes: THEMES,
  sizes: SIZES.map((s) => `${s.width}x${s.height}`),
  runs: [],
  errors: [],
  appWarnings: [],
  limitations: [
    "Headless Chrome (Blink), not WKWebView: fonts resolve through Chrome's stacks, and native chrome (traffic lights, vibrancy) is absent.",
    "Every Tauri command is answered by fixtures/app-qa/services.ts; no Rust, database, PTY or agent runs. The browser surface's native webview is faked, so its pane is a placeholder.",
    "Animations and transitions are collapsed to 1ms and the page clock is frozen at the scenario's time unless --motion on / --clock live.",
    "No reference boards exist for the workbench: captures are not composited against a design.",
  ],
};
let server, chrome, cdp;
let run = null; // the run being captured; console errors land in it

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timeout);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        note(d.exception?.description ?? d.text);
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        note(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
      } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        note(`[${msg.params.entry.source}] ${msg.params.entry.text}`);
      }
    });
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 60000);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  close() {
    this.ws.close();
  }
}

/** A console error, sorted into the run's errors or its App warnings. */
function note(text) {
  const t = String(text).slice(0, 2000);
  if (isAppWarning(t)) return void (run ? run.appWarnings : report.appWarnings).push(t);
  if (!run) return void report.errors.push(t);
  run.consoleErrors.push(t);
}

/** React's dev-only DOM-nesting / key warnings are the App's own (the
 *  shipped dev build logs them too), kept apart from errors a missing mock
 *  or a broken render causes. */
function isAppWarning(t) {
  // xterm 5's Viewport schedules a scroll sync on a timer at open; a
  // terminal disposed before it fires (StrictMode's dev double-mount, a
  // placeholder tab swapped for the real one) throws reading `dimensions`.
  // Upstream and dev-only, so it is the App's warning, not a fixture gap.
  return /cannot be a descendant of|cannot contain a nested|Each child in a list should have a unique "key"|validateDOMNesting|Viewport\.syncScrollArea/.test(t);
}

async function settle(ms = 120) {
  await cdp.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await delay(ms);
}

/** Until `expression` is truthy, or `timeout` ms. */
async function waitFor(expression, timeout = 15000, interval = 100) {
  const end = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = await cdp.evaluate(expression);
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() > end) return null;
    await delay(interval);
  }
}

/** Quiet = no new invoke for `quiet` ms, fonts loaded, two frames painted. */
async function quiesce(quiet = 600, timeout = 10000) {
  const end = Date.now() + timeout;
  let last = -1;
  let since = Date.now();
  while (Date.now() < end) {
    const n = await cdp.evaluate("window.__qa ? window.__qa.calls().length : -1");
    if (n !== last) {
      last = n;
      since = Date.now();
    } else if (Date.now() - since >= quiet) break;
    await delay(100);
  }
  await cdp.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
  await settle();
}

// ── In-page tools ──────────────────────────────────────────────────────────
//
// Installed once per page load. `find` is the shared finder for probes and
// drive steps; `measure` reads geometry and the computed type/colour a spec
// cell names; `sweep` is the contrast sweep from monochat-visual-qa.mjs,
// widened to the whole page and to icon-only controls (3:1).

function pageTools() {
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const s = getComputedStyle(el);
    return s.visibility === "visible" && s.display !== "none" && !el.closest("[hidden], [aria-hidden=true], [inert]");
  };
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  /** Visible elements under `scope` whose whole text is `text` (or starts
   *  with it), smallest first: the first is the tightest box around the
   *  words. */
  const byText = (text, starts, scope) => {
    const want = norm(text);
    const hits = [];
    for (const el of (scope ?? document.body).querySelectorAll("*")) {
      if (/^(SCRIPT|STYLE|SVG|PATH|TEMPLATE)$/i.test(el.tagName)) continue;
      const t = norm(el.textContent || "");
      if (!(starts ? t.startsWith(want) : t === want) || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      hits.push({ el, area: r.width * r.height });
    }
    return hits.sort((a, b) => a.area - b.area).map((h) => h.el);
  };
  const find = (spec) => {
    for (const css of [].concat(spec.css ?? [])) {
      let all = [];
      try {
        all = [...document.querySelectorAll(css)];
      } catch {
        continue;
      }
      const hit = all.find(visible);
      if (hit) return { el: hit, via: `css ${css}` };
    }
    const text = spec.text ?? spec.textStarts;
    if (text) {
      // `within` scopes the text search to one region (the sidebar's row,
      // not the plan's h1 or a door recent with the same title).
      let scope = null;
      if (spec.within) {
        scope = [...document.querySelectorAll(spec.within)].find(visible) ?? null;
        if (!scope) return null;
      }
      const hits = byText(text, !!spec.textStarts, scope);
      // With `up`, the words that sit inside such an element win; without
      // one, or when none does, the tightest match.
      const inside = spec.up ? hits.map((el) => el.closest(spec.up)).find(Boolean) : null;
      const el = inside ?? hits[0];
      if (el) return { el, via: `${spec.textStarts ? "textStarts" : "text"} ${JSON.stringify(text)}${spec.within ? ` in ${spec.within}` : ""}${spec.up ? ` ↑${spec.up}${inside ? "" : " (no match; tightest text)"}` : ""}` };
    }
    return null;
  };
  // Colours are read back through a 1px canvas: Chrome serializes a
  // `color-mix()` token as `oklab(…)` / `color(srgb …)`, and the canvas both
  // parses every CSS colour space and composites layers exactly as the page
  // does (sRGB, source-over), so a stack of translucent fills reads as the
  // colour the eye gets.
  const probeEl = document.createElement("i");
  probeEl.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  document.body.append(probeEl);
  const pixel = document.createElement("canvas");
  pixel.width = pixel.height = 1;
  const ink = pixel.getContext("2d", { willReadFrequently: true });
  /** A colour expression (tokens allowed) as the computed string. */
  const resolve = (css) => {
    probeEl.style.color = "";
    probeEl.style.color = css;
    return getComputedStyle(probeEl).color;
  };
  /** Paint `layers` bottom-up on an empty pixel; [r, g, b, a(0–1)]. */
  const paint = (...layers) => {
    ink.clearRect(0, 0, 1, 1);
    for (const c of layers) {
      ink.fillStyle = "rgba(0,0,0,0)";
      ink.fillStyle = c;
      ink.fillRect(0, 0, 1, 1);
    }
    const d = ink.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const fmt = (c) => `rgba(${c.slice(0, 3).join(",")},${+c[3].toFixed(3)})`;
  /** Same colour: the same serialization, or the same pixels over black and
   *  over white (which pins the alpha too). */
  const sameColour = (a, b) => {
    if (a === b) return true;
    const near = (x, y) => x.every((v, i) => Math.abs(v - y[i]) <= (i === 3 ? 0.02 : 2));
    return near(paint("#000", a), paint("#000", b)) && near(paint("#fff", a), paint("#fff", b));
  };
  const px = (v) => (v === "normal" ? null : parseFloat(v));
  const measure = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      cls: typeof el.className === "string" ? el.className.slice(0, 120) : "",
      text: norm(el.textContent || "").slice(0, 80),
      x: +r.x.toFixed(1), y: +r.y.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1),
      fontSize: px(s.fontSize), fontWeight: Number(s.fontWeight), lineHeight: px(s.lineHeight), letterSpacing: px(s.letterSpacing),
      fontFamily: s.fontFamily,
      borderRadius: px(s.borderTopLeftRadius),
      paddingTop: px(s.paddingTop), paddingRight: px(s.paddingRight), paddingBottom: px(s.paddingBottom), paddingLeft: px(s.paddingLeft),
      gap: px(s.columnGap),
      color: s.color, backgroundColor: s.backgroundColor,
      borderTopColor: s.borderTopColor, borderBottomColor: s.borderBottomColor, borderTopWidth: px(s.borderTopWidth),
      boxShadow: s.boxShadow === "none" ? null : s.boxShadow.slice(0, 160),
    };
  };
  const check = (spec) => {
    const hit = find(spec);
    if (!hit) return { name: spec.name, found: false, pass: false, failures: ["not found"] };
    const m = measure(hit.el);
    const failures = [];
    for (const [key, want] of Object.entries(spec.expect ?? {})) {
      if (key === "fontFamily~") {
        if (!m.fontFamily.toLowerCase().includes(String(want).toLowerCase())) failures.push(`fontFamily ${m.fontFamily} lacks ${want}`);
        continue;
      }
      if (key === "maxWidth") {
        if (!(m.width <= want + 1)) failures.push(`width ${m.width} > max ${want}`);
        continue;
      }
      if (key === "minWidth") {
        if (!(m.width >= want - 1)) failures.push(`width ${m.width} < min ${want}`);
        continue;
      }
      const got = m[key];
      const tol = key === "fontWeight" ? 0 : 1;
      if (typeof got !== "number" || Math.abs(got - want) > tol) failures.push(`${key} ${got} ≠ ${want}`);
    }
    const tokens = {};
    for (const [prop, token] of Object.entries(spec.tokens ?? {})) {
      // The token's own value off :root (the theme writes concrete colours
      // there). Resolving `var(token)` through the probe element read every
      // token as the inherited ink, so only a value that is itself a
      // reference goes through it.
      const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
      const defined = raw !== "";
      const want = raw.includes("var(") ? resolve(`var(${token})`) : raw;
      const got = getComputedStyle(hit.el)[prop];
      tokens[prop] = { token, want: fmt(paint(want)), got: fmt(paint(got)) };
      if (!defined) failures.push(`${token} is not defined`);
      else if (!sameColour(want, got)) failures.push(`${prop} ≠ var(${token})`);
    }
    return { name: spec.name, found: true, via: hit.via, pass: failures.length === 0, failures, measured: m, tokens };
  };
  const lin = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const sweep = () => {
    const base = resolve("var(--color-canvas, var(--color-paper))");
    /** The fills under `el`, bottom-up, down to the first opaque one (the
     *  window canvas when none is). Painted, they are what text sits on. */
    const under = (el) => {
      const layers = [];
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        const a = paint(c)[3];
        if (a > 0) {
          layers.push(c);
          if (a >= 1) break;
        }
      }
      return [base, ...layers.reverse()];
    };
    const contrast = (fg, el) => {
      const layers = under(el);
      return +ratio(paint(...layers, fg), paint(...layers)).toFixed(2);
    };
    const opacity = (el) => {
      let o = 1;
      for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
      return o;
    };
    const texts = [];
    const icons = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (/^(SCRIPT|STYLE|TEMPLATE)$/.test(el.tagName) || !visible(el)) continue;
      if (el.closest("[disabled], [aria-disabled=true]") || opacity(el) < 0.99) continue;
      const s = getComputedStyle(el);
      const region = el.closest(".xterm") ? "terminal" : "ui";
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(" ");
      if (own) texts.push({ text: own.slice(0, 48), ratio: contrast(s.color, el), size: parseFloat(s.fontSize), region });
      // A placeholder painted transparent is standing in for an overlay
      // that carries the words; the overlay is swept as text of its own.
      if ((el.tagName === "TEXTAREA" || el.tagName === "INPUT") && el.placeholder && !el.value && paint(getComputedStyle(el, "::placeholder").color)[3] > 0) {
        texts.push({ text: `placeholder: ${el.placeholder}`.slice(0, 48), ratio: contrast(getComputedStyle(el, "::placeholder").color, el), size: parseFloat(s.fontSize), region });
      }
      if (el.matches("button, [role=button], a[href]") && !norm(el.textContent || "") && el.querySelector("svg")) {
        icons.push({ label: (el.getAttribute("aria-label") || el.title || "icon").slice(0, 48), ratio: contrast(s.color, el), region });
      }
    }
    const shortText = texts.filter((t) => t.ratio < 4.5);
    const shortIcons = icons.filter((t) => t.ratio < 3);
    return { swept: texts.length, icons: icons.length, shortText, shortIcons, pass: shortText.filter((t) => t.region === "ui").length === 0 && shortIcons.filter((t) => t.region === "ui").length === 0 };
  };
  /** Everything a reader sees as copy: rendered text plus visible
   *  placeholders. */
  const copy = (want, absent) => {
    const fields = [...document.querySelectorAll("textarea, input")].filter(visible).map((e) => e.placeholder || "").join("\n");
    const text = norm(`${document.body.innerText}\n${fields}`);
    return {
      missing: (want ?? []).filter((s) => !text.includes(norm(s))),
      unexpected: (absent ?? []).filter((s) => text.includes(norm(s))),
    };
  };
  const centre = (spec) => {
    const hit = find(spec);
    if (!hit) return null;
    hit.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = hit.el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, via: hit.via };
  };
  window.__qaTools = { find, measure, check, sweep, copy, centre };
  return true;
}

async function tools(expr) {
  const has = await cdp.evaluate("!!window.__qaTools");
  if (!has) await cdp.evaluate(`(${pageTools})()`);
  return cdp.evaluate(expr);
}

// ── Input ──────────────────────────────────────────────────────────────────

async function mouse(point, button = "left") {
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount: 1, x: point.x, y: point.y });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount: 1, x: point.x, y: point.y });
}

const KEYS = { Enter: { code: "Enter", vk: 13, text: "\r" }, Escape: { code: "Escape", vk: 27 }, Backspace: { code: "Backspace", vk: 8 } };

async function key(name, modifiers = 0) {
  const k = KEYS[name] ?? { code: `Key${name.toUpperCase()}`, vk: name.toUpperCase().charCodeAt(0), text: modifiers ? undefined : name };
  const base = { key: name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers };
  await cdp.call("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** The capture's file name for a run, with an extra `-<tag>` for a snapshot. */
function shotName(scene, theme, size, tag) {
  const sizeTag = sizesFor(scene).length > 1 ? `-${size.width}x${size.height}` : "";
  return `${scene}${tag ? `-${tag}` : ""}${theme === "aurora" ? "" : `-${theme}`}${sizeTag}.png`;
}

async function drive(scene) {
  for (const step of DRIVES[scene] ?? []) {
    const rec = { do: step.do, why: step.why, ok: false };
    run.steps.push(rec);
    if (step.do === "click" || step.do === "rightClick") {
      const at = await tools(`window.__qaTools.centre(${JSON.stringify(step)})`);
      if (!at) {
        rec.note = "target not found";
        if (step.optional) continue;
        throw new Error(`Drive ${scene}: ${step.why}: target not found`);
      }
      rec.via = at.via;
      await mouse(at, step.do === "rightClick" ? "right" : "left");
    } else if (step.do === "type") {
      const text = step.text ?? (await cdp.evaluate(`window.__qa.scenario().${step.from}`));
      await cdp.call("Input.insertText", { text });
      rec.note = text;
    } else if (step.do === "key") {
      await key(step.key, step.modifiers ?? 0);
    } else if (step.do === "emit") {
      await cdp.evaluate(`window.__qa.emit(${JSON.stringify(step.event)}, ${JSON.stringify(step.payload ?? null)})`);
      rec.note = step.event;
    } else if (step.do === "waitFor") {
      const ok = await waitFor(step.expr, step.timeout ?? 10000);
      if (!ok) {
        rec.note = "timed out";
        if (step.optional) continue;
        throw new Error(`Drive ${scene}: ${step.why}: timed out`);
      }
    } else if (step.do === "snapshot") {
      await quiesce(300, 4000);
      const file = shotName(scene, run.theme, run.size, step.name);
      await screenshot(file);
      run.extraShots.push(file);
    }
    rec.ok = true;
    await settle(150);
  }
}

async function screenshot(file) {
  const shot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(path.join(output, file), Buffer.from(shot.data, "base64"));
}

// ── Self-test ──────────────────────────────────────────────────────────────
//
// The fake's conversation plumbing, proven through the real wrappers in
// src/components/agent/convo/api.ts: a subscription returns the seeded
// tail, a pushed batch reaches the subscriber through its Channel, a reset
// batch replaces, and a composer send is accepted.

async function selfTest(base) {
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: `${base}?board=workbench&theme=aurora` });
  await waitFor("!!(window.__qa && window.__qa.booted)", 60000);
  return cdp.evaluate(`(async () => {
    const api = await import("/src/components/agent/convo/api.ts");
    const batches = [];
    const snap = await api.convoSubscribe("t-din-roadmap", (b) => batches.push(b));
    const seeded = window.__qa.scenario().terminals[0].convo.length;
    const event = { id: "selftest-1", epoch: 0, offset: 999999, ts: Date.now(), kind: "assistant_text", text: "self-test" };
    const pushed = window.__qa.convoPush("t-din-roadmap", [event]);
    window.__qa.convoPush("t-din-roadmap", [event], true);
    const sent = await api.ptySubmit("t-din-roadmap", "Why is Xcode compile first?");
    const page = await api.convoPage("t-din-roadmap", 0, 0);
    await api.convoUnsubscribe("t-din-roadmap", snap.subscriptionId);
    const after = window.__qa.convoPush("t-din-roadmap", [event]);
    const result = {
      snapshotEvents: snap.events.length,
      seeded,
      firstKind: snap.events[0]?.kind,
      delivered: pushed && batches.length === 2 && batches[0].events[0].id === "selftest-1",
      resetFlag: batches[1]?.reset === true,
      submit: sent.status,
      pageShape: Array.isArray(page.events) && page.hasOlder === false,
      unsubscribed: after === false,
      frozenClock: Date.now() === window.__qa.scenario().now && new Date().getTime() === Date.now(),
    };
    result.pass = result.snapshotEvents === seeded && seeded > 0 && result.firstKind === "bound" && result.delivered && result.resetFlag && result.submit === "sent" && result.pageShape && result.unsubscribed && result.frozenClock;
    return result;
  })()`);
}

// ── Runs ───────────────────────────────────────────────────────────────────

async function boot(base, scene, theme, size) {
  const { width, height } = size;
  // Leave the previous scene first: resizing the viewport under it would
  // fire its resize handlers (an open menu's, say) into this run's log.
  await cdp.call("Page.navigate", { url: "about:blank" });
  await waitFor("location.href === 'about:blank' && document.readyState === 'complete'", 5000);
  await cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const url = `${base}?board=${SCENE[scene].board}&theme=${theme}&motion=${motion}&clock=${clockMode}`;
  await cdp.call("Page.navigate", { url });
  const booted = await waitFor("!!(window.__qa && window.__qa.booted && document.querySelector('#root')?.children.length)", 60000);
  if (!booted) throw new Error(`App never mounted for ${url}`);
  // Park the pointer in a corner so no hover state leaks into a capture.
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: width - 2, y: height - 2 });
  await quiesce(800, 20000);
}

async function capture(base, scene, theme, size, spec, shared) {
  await boot(base, scene, theme, size);
  await drive(scene);
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: size.width - 2, y: size.height - 2 });
  await quiesce(600, 10000);
  const name = shotName(scene, theme, size);
  await screenshot(name);
  run.screenshot = name;
  const probes = [...(shared ?? []), ...(spec.probes ?? [])];
  run.probes = await tools(`(${JSON.stringify(probes)}).map((p) => window.__qaTools.check(p))`);
  run.copy = await tools(`window.__qaTools.copy(${JSON.stringify(spec.copy ?? [])}, ${JSON.stringify(spec.absent ?? [])})`);
  run.contrast = await tools("window.__qaTools.sweep()");
  run.unmocked = await cdp.evaluate("window.__qa.unmocked()");
  const pageErrors = await cdp.evaluate("window.__qa.errors");
  run.pageErrors = pageErrors.filter((t) => !isAppWarning(t));
  run.appWarnings.push(...pageErrors.filter(isAppWarning).map((t) => `[page] ${t}`));
  run.tabs = await cdp.evaluate("[...document.querySelectorAll('.rl-wb-strip [role=tab]')].map((t) => ({ title: t.title, active: t.getAttribute('aria-selected') === 'true' }))");
  run.terminals = await cdp.evaluate("window.__qa.terminals().map(({ input, ...t }) => ({ ...t, typed: input.length }))");
  run.invoked = await cdp.evaluate("Object.fromEntries(Object.entries(window.__qa.calls().reduce((m, c) => (m[c.cmd] = (m[c.cmd] || 0) + 1, m), {})).sort())");
  const probeFails = run.probes.filter((p) => !p.pass).length;
  run.summary = {
    probes: `${run.probes.length - probeFails}/${run.probes.length} pass`,
    copyMissing: run.copy.missing.length,
    contrastShort: run.contrast.shortText.filter((t) => t.region === "ui").length + run.contrast.shortIcons.filter((t) => t.region === "ui").length,
    consoleErrors: run.consoleErrors.length + run.pageErrors.length,
    unmocked: run.unmocked.length,
  };
}

async function main() {
  await mkdir(output, { recursive: true });
  const probes = existsSync(probesFile) ? JSON.parse(await readFile(probesFile, "utf8")) : {};

  server = await createServer({
    configFile: false,
    root,
    cacheDir: path.join(root, "node_modules/.cache/app-qa-vite"),
    logLevel: "warn",
    optimizeDeps: { entries: [`${fixture}/index.html`] },
    plugins: [react(), tailwindcss()],
    // Every `@tauri-apps/*` specifier, plugins included, is the fake.
    resolve: { alias: [{ find: /^@tauri-apps\/.*$/, replacement: service }] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null },
    clearScreen: false,
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}/${fixture}/`;
  report.fixtureUrl = base;

  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      `--user-data-dir=${path.join(temporary, "chrome-profile")}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-component-update",
      "--disable-extensions",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let chromeLog = "";
  chrome.stderr.on("data", (d) => (chromeLog += d));
  let port;
  for (let i = 0; i < 150; i++) {
    try {
      port = (await readFile(path.join(temporary, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0];
      break;
    } catch {}
    await delay(100);
  }
  if (!port) throw new Error(`Chrome failed to start: ${chromeLog.slice(-3000)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new CDP(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Log.enable");
  report.browserVersion = (await cdp.call("Browser.getVersion")).product;
  // The scenarios' times are Los Angeles wall-clock (scenarios.ts).
  await cdp.call("Emulation.setTimezoneOverride", { timezoneId: "America/Los_Angeles" });
  await cdp.call("Emulation.setLocaleOverride", { locale: "en-US" });
  if (motion !== "on") await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });

  // The first load compiles and pre-bundles the whole App graph; boot once
  // untimed so a mid-run dependency re-optimisation can't reload a capture.
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: `${base}?board=workbench&theme=aurora` });
  await waitFor("!!(window.__qa && window.__qa.booted)", 120000);
  await delay(1500);

  report.selfTest = await selfTest(base);
  if (!report.selfTest.pass) report.errors.push(`Self-test failed: ${JSON.stringify(report.selfTest)}`);

  for (const scene of SCENES) {
    for (const theme of THEMES) {
      for (const size of sizesFor(scene)) {
        const sizeId = `${size.width}x${size.height}`;
        run = { scene, theme, size, steps: [], extraShots: [], consoleErrors: [], appWarnings: [], screenshot: null };
        report.runs.push(run);
        const t0 = Date.now();
        try {
          await capture(base, scene, theme, size, probes[scene] ?? {}, probes.all);
        } catch (error) {
          run.failure = String(error?.stack ?? error);
          if (!run.screenshot) {
            try {
              const file = shotName(scene, theme, size);
              await screenshot(file);
              run.screenshot = file;
            } catch {}
          }
        }
        run.ms = Date.now() - t0;
        const s = run.summary;
        console.log(`${scene} ${theme} ${sizeId}: ${run.failure ? `FAILED (${String(run.failure).split("\n")[0]})` : "ok"}${s ? ` · probes ${s.probes} · copy missing ${s.copyMissing} · contrast short ${s.contrastShort} · console ${s.consoleErrors} · unmocked ${s.unmocked}` : ""}`);
        if (run.failure && !keepGoing) throw new Error(run.failure);
      }
    }
  }
  run = null;
  await writeFile(path.join(output, "chrome.stderr.log"), chromeLog.slice(-200_000));
}

try {
  await main();
} catch (error) {
  report.errors.push(String(error?.stack ?? error));
} finally {
  report.finishedAt = new Date().toISOString();
  // Two verdicts. `harnessClean`: every run booted, drove and captured with
  // no console error and no command the fake doesn't answer — the fixture's
  // own bar. `fidelity`: how the walk measures against the workbench spec.
  report.harnessClean = !report.errors.length && report.runs.every((r) => !r.failure && !r.consoleErrors.length && !r.pageErrors?.length && !r.unmocked?.length);
  report.table = report.runs.map((r) => ({ run: `${r.scene} ${r.theme} ${r.size.width}x${r.size.height}`, ...(r.summary ?? { failure: String(r.failure).split("\n")[0] }) }));
  const probes = report.runs.flatMap((r) => r.probes ?? []);
  report.fidelity = {
    probesPassing: `${probes.filter((p) => p.pass).length}/${probes.length}`,
    copyMissing: report.runs.reduce((n, r) => n + (r.copy?.missing.length ?? 0), 0),
    contrastShort: report.runs.reduce((n, r) => n + (r.summary?.contrastShort ?? 0), 0),
  };
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  cdp?.close();
  if (chrome) {
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((r) => chrome.once("exit", r)), delay(3000)]);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
  }
  await server?.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`harness ${report.harnessClean ? "clean" : "NOT CLEAN"} · ${report.runs.length} runs · fidelity: probes ${report.fidelity?.probesPassing}, copy missing ${report.fidelity?.copyMissing}, contrast short ${report.fidelity?.contrastShort} → ${path.relative(root, output)}/report.json`);
if (!report.harnessClean) {
  if (report.errors.length) console.error(report.errors.join("\n"));
  process.exitCode = 1;
}
