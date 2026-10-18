#!/usr/bin/env node
// The flow shell's start screen (board 4a) against its board: real React
// components (the MonochatIsland door at rest on a stand-in stage, FrontDoor
// in flow mode, the lazy strip / checklist chunk), synthetic services, an
// isolated headless Chrome. Measures every fidelity cell the start lane owns
// against b4a.png's own geometry, walks the focus zoom, and sweeps WCAG
// contrast in Aurora, Basic (light) and Studio.
//
//   node scripts/flow-start-visual-qa.mjs [outDir] [boardPng]
//
// The stand-in shell reproduces the board's RENDERED geometry: its 232px
// sidebar and 46px top bar are content boxes (253px and 47px painted), and
// the board frame sits at (13, 56) in b4a.png, so a board point (x, y) is
// (x − 13, y − 56) here.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, process.argv[2] ?? "docs/flow-qa/start");
const boardPng = path.resolve(process.argv[3] ?? path.join(process.env.HOME ?? "", "redline-wt/flow-design/b4a.png"));
const temporary = await mkdtemp(path.join(tmpdir(), "redline-flow-start-qa-"));
const service = path.join(root, "fixtures/flow-start-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/flow-start-qa", board: boardPng, screenshots: [], checks: [], measurements: {}, contrast: {}, errors: [], limitations: [
  "Headless Chrome component fixture; not WKWebView, not the live app shell (the stage lane renders the real stage).",
  "Services, model catalog and readiness are synthetic. The model chip reads the fixture's catalog entry \"Opus 4.5\" to mirror the board's copy; the app reads the live catalog.",
  "The headline is --font-serif, which resolves to the system serif here, not the board's Source Serif 4: its size, weight and line box are matched, its glyphs are not.",
] };
const SENTENCE = "Read the obsidian build log and plan the next roadmap steps";
// b4a.png's frame origin: board coordinates minus this are fixture coordinates.
const DX = 13, DY = 56;
// Measured from b4a.png (board coordinates), see the REPORT.
const BOARD = {
  composer: { x: 449, y: 397, w: 662, h: 156 },
  track: { x: 464, y: 410, w: 146, h: 34 },
  plan: { x: 538, y: 414, w: 68, h: 26 },
  folder: { x: 462, y: 509, w: 138, h: 30 },
  model: { x: 606, y: 509, w: 216, h: 30 },
  start: { x: 993, y: 508, w: 105, h: 32 },
  step1: { x: 560, y: 579, w: 18, h: 18 },
};

let server, chrome, cdp;
class CDP {
  constructor(url) {
    this.id = 0; this.pending = new Map(); this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.ws.addEventListener("open", resolve, { once: true }); this.ws.addEventListener("error", reject, { once: true }); });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id) { const p = this.pending.get(msg.id); if (p) { clearTimeout(p.timeout); this.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } }
      else if (msg.method === "Runtime.exceptionThrown") report.errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") report.errors.push(msg.params.entry.text);
    });
  }
  async call(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((resolve, reject) => { const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000); this.pending.set(id, { resolve, reject, timeout }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; }
  close() { this.ws.close(); }
}
function check(name, passed, details) { report.checks.push({ name, passed: !!passed, details }); if (!passed) console.error(`FAIL ${name}`, JSON.stringify(details)); }
async function settle() { await cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"); await delay(80); }
async function key(key, code = key, virtual = 0, modifiers = 0) { await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtual, modifiers }); await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtual, modifiers }); await settle(); }
async function press(point) { await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point }); await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point }); }
async function screenshot(name) { const shot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); const file = `${name}.png`; await writeFile(path.join(output, file), Buffer.from(shot.data, "base64")); report.screenshots.push(file); return Buffer.from(shot.data, "base64"); }
const rect = (selector) => cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; })()`);
const centre = async (selector) => { const r = await rect(selector); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
/** Computed style values, plus every token the spec maps a colour to, resolved the same way. */
const styles = (selector, props, pseudo) => cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const s = getComputedStyle(e${pseudo ? `, ${JSON.stringify(pseudo)}` : ""}); return Object.fromEntries(${JSON.stringify(props)}.map(p => [p, s.getPropertyValue(p)])); })()`);
const token = (name, prop = "color") => cdp.evaluate(`(() => { const i = document.createElement('i'); i.style.${prop === "color" ? "color" : "backgroundColor"} = 'var(--${name})'; document.body.append(i); const v = getComputedStyle(i)[${JSON.stringify(prop === "color" ? "color" : "backgroundColor")}]; i.remove(); return v; })()`);
/** Every text in a subtree with its WCAG ratio on what it is painted on (the
 *  pattern from monochat-visual-qa.mjs), plus every bare icon control's glyph
 *  for the 3:1 non-text floor. */
