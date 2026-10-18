#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Design-fidelity harness for the Flow redesign: the REAL App (src/main.tsx
//! → App.tsx, every lane composed) booted in headless Chrome against the fake
//! backend in fixtures/flow-app-qa/services.ts, driven into each design
//! board's state with real clicks and keys, and captured at board size.
//!
//!   node scripts/flow-app-visual-qa.mjs [--board 4a,4b,4c,4d,5a]
//!       [--theme aurora,basic,studio] [--shell flow|classic|flow,classic]
//!       [--out docs/flow-qa/app] [--probes fixtures/flow-app-qa/probes.json]
//!       [--boards ~/redline-wt/flow-design] [--keep-going]
//!       [--motion on] [--clock live]
//!
//! Per board × theme × shell it writes `<board>-<theme>.png` (the classic
//! shell adds `-classic`), and for Aurora a side-by-side
//! `<board>-compare.png`: the reference board's window | the capture | their
//! difference. One `report.json` holds, per run: which drive steps ran, the
//! probes from probes.json measured against the fidelity spec, the copy
//! check, a WCAG contrast sweep over the whole page, console errors, and every
//! command App invoked that the fake backend has no handler for.
//!
//! The drive steps (DRIVES below) and the probes are the two things a lane
//! merge should need to touch; see "How to extend" in the appqa REPORT.

import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = "fixtures/flow-app-qa";
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
const BOARDS = list(flag("board", "4a,4b,4c,4d,5a"));
const THEMES = list(flag("theme", "aurora,basic,studio"));
const SHELLS = list(flag("shell", "flow"));
const output = path.resolve(root, flag("out", "docs/flow-qa/app"));
const probesFile = path.resolve(root, flag("probes", `${fixture}/probes.json`));
const boardsDir = path.resolve(String(flag("boards", path.join(homedir(), "redline-wt/flow-design"))));
const keepGoing = !!flag("keep-going", false);
const motion = flag("motion", "off");
const clockMode = flag("clock", "frozen");
for (const b of BOARDS) if (!["4a", "4b", "4c", "4d", "5a"].includes(b)) throw new Error(`Unknown board ${b}`);
for (const s of SHELLS) if (!["flow", "classic"].includes(s)) throw new Error(`Unknown shell ${s}`);

/** Where each board PNG draws the app window (inside its 1px frame) and the
 *  window's size, which is the capture's viewport. Measured from the PNGs:
 *  the first canvas-coloured pixel inside the #1c2230 frame. The 4a–4d
 *  boards crop the window's last 6px. */
const BOARD = {
  "4a": { png: "b4a.png", x: 13, y: 56, width: 1280, height: 800 },
  "4b": { png: "b4b.png", x: 10, y: 56, width: 1280, height: 800 },
  "4c": { png: "b4c.png", x: 12, y: 56, width: 1280, height: 800 },
  "4d": { png: "b4d.png", x: 9, y: 56, width: 1280, height: 800 },
  "5a": { png: "b5a.png", x: 13, y: 18, width: 1600, height: 960 },
};

// ── Drives ─────────────────────────────────────────────────────────────────
//
// How each board's state is reached, with real input: CDP mouse events at an
// element's centre, `Input.insertText` for typing, key events for keys. A
// step finds its target like a probe does (`css` candidates, then `text` /
// `textStarts`, then `.closest(up)`). Steps marked `optional` are the flow
// controls the lanes are still building: absent, they're recorded as skipped
// and the drive carries on, so the same table works on classic today and on
// the composed flow shell after integration. `shell` limits a step to one
// shell.