const contrastSweep = `window.__qaContrast = (rootSelector, base) => {
  const probe = document.createElement('i'); document.body.append(probe);
  const rgba = (css) => { probe.style.color = ''; probe.style.color = css; const c = getComputedStyle(probe).color; let m = /^rgba?\\(([^)]+)\\)$/.exec(c); if (m) { const p = m[1].split(/[\\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; } m = /^color\\(srgb ([^)]+)\\)$/.exec(c); if (m) { const p = m[1].split(/[\\s/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; } return [0, 0, 0, 0]; };
  const over = (t, u) => { const a = t[3] + u[3] * (1 - t[3]); return a === 0 ? [0, 0, 0, 0] : [0, 1, 2].map(i => (t[i] * t[3] + u[i] * u[3] * (1 - t[3])) / a).concat(a); };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const baseColor = rgba('var(--color-' + base + ')');
  const background = (el) => { const layers = []; for (let n = el; n && n !== document.documentElement; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } } let bg = baseColor; for (const l of layers.reverse()) bg = over(l, bg); return bg; };
  const out = [];
  for (const el of document.querySelectorAll(rootSelector + ' *')) {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    if (!r.width || !r.height || s.visibility !== 'visible' || el.closest('[aria-hidden=true]:not(svg), [disabled], [hidden]')) continue;
    let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); if (o < 0.99) continue;
    const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join(' ');
    const bg = background(el);
    if (own) out.push({ text: own.slice(0, 40), ratio: ratio(over(rgba(s.color), bg), bg), min: 4.5 });
    if (el.tagName === 'TEXTAREA' && el.placeholder && !el.value) out.push({ text: 'placeholder: ' + el.placeholder, ratio: ratio(over(rgba(getComputedStyle(el, '::placeholder').color), bg), bg), min: 4.5 });
    if (el.tagName.toLowerCase() === 'svg' && el.parentElement?.matches('.rl-fs-icon')) out.push({ text: 'icon: ' + (el.parentElement.getAttribute('aria-label') ?? ''), ratio: ratio(over(rgba(s.color), bg), bg), min: 3 });
  }
  probe.remove(); return out;
}`;

/** b4a.png's frame beside a screenshot, for the eye; the numbers are the checks. */
async function sideBySide(shot, name) {
  const board = PNG.sync.read(await readFile(boardPng)), ours = PNG.sync.read(shot);
  const w = 1280, h = Math.min(800, board.height - DY), gap = 16;
  const out = new PNG({ width: w * 2 + gap, height: 800 });
  out.data.fill(0x30);
  for (let y = 0; y < 800; y++) for (let x = 0; x < w; x++) {
    const o = (y * out.width + x) * 4;
    if (y < h) { const b = ((y + DY) * board.width + (x + DX)) * 4; out.data[o] = board.data[b]; out.data[o + 1] = board.data[b + 1]; out.data[o + 2] = board.data[b + 2]; out.data[o + 3] = 255; }
    const s = (y * ours.width + x) * 4, p = (y * out.width + x + w + gap) * 4;
    out.data[p] = ours.data[s]; out.data[p + 1] = ours.data[s + 1]; out.data[p + 2] = ours.data[s + 2]; out.data[p + 3] = 255;
  }
  await writeFile(path.join(output, name), PNG.sync.write(out));
  report.screenshots.push(name);
}