const COMPOSER = ["[data-flow-start-composer] textarea", ".rl-fd-input", "[data-chat-composer] textarea"];
const typePrompt = [
  { do: "click", css: COMPOSER, why: "put the caret in the start composer" },
  { do: "type", from: "prompt", why: "type the board's prompt" },
];
const DRIVES = {
  "4a": [
    { do: "click", text: "Plan", up: "button, [role=radio], [role=tab]", optional: true, shell: "flow", why: "pick Plan in the Chat | Plan segment" },
    ...typePrompt,
    // The caret in the box is the focus zoom (everything else recedes); the
    // board draws the start screen at rest with the sentence typed.
    { do: "key", key: "Escape", optional: true, shell: "flow", why: "Esc: back to rest, the sentence kept" },
  ],
  "4b": [
    ...typePrompt,
    { do: "key", key: "Enter", why: "Start plan ↵" },
    { do: "waitFor", expr: "window.__qa.terminals().some(t => t.launched)", timeout: 20000, why: "the launch command reaches the PTY" },
    { do: "waitFor", expr: "window.__qa.terminals().some(t => t.launched && t.subscribed)", timeout: 6000, optional: true, why: "the stage subscribes to the launch's conversation" },
  ],
  "4c": [
    // Flow opens the plan beside the chat by itself once it has loaded.
    { do: "waitFor", expr: "!!document.querySelector('.rl-flow-plan:not([hidden]) .rl-prose h1')", timeout: 8000, optional: true, shell: "flow", why: "the plan opens on the stage" },
    { do: "click", text: "Open in panel →", optional: true, why: "open the plan beside the chat (split pose)" },
    // The split pose folds the sidebar itself (⌘B here would bring it back).
    { do: "click", css: ["[data-comment-id=c-001]", "mark"], optional: true, why: "focus the mark so its margin note shows" },
  ],
  "4d": [
    { do: "click", text: "Close plan", up: "button", optional: true, why: "✕ Close plan: the plan panel closes" },
    { do: "rightClick", text: "Din backend: Hono + Fly", why: "right-click a row: its ⋯ menu" },
    { do: "snapshot", name: "rowmenu", why: "the row menu alone (the board draws both menus at once)" },
    { do: "click", text: "Tools", up: "button", optional: true, shell: "flow", why: "open the Tools menu" },
  ],
  "5a": [
    { do: "click", text: "Dialcrown: fastest credible launch", why: "open the building session" },
    // Flow: the session loads, and its plan opens beside the conversation
    // (split, which folds the sidebar); Full screen brings the sidebar and
    // its versions back.
    { do: "waitFor", expr: "!!document.querySelector('.rl-flow-plan:not([hidden]) .rl-prose h1')", timeout: 8000, optional: true, shell: "flow", why: "the plan opens on the stage" },
    { do: "click", text: "Full screen", up: "button", optional: true, shell: "flow", why: "⤢ Full screen: the full pose" },
    { do: "click", css: [".rl-sb-versions li:first-child .rl-sb-version"], text: "v1", up: "button, [role=button], [role=treeitem], a, li", optional: true, why: "view v1 (read-only)" },
    { do: "click", textStarts: "Feedback", up: "button, [role=tab]", optional: true, shell: "flow", why: "the right panel's Feedback tab" },
  ],
};

const temporary = await mkdtemp(path.join(tmpdir(), "redline-flow-app-qa-"));
const report = {
  startedAt: new Date().toISOString(),
  fixture,
  boards: BOARDS,
  themes: THEMES,
  shells: SHELLS,
  runs: [],
  composites: [],
  errors: [],
  appWarnings: [],
  limitations: [
    "Headless Chrome (Blink), not WKWebView: fonts resolve through Chrome's stacks, and native chrome (traffic lights, vibrancy) is absent.",
    "Every Tauri command is answered by fixtures/flow-app-qa/services.ts; no Rust, database, PTY or agent runs.",
    "Animations and transitions are collapsed to 1ms and the page clock is frozen at the scenario's time unless --motion on / --clock live.",
    "4d: the board draws the Tools menu and a row menu open at once; real input can't (opening one dismisses the other), so the row menu is also captured alone as 4d-rowmenu-<theme>.png.",
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
  /** Visible elements whose whole text is `text` (or starts with it),
   *  smallest first: the first is the tightest box around the words. */
  const byText = (text, starts) => {
    const want = norm(text);
    const hits = [];
    for (const el of document.body.querySelectorAll("*")) {
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
      const hits = byText(text, !!spec.textStarts);
      // With `up`, the words that sit inside such an element win (the plan's
      // h1, not the sidebar row with the same title); without one, or when
      // none does, the tightest match.
      const inside = spec.up ? hits.map((el) => el.closest(spec.up)).find(Boolean) : null;
      const el = inside ?? hits[0];
      if (el) return { el, via: `${spec.textStarts ? "textStarts" : "text"} ${JSON.stringify(text)}${spec.up ? ` ↑${spec.up}${inside ? "" : " (no match; tightest text)"}` : ""}` };
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
      // that carries the words (the Feedback composer's two-line hint); the
      // overlay is swept as text of its own.
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

async function drive(board, shell, name) {
  for (const step of DRIVES[board] ?? []) {
    if (step.shell && step.shell !== shell) continue;
    const rec = { do: step.do, why: step.why, ok: false };
    run.steps.push(rec);
    if (step.do === "click" || step.do === "rightClick") {
      const at = await tools(`window.__qaTools.centre(${JSON.stringify(step)})`);
      if (!at) {
        rec.note = "target not found";
        if (step.optional) continue;
        throw new Error(`Drive ${board}: ${step.why}: target not found`);
      }
      rec.via = at.via;
      await mouse(at, step.do === "rightClick" ? "right" : "left");
    } else if (step.do === "type") {
      const text = step.text ?? (await cdp.evaluate(`window.__qa.scenario().${step.from}`));
      await cdp.call("Input.insertText", { text });
      rec.note = text;
    } else if (step.do === "key") {
      await key(step.key, step.modifiers ?? 0);
    } else if (step.do === "waitFor") {
      const ok = await waitFor(step.expr, step.timeout ?? 10000);
      if (!ok) {
        rec.note = "timed out";
        if (step.optional) continue;
        throw new Error(`Drive ${board}: ${step.why}: timed out`);
      }
    } else if (step.do === "snapshot") {
      await quiesce(300, 4000);
      const file = `${board}-${step.name}-${run.theme}${shell === "classic" ? "-classic" : ""}.png`;
      await screenshot(file);
      run.extraShots.push(file);
    }
    rec.ok = true;
    await settle(150);
  }
  void name;
}

async function screenshot(file) {
  const shot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(path.join(output, file), Buffer.from(shot.data, "base64"));
}

// ── Self-test ──────────────────────────────────────────────────────────────
//
// The fake's conversation plumbing, proven through the real wrappers in
// src/lib/convo/api.ts (imported into the 4c page): a subscription returns
// the seeded tail, a pushed batch reaches the subscriber through its
// Channel, a reset batch replaces, and a composer send is accepted. On this
// branch nothing in App subscribes yet, so this is what says the mirror
// side of the fixture works before the stage lane needs it.

async function selfTest(base) {
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: `${base}?board=4c&theme=aurora&shell=classic` });
  await waitFor("!!(window.__qa && window.__qa.booted)", 60000);
  return cdp.evaluate(`(async () => {
    const api = await import("/src/lib/convo/api.ts");
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

async function boot(base, board, theme, shell) {
  const { width, height } = BOARD[board];
  // Leave the previous board first: resizing the viewport under it would
  // fire its resize handlers (an open menu's, say) into this run's log.
  await cdp.call("Page.navigate", { url: "about:blank" });
  await waitFor("location.href === 'about:blank' && document.readyState === 'complete'", 5000);
  await cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const url = `${base}?board=${board}&theme=${theme}&shell=${shell}&motion=${motion}&clock=${clockMode}`;
  await cdp.call("Page.navigate", { url });
  const booted = await waitFor("!!(window.__qa && window.__qa.booted && document.querySelector('#root')?.children.length)", 60000);
  if (!booted) throw new Error(`App never mounted for ${url}`);
  // Park the pointer in a corner so no hover state leaks into a capture.
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: width - 2, y: height - 2 });
  await quiesce(800, 20000);
}

async function capture(base, board, theme, shell, spec, shared) {
  await boot(base, board, theme, shell);
  run.shellStamp = await cdp.evaluate("document.documentElement.dataset.rlShell");
  await drive(board, shell);
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: BOARD[board].width - 2, y: BOARD[board].height - 2 });
  await quiesce(600, 10000);
  const name = `${board}-${theme}${shell === "classic" ? "-classic" : ""}.png`;
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

/** The reference board's window, the capture, and their difference, side
 *  by side on one canvas, composed in the page so no image library is
 *  needed. */
async function composite(board, shell, theme) {
  const ref = path.join(boardsDir, BOARD[board].png);
  const cap = path.join(output, `${board}-${theme}${shell === "classic" ? "-classic" : ""}.png`);
  if (!existsSync(ref) || !existsSync(cap)) return null;
  const toData = async (file) => `data:image/png;base64,${(await readFile(file)).toString("base64")}`;
  const { x, y, width, height } = BOARD[board];
  await cdp.call("Page.navigate", { url: "about:blank" });
  await delay(100);
  const dataUrl = await cdp.evaluate(`(async () => {
    const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const [ref, cap] = await Promise.all([load(${JSON.stringify(await toData(ref))}), load(${JSON.stringify(await toData(cap))})]);
    const W = ${width}, H = ${height}, head = 34, gap = 16;
    const c = document.createElement("canvas");
    c.width = W * 3 + gap * 2; c.height = H + head;
    const g = c.getContext("2d");
    g.fillStyle = "#101114"; g.fillRect(0, 0, c.width, c.height);
    g.font = "600 15px -apple-system, system-ui, sans-serif"; g.fillStyle = "#e4e9f3";
    const labels = ["Board ${board} (reference)", "Capture: ${shell} shell, ${theme}", "Difference (black = identical)"];
    labels.forEach((t, i) => g.fillText(t, i * (W + gap) + 4, 22));
    const refH = Math.min(H, ref.height - ${y});
    g.drawImage(ref, ${x}, ${y}, W, refH, 0, head, W, refH);
    g.drawImage(cap, 0, 0, W, H, W + gap, head, W, H);
    const d = document.createElement("canvas"); d.width = W; d.height = H;
    const dg = d.getContext("2d");
    dg.fillStyle = "#000"; dg.fillRect(0, 0, W, H);
    dg.drawImage(ref, ${x}, ${y}, W, refH, 0, 0, W, refH);
    dg.globalCompositeOperation = "difference";
    dg.drawImage(cap, 0, 0, W, H, 0, 0, W, H);
    g.drawImage(d, (W + gap) * 2, head);
    return c.toDataURL("image/png");
  })()`);
  const file = `${board}-compare${shell === "classic" ? "-classic" : ""}.png`;
  await writeFile(path.join(output, file), Buffer.from(dataUrl.split(",")[1], "base64"));
  return file;
}

async function main() {
  await mkdir(output, { recursive: true });
  const probes = existsSync(probesFile) ? JSON.parse(await readFile(probesFile, "utf8")) : {};

  server = await createServer({
    configFile: false,
    root,
    cacheDir: path.join(root, "node_modules/.cache/flow-app-qa-vite"),
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
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: `${base}?board=4a&theme=aurora&shell=classic` });
  await waitFor("!!(window.__qa && window.__qa.booted)", 120000);
  await delay(1500);

  report.selfTest = await selfTest(base);
  if (!report.selfTest.pass) report.errors.push(`Self-test failed: ${JSON.stringify(report.selfTest)}`);

  for (const shell of SHELLS) {
    for (const board of BOARDS) {
      for (const theme of THEMES) {
        run = { board, theme, shell, steps: [], extraShots: [], consoleErrors: [], appWarnings: [], screenshot: null };
        report.runs.push(run);
        const t0 = Date.now();
        try {
          await capture(base, board, theme, shell, probes[board] ?? {}, probes.all);
        } catch (error) {
          run.failure = String(error?.stack ?? error);
          if (!run.screenshot) {
            try {
              const file = `${board}-${theme}${shell === "classic" ? "-classic" : ""}.png`;
              await screenshot(file);
              run.screenshot = file;
            } catch {}
          }
        }
        run.ms = Date.now() - t0;
        const s = run.summary;
        console.log(`${board} ${theme} ${shell}: ${run.failure ? `FAILED (${String(run.failure).split("\n")[0]})` : "ok"}${s ? ` · probes ${s.probes} · copy missing ${s.copyMissing} · contrast short ${s.contrastShort} · console ${s.consoleErrors} · unmocked ${s.unmocked}` : ""}`);
        if (run.failure && !keepGoing) throw new Error(run.failure);
      }
    }
  }
  run = null;
  if (existsSync(boardsDir)) {
    for (const shell of SHELLS) {
      for (const board of BOARDS) {
        const theme = THEMES.includes("aurora") ? "aurora" : THEMES[0];
        const file = await composite(board, shell, theme);
        if (file) report.composites.push(file);
      }
    }
  } else {
    report.limitations.push(`No reference boards at ${boardsDir}: compare images skipped.`);
  }
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
  // own bar. `fidelity`: how far the composed App is from the boards — the
  // integrator's bar, red until the lanes land.
  report.harnessClean = !report.errors.length && report.runs.every((r) => !r.failure && !r.consoleErrors.length && !r.pageErrors?.length && !r.unmocked?.length);
  report.table = report.runs.map((r) => ({ run: `${r.board} ${r.theme} ${r.shell}`, ...(r.summary ?? { failure: String(r.failure).split("\n")[0] }) }));
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
console.log(`harness ${report.harnessClean ? "clean" : "NOT CLEAN"} · ${report.runs.length} runs · ${report.composites.length} composites · fidelity: probes ${report.fidelity?.probesPassing}, copy missing ${report.fidelity?.copyMissing}, contrast short ${report.fidelity?.contrastShort} → ${path.relative(root, output)}/report.json`);
if (!report.harnessClean) {
  if (report.errors.length) console.error(report.errors.join("\n"));
  process.exitCode = 1;
}