async function load(query) {
  await cdp.call("Page.navigate", { url: `${report.fixtureUrl}?${query}` });
  let ready = false;
  for (let i = 0; i < 150; i++) { if (await cdp.evaluate("document.documentElement.dataset.qaReady === 'true' && !!document.querySelector('.rl-frontdoor-focus[data-landed] .rl-fd-island')")) { ready = true; break; } await delay(100); }
  if (!ready) throw new Error(`Fixture did not render: ${report.errors.join("\n")}`);
  // The lazy foot, and the door's 520 ms entrance.
  for (let i = 0; i < 50 && !await cdp.evaluate("!!document.querySelector('.rl-flow-strip') || new URLSearchParams(location.search).get('strip') === '0'"); i++) await delay(100);
  await delay(800); await settle();
  await cdp.evaluate(contrastSweep);
}

const near = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;
const boxMatches = (got, want, keys = ["x", "y", "w", "h"]) => !!got && keys.every((k) => near(got[k], k === "x" ? want.x - DX : k === "y" ? want.y - DY : want[k]));

try {
  await mkdir(output, { recursive: true });
  server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), optimizeDeps: { entries: ["fixtures/flow-start-qa/index.html"] }, plugins: [react(), tailwindcss()], resolve: { alias: [
    { find: /^.*\/audio\/useReadAloud$/, replacement: service },
    ...["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/window", "@tauri-apps/api/webview", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener"].map((find) => ({ find, replacement: service })),
  ] }, server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/src-tauri/**", "**/docs/**"] } }, clearScreen: false });
  await server.listen(); report.fixtureUrl = `http://127.0.0.1:${server.httpServer.address().port}/fixtures/flow-start-qa/`;
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--user-data-dir=${path.join(temporary, "chrome-profile")}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-extensions", "about:blank"], { stdio: "ignore" });
  let port; for (let i = 0; i < 150; i++) { try { port = (await readFile(path.join(temporary, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch {} await delay(100); }
  if (!port) throw new Error("Chrome did not start");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); cdp = new CDP(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Log.enable");
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });

  // ── Board 4a, Aurora, at the board's size ──────────────────────────────
  await load(`text=${encodeURIComponent(SENTENCE)}`);
  const shot = await screenshot("aurora-4a");
  await sideBySide(shot, "aurora-4a-vs-board.png");
  const m = {
    stage: await rect(".qa-stage"),
    composer: await rect(".rl-frontdoor-focus .rl-fd-island"),
    track: await rect(".rl-fs-modes"),
    chat: await rect('.rl-fs-modes [data-mode="chat"]'),
    plan: await rect('.rl-fs-modes [data-mode="plan"]'),
    hint: await rect(".rl-fs-hint"),
    prompt: await rect(".rl-frontdoor-focus .rl-fd-input"),
    folder: await rect('.rl-fd-tools [aria-label="Choose project"]'),
    model: await rect('.rl-fd-tools [aria-haspopup="menu"][title^="⏎ launches"]'),
    clip: await rect('.rl-fd-tools [aria-label="Attach files"]'),
    mic: await rect('.rl-fd-tools [aria-label="Dictate"]'),
    talk: await rect(".rl-fs-talk"),
    start: await rect(".rl-fs-go"),
    title: await rect(".rl-fs-title"),
    strip: await rect(".rl-flow-strip"),
    step1: await rect(".rl-flow-strip li:first-child .rl-flow-strip-n"),
    step2: await rect(".rl-flow-strip li:nth-child(2) .rl-flow-strip-n"),
  };
  report.measurements.aurora = m;
  check("4a stage: the stand-in shell puts the stage where the board has it (253 × 47 chrome, 1027 × 753 stage)", boxMatches(m.stage, { x: 266, y: 103, w: 1027, h: 753 }), m.stage);
  check("4a composer: 662 × 156 painted (660 + hairline), centred on the stage, at the board's y — ±1px", boxMatches(m.composer, BOARD.composer), { got: m.composer, want: BOARD.composer });
  check("4a headline: its 49px line box sits 26 above the composer", near(m.title.y + m.title.h + 26, m.composer.y) && near(m.title.h, 49), { title: m.title, composer: m.composer });
  check("4a mode track: 34 tall at the composer's 14/12 inset, ±1px", boxMatches(m.track, BOARD.track, ["x", "y", "h"]), { got: m.track, want: BOARD.track });
  check("4a Plan segment: 26 tall inside the 3px track, ±1px", boxMatches(m.plan, BOARD.plan, ["y", "h"]) && near(m.plan.x + m.plan.w, BOARD.plan.x + BOARD.plan.w - DX, 2), { got: m.plan, want: BOARD.plan });
  check("4a prompt: 64 tall (18 + 24 + 22) under the 46px first row", near(m.prompt.h, 64) && near(m.prompt.y, m.composer.y + 1 + 46), m.prompt);
  check("4a chips: 30 tall on the board's row, folder first at the composer's 12px inset", boxMatches(m.folder, BOARD.folder, ["x", "y", "h"]) && boxMatches(m.model, BOARD.model, ["y", "h"]) && m.folder.x < m.model.x && near(m.model.x, m.folder.x + m.folder.w + 6), { folder: m.folder, model: m.model });
  check("4a Start plan: 32 tall, its right edge 12 inside the composer, ±1px", boxMatches(m.start, BOARD.start, ["y", "h"]) && near(m.start.x + m.start.w, BOARD.start.x + BOARD.start.w - DX, 1), { got: m.start, want: BOARD.start });
  check("4a 📎 and the mic: 30px, ahead of Start", near(m.clip.w, 30) && near(m.clip.h, 30) && near(m.mic.w, 30) && m.clip.x < m.mic.x && m.talk.x + m.talk.w <= m.start.x - 5, { clip: m.clip, mic: m.mic, talk: m.talk, start: m.start });
  check("4a strip: 18px circles 26 below the composer, centred, ±1px", boxMatches(m.step1, BOARD.step1, ["y", "w", "h"]) && near(m.strip.x + m.strip.w / 2, m.composer.x + m.composer.w / 2, 1), { step1: m.step1, strip: m.strip, want: BOARD.step1 });
  report.measurements.widthDeltas = Object.fromEntries(["folder", "model", "start"].map((k) => [k, +(m[k].w - BOARD[k].w).toFixed(2)]));

  // Type, radii and copy, cell by cell.
  const s = {
    title: await styles(".rl-fs-title", ["font-size", "font-weight", "font-family", "line-height", "letter-spacing", "color"]),
    composer: await styles(".rl-frontdoor-focus .rl-fd-island", ["border-radius", "box-shadow", "box-sizing", "width"]),
    track: await styles(".rl-fs-modes", ["padding-top", "border-radius", "background-color", "border-top-color"]),
    plan: await styles('.rl-fs-modes [data-mode="plan"]', ["height", "border-radius", "background-color", "color", "font-size"]),
    planIcon: await styles('.rl-fs-modes [data-mode="plan"] svg', ["color"]),
    chat: await styles('.rl-fs-modes [data-mode="chat"]', ["color"]),
    hint: await styles(".rl-fs-hint", ["font-size", "color"]),
    prompt: await styles(".rl-frontdoor-focus .rl-fd-input", ["font-size", "line-height", "padding-top", "padding-right", "padding-bottom", "padding-left", "color"]),
    chip: await styles('.rl-fd-tools [aria-label="Choose project"]', ["height", "border-radius", "background-color", "color", "font-size", "padding-left"]),
    chipIcon: await styles('.rl-fd-tools [aria-label="Choose project"] svg', ["color", "width"]),
    lastUsed: await styles(".rl-fs-lastused", ["color"]),
    clip: await styles('.rl-fd-tools [aria-label="Attach files"]', ["color"]),
    start: await styles(".rl-fs-go", ["height", "border-radius", "background-color", "color", "font-weight", "font-size"]),
    strip: await styles(".rl-flow-strip", ["font-size", "color", "gap"]),
    step1: await styles(".rl-flow-strip li:first-child .rl-flow-strip-n", ["background-color", "color", "font-weight", "border-radius"]),
    step2: await styles(".rl-flow-strip li:nth-child(2) .rl-flow-strip-n", ["background-color"]),
  };
  report.measurements.styles = s;
  const t = Object.fromEntries(await Promise.all([
    ["ink", "color-ink"], ["ink2", "color-ink-2"], ["ink3", "color-ink-3"], ["ink4", "color-ink-4"], ["paper", "color-paper"], ["canvas", "color-canvas"], ["rule", "color-rule"],
    ["fill1", "color-fill-1"], ["fill3", "color-fill-3"], ["focus", "color-focus-rim"], ["planBg", "color-mode-plan-bg"], ["planFg", "color-mode-plan-fg"],
  ].map(async ([k, name]) => [k, await token(name)])));
  report.measurements.tokens = t;
  check("4a headline: serif 36px / 600, the ink, verbatim", s.title["font-size"] === "36px" && s.title["font-weight"] === "600" && /serif/i.test(s.title["font-family"]) && s.title.color === t.ink && await cdp.evaluate("document.querySelector('.rl-fs-title').textContent === 'What are we working on?'"), s.title);
  check("4a composer: r16, the focus rim, the sheet's 0 20px 60px shadow, 660 content box", s.composer["border-radius"] === "16px" && s.composer["box-shadow"].includes(t.focus) && /0px 20px 60px/.test(s.composer["box-shadow"]) && s.composer["box-sizing"] === "content-box" && s.composer.width === "660px", s.composer);
  check("4a mode track: 3px padding, r9, the window's colour, a hairline", s.track["padding-top"] === "3px" && s.track["border-radius"] === "9px" && s.track["background-color"] === t.canvas && s.track["border-top-color"] === t.rule, s.track);
  check("4a Plan, chosen: 26px r6 on the plan tint with a blue icon, 12.5px", s.plan.height === "26px" && s.plan["border-radius"] === "6px" && s.plan["background-color"] === t.planBg && s.planIcon.color === t.planFg && s.plan.color === t.ink && s.plan["font-size"] === "12.5px" && s.chat.color === t.ink3, { plan: s.plan, icon: s.planIcon, chat: s.chat });
  check("4a hint: 12px muted, verbatim", s.hint["font-size"] === "12px" && s.hint.color === t.ink4 && await cdp.evaluate("document.querySelector('.rl-fs-hint').textContent === 'Claude writes a plan for you to redline before anything is built.'"), s.hint);
  check("4a prompt: 16/1.5, padding 18 18 22", s.prompt["font-size"] === "16px" && s.prompt["line-height"] === "24px" && s.prompt["padding-top"] === "18px" && s.prompt["padding-right"] === "18px" && s.prompt["padding-bottom"] === "22px" && s.prompt["padding-left"] === "18px" && s.prompt.color === t.ink, s.prompt);
  check("4a chips: 30px r8 on the chip fill, secondary ink, muted 13px icons", s.chip.height === "30px" && s.chip["border-radius"] === "8px" && s.chip["background-color"] === t.fill1 && s.chip.color === t.ink3 && s.chip["font-size"] === "12.5px" && s.chip["padding-left"] === "10px" && s.chipIcon.color === t.ink4 && s.chipIcon.width === "13px" && s.lastUsed.color === t.ink4 && s.clip.color === t.ink4, { chip: s.chip, icon: s.chipIcon, lastUsed: s.lastUsed, clip: s.clip });
  check("4a chips: copy verbatim — \"~/projects/din\" first, then \"Opus 4.5 · High · last used\"", await cdp.evaluate("(() => { const t = [...document.querySelectorAll('.rl-fd-tools .rl-composer-chip')].map(c => c.textContent.trim()); return t[0] === '~/projects/din' && t[1] === 'Opus 4.5 · High· last used'; })()"), await cdp.evaluate("[...document.querySelectorAll('.rl-fd-tools .rl-composer-chip')].map(c => c.textContent)"));
  check("4a Start plan ↵: 32px r9, ink-filled, 600, verbatim", s.start.height === "32px" && s.start["border-radius"] === "9px" && s.start["background-color"] === t.ink && s.start.color === t.paper && s.start["font-weight"] === "600" && s.start["font-size"] === "12.5px" && await cdp.evaluate("document.querySelector('.rl-fs-go').textContent === 'Start plan↵'"), s.start);
  check("4a strip: 12.5px muted, 18 apart, step 1 in the plan blue, the rest on the chip fill, verbatim", s.strip["font-size"] === "12.5px" && s.strip.color === t.ink4 && s.strip.gap === "18px" && s.step1["background-color"] === t.planBg && s.step1.color === t.planFg && s.step1["font-weight"] === "700" && s.step1["border-radius"] === "50%" && s.step2["background-color"] === t.fill1 && await cdp.evaluate("[...document.querySelectorAll('.rl-flow-strip li')].map(l => l.textContent).join('|') === '1Ask|2Claude plans|3You redline|4Build' && document.querySelector('.rl-flow-strip [aria-current=step]').textContent === '1Ask'"), { strip: s.strip, step1: s.step1, step2: s.step2 });
  check("4a: no recents, no pill, no tour on the start screen", await cdp.evaluate("!document.querySelector('[aria-label=\"Jump back in\"]') && getComputedStyle(document.querySelector('.rl-monochat-notch')).visibility === 'hidden' && !document.querySelector('[data-tour-step], .rl-tour')"));
  check("4a: the resting start screen takes no caret", await cdp.evaluate("document.activeElement === document.body"));

  // ── The focus zoom, unchanged in flow ──────────────────────────────────
  const restBox = await rect(".rl-frontdoor-focus .rl-fd-island");
  const at = await centre(".rl-frontdoor-focus .rl-fd-input");
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at });
  await delay(150);
  const held = await rect(".rl-frontdoor-focus .rl-fd-island");
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...at });
  await delay(1000); await settle();
  const zoomed = await cdp.evaluate("(() => { const l = document.querySelector('.rl-frontdoor-focus'), d = l.querySelector('.rl-frontdoor').getBoundingClientRect(), look = (s) => { const e = document.querySelector(s), st = getComputedStyle(e); return [Number(st.opacity), st.visibility]; }; return { zoom: l.hasAttribute('data-zoom'), open: l.dataset.open, cx: d.x + d.width / 2, cy: d.y + d.height / 2, caret: document.activeElement === l.querySelector('.rl-fd-input'), title: look('.rl-fs-title'), foot: look('.rl-fs-foot'), paper: Number(getComputedStyle(l, '::before').opacity) }; })()");
  check("zoom: the box never moves under the held press", near(held.x, restBox.x, 0.5) && near(held.y, restBox.y, 0.5), { restBox, held });
  check("zoom: a press in the box zooms — the caret in it, everything else receded, the paper over the window", zoomed.zoom && zoomed.open === "true" && zoomed.caret && zoomed.title[0] === 0 && zoomed.title[1] === "hidden" && zoomed.foot[0] === 0 && zoomed.foot[1] === "hidden" && zoomed.paper === 1, zoomed);
  check("zoom: and the door ends centred in the window", near(zoomed.cx, 640) && near(zoomed.cy, 400), zoomed);
  await screenshot("aurora-4a-zoomed");
  await key("Escape", "Escape", 27); await delay(700); await settle();
  const back = await cdp.evaluate("(() => { const l = document.querySelector('.rl-frontdoor-focus'); return { zoom: l.hasAttribute('data-zoom'), open: l.dataset.open, title: Number(getComputedStyle(document.querySelector('.rl-fs-title')).opacity), strip: Number(getComputedStyle(document.querySelector('.rl-fs-foot')).opacity) }; })()");
  const backBox = await rect(".rl-frontdoor-focus .rl-fd-island");
  check("zoom: Esc brings the box home and the welcome back", !back.zoom && back.open === "false" && back.title === 1 && back.strip === 1 && near(backBox.x, restBox.x) && near(backBox.y, restBox.y), { back, backBox, restBox });
  await cdp.evaluate("window.dispatchEvent(new Event('redline:open-front-door'))"); await delay(1000); await settle();
  check("zoom: a keyboard summons arrives zoomed, the caret in the box", await cdp.evaluate("(() => { const l = document.querySelector('.rl-frontdoor-focus'); return l.hasAttribute('data-zoom') && l.dataset.open === 'true' && document.activeElement === l.querySelector('.rl-fd-input'); })()"));
  await press({ x: 120, y: 700 }); await delay(700); await settle();
  check("zoom: a tap outside the box dismisses, back to rest", await cdp.evaluate("(() => { const l = document.querySelector('.rl-frontdoor-focus'); return l.dataset.open === 'false' && !l.hasAttribute('data-zoom') && l.hasAttribute('data-landed'); })()"));

  // ── Start, pressed at rest: it launches where it is ────────────────────
  await press(await centre(".rl-fs-go")); await delay(400); await settle();
  check("Start pressed on the resting screen launches the plan without zooming the door first", await cdp.evaluate("window.__qa.launched() === 'plan' && document.querySelector('.rl-frontdoor-focus').dataset.open === 'false' && !document.querySelector('.rl-frontdoor-focus').hasAttribute('data-zoom')"));
  await cdp.evaluate(`window.__qa.setText(${JSON.stringify(SENTENCE)})`); await settle();

  // ── The modes, ⌘↩ and the keyboard ─────────────────────────────────────
  await press(await centre('.rl-fs-modes [data-mode="chat"]')); await delay(900); await key("Escape", "Escape", 27); await delay(600); await settle();
  check("Chat: its own hint, \"Start chat ↵\", a chat placeholder", await cdp.evaluate("document.querySelector('.rl-fs-modes [data-mode=chat]').getAttribute('aria-checked') === 'true' && document.querySelector('.rl-fs-hint').textContent.startsWith('Think it through with Claude.') && document.querySelector('.rl-fs-go').textContent === 'Start chat↵'"));
  await screenshot("aurora-4a-chat");
  await cdp.evaluate("document.querySelector('.rl-fs-modes [data-mode=chat]').focus()"); await key("ArrowRight", "ArrowRight", 39);
  check("Chat | Plan is a radio group: an arrow moves the choice and the focus", await cdp.evaluate("document.querySelector('.rl-fs-modes [data-mode=plan]').getAttribute('aria-checked') === 'true' && document.activeElement === document.querySelector('.rl-fs-modes [data-mode=plan]')"));
  await cdp.evaluate("document.querySelector('.rl-frontdoor-focus .rl-fd-input').focus()"); await delay(900);
  await key("Enter", "Enter", 13, 4 /* Meta */); await delay(300);
  check("⌘↩ runs it directly (the Run destination left the door for the key)", await cdp.evaluate("window.__qa.launched() === 'run'"), await cdp.evaluate("window.__qa.launched()"));
  await key("Escape", "Escape", 27); await delay(600);

  // ── Squeezed: the narrowest window, and short stages ───────────────────
  // 900 is the app's minimum width (tauri.conf): the stage is 647 wide and the
  // composer gives way to it, the model chip first; a short stage sheds the
  // headline, then the strip, before the box would leave it.
  for (const [width, height] of [[900, 640], [1280, 520], [1280, 400]]) {
    await cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await load(`text=${encodeURIComponent(SENTENCE)}`);
    await screenshot(`aurora-4a-${width}x${height}`);
    const fit = await cdp.evaluate(`(() => { const stage = document.querySelector('.qa-stage').getBoundingClientRect(), box = document.querySelector('.rl-frontdoor-focus .rl-fd-island').getBoundingClientRect(), tools = document.querySelector('.rl-frontdoor-focus .rl-fd-tools'), go = document.querySelector('.rl-fs-go').getBoundingClientRect(), shown = (s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility === 'visible'; }; return { rest: document.querySelector('.rl-frontdoor-focus').dataset.rest, inside: box.left >= stage.left - 1 && box.right <= stage.right + 1 && box.top >= stage.top - 1 && box.bottom <= stage.bottom + 1, goInside: go.right <= box.right - 11, overflow: tools.scrollWidth - tools.clientWidth, title: shown('.rl-fs-title'), strip: shown('.rl-fs-foot') }; })()`);
    if (width === 900) {
      const chip = await cdp.evaluate("(() => { const c = document.querySelector('.rl-fd-tools [title^=\"⏎ launches\"]'), line = c.querySelector('span'), last = line.querySelector('.rl-fs-lastused'), range = document.createRange(); range.selectNodeContents(line.firstChild); const name = range.getBoundingClientRect(), box = line.getBoundingClientRect(); return { chip: c.getBoundingClientRect().width, line: [box.left, box.right, line.scrollWidth, line.clientWidth], name: [name.left, name.right], last: last.getBoundingClientRect().left }; })()");
      report.measurements.narrowModelChip = chip;
      check("900 wide: \"last used\" gives way before the model's name does", chip.name[1] <= chip.line[1] - 8, chip);
    }
    const want = height >= 47 + 480 ? { title: true, strip: true } : height >= 47 + 360 ? { title: false, strip: true } : { title: false, strip: false };
    check(`${width}×${height}: the composer stays inside the stage, Start in full, nothing scrolls sideways; the welcome sheds as the stage shortens`, fit.inside && fit.goInside && fit.overflow <= 0 && fit.title === want.title && fit.strip === want.strip, { fit, want });
  }
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  // ── The first-run checklist and Continue links, three themes ───────────
  for (const theme of ["aurora", "basic", "studio"]) {
    await load(`theme=${theme}&text=${encodeURIComponent(SENTENCE)}`);
    const plain = await screenshot(`${theme}-4a`);
    if (theme !== "aurora") await sideBySide(plain, `${theme}-4a-vs-board.png`);
    await load(`theme=${theme}&checklist=1&continues=1`);
    await screenshot(`${theme}-4a-checklist`);
    const orbit = await cdp.evaluate("(() => { const o = document.querySelector('.rl-fs-orbit').getBoundingClientRect(), f = document.querySelector('.rl-fs-foot').getBoundingClientRect(), s = document.querySelector('.qa-stage').getBoundingClientRect(); return { top: o.top, bottom: o.bottom, foot: f.bottom, stage: s.bottom, rows: document.querySelectorAll('.rl-fs-check').length, fixes: [...document.querySelectorAll('.rl-fs-check')].map(r => r.querySelector('button')?.textContent ?? ''), links: [...document.querySelectorAll('.rl-fs-continue button')].map(b => b.textContent) }; })()");
    check(`${theme}: the checklist hangs below the strip, every blocker with its fix, inside the stage`, orbit.top >= orbit.foot && orbit.bottom <= orbit.stage && orbit.rows === 3 && orbit.fixes.every(Boolean), orbit);
    check(`${theme}: two Continue links to the sessions still in review`, orbit.links.join("|") === "Continue Din retrieval plan|Continue Din backend: Hono + Fly", orbit.links);
    const box = await rect(".rl-frontdoor-focus .rl-fd-island");
    check(`${theme}: the checklist never moves the composer`, boxMatches(box, { ...BOARD.composer }, ["x", "y"]), box);
    await press(await centre(".rl-fs-continue button")); await settle();
    check(`${theme}: a Continue link opens its session without taking the door`, await cdp.evaluate("window.__qa.continued() === 's1' && document.querySelector('.rl-frontdoor-focus').dataset.open === 'false'"));
    const sweep = await cdp.evaluate("window.__qaContrast('.rl-frontdoor-focus', 'canvas')");
    const short = sweep.filter((x) => x.ratio < x.min);
    report.contrast[theme] = { checked: sweep.length, min: Math.min(...sweep.map((x) => x.ratio)).toFixed(2), short };
    check(`${theme}: every text reaches 4.5:1 and every bare icon 3:1`, sweep.length > 20 && short.length === 0, { checked: sweep.length, short });
  }
} catch (error) { report.errors.push(error.stack ?? String(error)); }
finally {
  report.finishedAt = new Date().toISOString(); report.passed = report.checks.every((c) => c.passed) && report.errors.length === 0;
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  cdp?.close(); chrome?.kill(); await server?.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failed: report.checks.filter((c) => !c.passed).map((c) => c.name), errors: report.errors, output }, null, 2)); if (!report.passed) process.exitCode = 1;
}
