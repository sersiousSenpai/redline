#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// The flow conversation's fidelity check (BRIEF gate 5): the real
// SessionConversation / SessionComposer / AskCard in a stand-in shell sized
// like the boards, fed scripted ConvoEvents through a synthetic Tauri
// boundary (fixtures/flow-convo-qa), driven by headless Chrome over CDP.
//
// Every fidelity-spec cell this lane owns is measured from the DOM against
// the board: 4b and 4c positions come from the design HTML's box model and
// were checked against pixel scans of b4b.png / b4c.png (frame origins
// (10,56) and (12,56) in those PNGs). Sizes, radii and type within ±1px,
// copy verbatim, colours resolved from their mapped tokens. Then the same
// states in `basic` (light) and `studio`, and every text over every theme at
// 4.5:1 (icon-only controls and status glyphs at 3:1).
//
//   node scripts/flow-convo-visual-qa.mjs [outputDir]   (default docs/flow-qa/convo-ui)
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, process.argv[2] ?? "docs/flow-qa/convo-ui");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-flow-convo-qa-"));
const service = path.join(root, "fixtures/flow-convo-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  startedAt: new Date().toISOString(),
  fixture: "fixtures/flow-convo-qa",
  screenshots: [],
  checks: [],
  fidelity: [],
  errors: [],
  sourceSha256: {},
  limitations: [
    "Headless Chrome component fixture: not WKWebView, and the shell around the conversation is a stand-in sized like the boards.",
    "Real conversation, composer, ask cards, menus and themes. Synthetic Tauri responses and scripted ConvoEvents; no live CLI, engine or database.",
  ],
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
      else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error" && !/favicon/.test(msg.params.entry.text)) report.errors.push(msg.params.entry.text);
    });
  }
  async call(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((resolve, reject) => { const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000); this.pending.set(id, { resolve, reject, timeout }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; }
  close() { this.ws.close(); }
}

function check(name, passed, details) { report.checks.push({ name, passed: !!passed, details }); if (!passed) console.error(`FAIL ${name}`, JSON.stringify(details)); }
/** One fidelity-spec cell: `actual` against `expected`, numbers within ±1. */
function cell(board, name, actual, expected, tolerance = 1) {
  const pass = typeof expected === "number" ? typeof actual === "number" && Math.abs(actual - expected) <= tolerance : actual === expected;
  report.fidelity.push({ board, cell: name, expected, actual, pass });
  if (!pass) console.error(`FIDELITY ${board} ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function settle() { await cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"); await delay(80); }
async function click(selector) {
  const point = await cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('Missing selector: ' + ${JSON.stringify(selector)}); e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  await settle();
}
async function key(key, code = key, virtual = 0, modifiers = 0) { await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtual, modifiers }); await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtual, modifiers }); await settle(); }
async function type(text) { await cdp.call("Input.insertText", { text }); await settle(); }
async function screenshot(name) { const shot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); const file = `${name}.png`; await writeFile(path.join(output, file), Buffer.from(shot.data, "base64")); report.screenshots.push(file); }
async function open(board, theme = "aurora", size = board === "panel" ? [1600, 960] : [1280, 800]) {
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: `${report.fixtureUrl}?board=${board}&theme=${theme}` });
  for (let i = 0; i < 200; i++) { if (await cdp.evaluate("document.documentElement.dataset.qaReady === 'true' && !!document.querySelector('.rl-convo-composer') && document.querySelectorAll('.rl-convo-bubble').length > 0").catch(() => false)) break; await delay(50); }
  await cdp.evaluate("document.fonts.ready.then(() => true)");
  await settle(); await delay(150);
}
/** A rect, rounded to 0.01px. */
const rect = (selector, i = 0) => cdp.evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${i}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2) }; })()`);
const style = (selector, props, i = 0, pseudo = null) => cdp.evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${i}]; if (!e) return null; const s = getComputedStyle(e, ${JSON.stringify(pseudo)}); return Object.fromEntries(${JSON.stringify(props)}.map(p => [p, s.getPropertyValue(p)])); })()`);
const text = (selector, i = 0) => cdp.evaluate(`(document.querySelectorAll(${JSON.stringify(selector)})[${i}]?.textContent ?? null)`);
/** A token, as the browser resolves it to a colour. */
const token = (name) => cdp.evaluate(`(() => { const p = document.createElement('i'); p.style.color = 'var(--color-${name})'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`);
const calls = (command) => cdp.evaluate(`(window.__qaCalls ?? []).filter(c => c.command === ${JSON.stringify(command)}).map(c => c.args)`);
const px = (value) => parseFloat(value);

// Every visible text in a subtree, with its WCAG contrast on what it is
// painted on (the monochat sweep): layers composited down to the base.
const contrastSweep = `window.__qaContrast = (rootSelector, base) => {
  const probe = document.createElement('i'); document.body.append(probe);
  const rgba = (css) => { probe.style.color = ''; probe.style.color = css; const c = getComputedStyle(probe).color; let m = /^rgba?\\(([^)]+)\\)$/.exec(c); if (m) { const p = m[1].split(/[\\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; } m = /^color\\(srgb ([^)]+)\\)$/.exec(c); if (m) { const p = m[1].split(/[\\s/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; } return [0, 0, 0, 0]; };
  const over = (t, u) => { const a = t[3] + u[3] * (1 - t[3]); return a === 0 ? [0, 0, 0, 0] : [0, 1, 2].map(i => (t[i] * t[3] + u[i] * u[3] * (1 - t[3])) / a).concat(a); };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const baseColor = rgba('var(--color-' + base + ')');
  const background = (el) => { const layers = []; for (let n = el; n && n !== document.documentElement; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } } let bg = baseColor; for (const l of layers.reverse()) bg = over(l, bg); return bg; };
  const visible = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); if (!r.width || !r.height || s.visibility !== 'visible' || el.closest('[aria-hidden=true]:not(svg), [hidden]')) return false; let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o >= 0.99; };
  const out = [];
  for (const el of document.querySelectorAll(rootSelector + ' *')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    if (!visible(el)) continue;
    const s = getComputedStyle(el); const bg = background(el);
    if (el.tagName.toLowerCase() === 'svg') { out.push({ text: 'icon in ' + (el.parentElement.getAttribute('aria-label') || el.parentElement.className || el.parentElement.tagName).toString().slice(0, 40), icon: true, ratio: ratio(over(rgba(s.color), bg), bg) }); continue; }
    const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join(' ');
    if (own) out.push({ text: own.slice(0, 40), ratio: ratio(over(rgba(s.color), bg), bg) });
    if ((el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && el.placeholder && !el.value) out.push({ text: 'placeholder: ' + el.placeholder, ratio: ratio(over(rgba(getComputedStyle(el, '::placeholder').color), bg), bg) });
  }
  probe.remove(); return out;
}`;
const smallTargets = (rootSelector) => cdp.evaluate(`[...document.querySelectorAll(${JSON.stringify(rootSelector)} + ' :is(button, a[href], input, [role=button])')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && getComputedStyle(e).visibility === 'visible' && !e.closest('[aria-hidden=true], [hidden]') && (r.width < 24 || r.height < 24); }).map(e => (e.getAttribute('aria-label') || e.textContent.trim()).slice(0, 24) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))`);

try {
  await mkdir(output, { recursive: true });
  for (const file of ["src/shell/SessionConversation.tsx", "src/shell/SessionComposer.tsx", "src/shell/AskCard.tsx", "src/shell/conversation.css", "src/lib/convo/reducer.ts", "src/lib/convo/status.ts", "src/lib/convo/readiness.ts"])
    report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  server = await createServer({
    configFile: false, root, cacheDir: path.join(temporary, "vite-cache"),
    optimizeDeps: { entries: ["fixtures/flow-convo-qa/index.html"] },
    plugins: [react(), tailwindcss()],
    resolve: { alias: ["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/webview", "@tauri-apps/api/window", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener"].map((find) => ({ find, replacement: service })) },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null }, clearScreen: false,
  });
  await server.listen();
  report.fixtureUrl = `http://127.0.0.1:${server.httpServer.address().port}/fixtures/flow-convo-qa/`;
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--user-data-dir=${path.join(temporary, "chrome-profile")}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-extensions", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeLog = ""; chrome.stderr.on("data", (data) => { chromeLog += data; });
  let port;
  for (let i = 0; i < 150; i++) { try { port = (await readFile(path.join(temporary, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch {} await delay(100); }
  if (!port) throw new Error(`Chrome failed to start: ${chromeLog.slice(-3000)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new CDP(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Log.enable");
  report.browserVersion = (await cdp.call("Browser.getVersion")).product;
  await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });

  // ── 4b: Claude plans, mid-flight, on the stage ──
  await open("4b");
  await screenshot("4b-aurora");
  {
    const B = "4b";
    const composer = await rect(".rl-convo-composer");
    cell(B, "composer x (stage centred)", composer?.x, 406.5); cell(B, "composer y", composer?.y, 701);
    cell(B, "composer width 720", composer?.w, 720); cell(B, "composer height", composer?.h, 79);
    const cs = await style(".rl-convo-composer", ["border-top-left-radius", "padding-top", "padding-right", "padding-bottom", "padding-left", "--rl-glass-ring"]);
    cell(B, "composer radius 14", px(cs["border-top-left-radius"]), 14);
    cell(B, "composer padding 12/12/10/16", [cs["padding-top"], cs["padding-right"], cs["padding-bottom"], cs["padding-left"]].join(" "), "12px 12px 10px 16px");
    cell(B, "composer border = rule-strong", (await cdp.evaluate(`(() => { const p = document.createElement('i'); p.style.color = getComputedStyle(document.querySelector('.rl-convo-composer')).getPropertyValue('--rl-glass-ring'); document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`)), await token("rule-strong"));
    cell(B, "composer is the glass sheet", await cdp.evaluate("document.querySelector('.rl-convo-composer').matches('.rl-glass.rl-glass-sheet')"), true);
    const field = await style(".rl-convo-field", ["font-size"]);
    cell(B, "placeholder copy", await cdp.evaluate("document.querySelector('.rl-convo-field').placeholder"), "Add to the plan…");
    cell(B, "placeholder 14.5px", px(field["font-size"]), 14.5);
    const bubble = await rect(".rl-convo-bubble");
    const bs = await style(".rl-convo-bubble", ["padding-top", "padding-left", "border-top-left-radius", "background-color", "font-size", "line-height"]);
    cell(B, "bubble right-aligned (column right)", bubble?.right, 1126.5); cell(B, "bubble top (padding 36)", bubble?.y, 83);
    cell(B, "bubble height", bubble?.h, 44.75); cell(B, "bubble padding 10/14", `${bs["padding-top"]} ${bs["padding-left"]}`, "10px 14px");
    cell(B, "bubble radius 14", px(bs["border-top-left-radius"]), 14); cell(B, "bubble fill = fill-2", bs["background-color"], await token("fill-2"));
    cell(B, "conversation 15px", px(bs["font-size"]), 15); cell(B, "conversation line 1.65", px(bs["line-height"]), 24.75);
    cell(B, "bubble max 520 (content-box)", Object.values(await style(".rl-convo-bubble", ["max-width", "box-sizing"])).join(" ").includes("520px") && (await style(".rl-convo-bubble", ["box-sizing"]))["box-sizing"], "content-box");
    cell(B, "bubble copy", await text(".rl-convo-bubble"), "Read the obsidian build log and plan the next roadmap steps");
    const tool0 = await rect(".rl-convo-tool"), tool1 = await rect(".rl-convo-tool", 1);
    cell(B, "tool row 1 top (gap 22)", tool0?.y, 149.75); cell(B, "tool row height", tool0?.h, 21.45);
    cell(B, "tool row 2 top (gap 6)", tool1?.y, 177.2);
    const words = (i) => cdp.evaluate(`[...document.querySelectorAll('.rl-convo-tool')[${i}].children].filter(e => e.tagName !== 'svg').map(e => e.textContent).join(' ')`);
    cell(B, "tool row 1 copy", await words(0), "Read docs/obsidian/build-log.md");
    cell(B, "tool row 2 copy", await words(1), "Read docs/obsidian/28 Roadmap.md and 2 more");
    cell(B, "tool row parts 8px apart", await cdp.evaluate("(() => { const [, verb, target] = document.querySelectorAll('.rl-convo-tool')[0].children; return +(target.getBoundingClientRect().x - verb.getBoundingClientRect().right).toFixed(2); })()"), 8);
    const ts = await style(".rl-convo-tool", ["font-size", "color", "gap"]);
    cell(B, "tool rows 13px", px(ts["font-size"]), 13); cell(B, "tool verb muted = ink-4", ts.color, await token("ink-4"));
    cell(B, "tool target = ink-3", (await style(".rl-convo-tool-target", ["color"])).color, await token("ink-3"));
    cell(B, "tool ✓ green = mode-build-fg", (await style(".rl-convo-tool svg", ["color"])).color, await token("mode-build-fg"));
    cell(B, "tool ✓ 13px", (await rect(".rl-convo-tool svg"))?.w, 13);
    const prose = await rect(".rl-convo-prose");
    cell(B, "prose top (gap 12)", prose?.y, 210.65); cell(B, "prose two lines", prose?.h, 49.5);
    cell(B, "prose = ink-2 (prose ink)", (await style(".rl-convo-prose p", ["color"])).color, await token("ink-2"));
    cell(B, "prose 15px/1.65", (await style(".rl-convo-prose p", ["font-size", "line-height"])) && `${(await style(".rl-convo-prose p", ["font-size"]))["font-size"]} ${(await style(".rl-convo-prose p", ["line-height"]))["line-height"]}`, "15px 24.75px");
    const working = await rect(".rl-convo-working");
    cell(B, "working row top (gap 12)", working?.y, 272.15); cell(B, "working row height", working?.h, 21.45);
    cell(B, "working label", await text(".rl-convo-working-label"), "Writing the plan");
    cell(B, "working timer", await text(".rl-convo-elapsed"), "1m 12s");
    cell(B, "timer faint = ink-5", (await style(".rl-convo-elapsed", ["color"])).color, await token("ink-5"));
    cell(B, "working row 13px = ink-3", (await style(".rl-convo-working", ["color"])).color, await token("ink-3"));
    cell(B, "spinner blue = mode-plan-fg", (await style(".rl-convo-spinner", ["color"])).color, await token("mode-plan-fg"));
    cell(B, "spinner 13px", (await rect(".rl-convo-spinner"))?.w, 13);
    const stopText = await cdp.evaluate("(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('.rl-convo-stop')); const b = r.getBoundingClientRect(); return +b.right.toFixed(2); })()");
    cell(B, "Stop right-aligned", stopText, 1126.5);
    cell(B, "Stop = ink-4", (await style(".rl-convo-stop", ["color"])).color, await token("ink-4"));
    const chips = await cdp.evaluate("[...document.querySelectorAll('.rl-convo-chips > .rl-convo-chip')].map(e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return { text: e.textContent, x: +r.x.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), radius: s.borderTopLeftRadius, bg: s.backgroundColor, color: s.color, size: s.fontSize }; })");
    cell(B, "chip copy: Plan · model · folder", chips.slice(0, 3).map((c) => c.text).join(" | "), "Plan | Opus 4.5 · High | din");
    cell(B, "chips 26px", chips[0]?.h, 26); cell(B, "chips r7", px(chips[0]?.radius), 7); cell(B, "chips 12px", px(chips[0]?.size), 12);
    cell(B, "first chip at the composer's inset", chips[0]?.x, 423.5);
    cell(B, "chip gap 6", chips[1] && +(chips[1].x - chips[0].x - chips[0].w).toFixed(2), 6);
    cell(B, "chip fill = fill-1", chips[1]?.bg, await token("fill-1"));
    cell(B, "Plan chip blue = mode-plan-fg", chips[0]?.color, await token("mode-plan-fg"));
    cell(B, "model chip = ink-3", chips[1]?.color, await token("ink-3"));
    const send = await rect(".rl-convo-composer .rl-send");
    cell(B, "send 28px round", send?.w, 28); cell(B, "send right", send?.right, 1113.5);
    cell(B, "send radius round", (await style(".rl-convo-composer .rl-send", ["border-top-left-radius"]))["border-top-left-radius"], "999px");
    cell(B, "send at rest = fill-3 / ink-4", Object.values(await style(".rl-convo-composer .rl-send", ["background-color", "color"])).join(" "), `${await token("fill-3")} ${await token("ink-4")}`);
    check("4b: the conversation column is 720px, centred", (await rect(".rl-convo-list"))?.w === 720, await rect(".rl-convo-list"));
    check("4b: voice is one click away (mic + Talk on the composer)", await cdp.evaluate("!!document.querySelector('.rl-convo-mic') && !!document.querySelector('.rl-convo-talk')"));
  }
  for (const theme of ["basic", "studio"]) { await open("4b", theme); await screenshot(`4b-${theme}`); }

  // ── 4c: you redline; the chat column beside the plan ──
  await open("4c");
  await screenshot("4c-aurora");
  {
    const B = "4c";
    const b1 = await rect(".rl-convo-bubble"), bs = await style(".rl-convo-bubble", ["padding-top", "padding-left", "font-size", "line-height"]);
    cell(B, "column 440 (list width)", (await rect(".rl-convo-list"))?.w, 440);
    cell(B, "chat 14.5px / 1.6", `${bs["font-size"]} ${bs["line-height"]}`, "14.5px 23.2px");
    cell(B, "bubble right (padding 26)", b1?.right, 414); cell(B, "bubble top (padding 28)", b1?.y, 75);
    cell(B, "bubble wraps at 320 (346 with padding)", b1?.w, 346); cell(B, "bubble height (2 lines)", b1?.h, 64.4);
    cell(B, "bubble padding 9/13", `${bs["padding-top"]} ${bs["padding-left"]}`, "9px 13px");
    const summary = await rect(".rl-convo-summary");
    cell(B, "folded summary copy", await text(".rl-convo-summary span"), "Read 4 files · planned in 2m 04s");
    cell(B, "summary top (gap 18)", summary?.y, 157); cell(B, "summary height", summary?.h, 20);
    cell(B, "summary 12.5px = ink-4", Object.values(await style(".rl-convo-summary", ["font-size", "color"])).join(" "), `12.5px ${await token("ink-4")}`);
    cell(B, "summary ✓ 12px green", (await rect(".rl-convo-summary svg"))?.w, 12);
    cell(B, "no tool rows once folded", await cdp.evaluate("document.querySelectorAll('.rl-convo-tool').length"), 0);
    const card = await rect(".rl-convo-plan"), ps = await style(".rl-convo-plan", ["border-top-left-radius", "padding-top", "padding-left"]);
    cell(B, "plan card x", card?.x, 26); cell(B, "plan card top (gap 18)", card?.y, 195);
    cell(B, "plan card width", card?.w, 388); cell(B, "plan card height", card?.h, 103.2);
    cell(B, "plan card r12", px(ps["border-top-left-radius"]), 12); cell(B, "plan card padding 14", `${ps["padding-top"]} ${ps["padding-left"]}`, "14px 14px");
    cell(B, "plan card border = focus-rim", (await cdp.evaluate(`(() => { const p = document.createElement('i'); p.style.color = getComputedStyle(document.querySelector('.rl-convo-plan')).getPropertyValue('--rl-glass-ring'); document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`)), await token("focus-rim"));
    cell(B, "Plan ready 13.5/600", Object.values(await style(".rl-convo-plan-title", ["font-size", "font-weight"])).join(" "), "13.5px 600");
    cell(B, "Plan ready copy", await text(".rl-convo-plan-title"), "Plan ready");
    cell(B, "Open in panel copy", await text(".rl-convo-plan-open"), "Open in panel →");
    cell(B, "Open in panel 11.5px = ink-4", Object.values(await style(".rl-convo-plan-open", ["font-size", "color"])).join(" "), `11.5px ${await token("ink-4")}`);
    cell(B, "card body copy", await text(".rl-convo-plan-body"), "3 sections · 11 steps. Mark anything you'd change, then approve.");
    cell(B, "card body 13px = ink-3", Object.values(await style(".rl-convo-plan-body", ["font-size", "color"])).join(" "), `13px ${await token("ink-3")}`);
    const b2 = await rect(".rl-convo-bubble", 1);
    cell(B, "question bubble top (gap 18)", b2?.y, 316.2); cell(B, "question bubble height", b2?.h, 41.2); cell(B, "question bubble right", b2?.right, 414);
    cell(B, "answer prose top", (await rect(".rl-convo-prose"))?.y, 375.4);
    const composer = await rect(".rl-convo-composer"), cs = await style(".rl-convo-composer", ["padding-top", "padding-right", "padding-bottom", "padding-left"]);
    cell(B, "composer x (padding 18)", composer?.x, 18); cell(B, "composer width", composer?.w, 404);
    cell(B, "composer bottom (padding 18)", composer?.bottom, 782); cell(B, "composer height", composer?.h, 78);
    cell(B, "composer padding 11/12/10/14", Object.values(cs).join(" "), "11px 12px 10px 14px");
    cell(B, "placeholder copy", await cdp.evaluate("document.querySelector('.rl-convo-field').placeholder"), "Ask about the plan…");
    cell(B, "placeholder 14px", px((await style(".rl-convo-field", ["font-size"]))["font-size"]), 14);
    const chips = await cdp.evaluate("[...document.querySelectorAll('.rl-convo-chips > .rl-convo-chip')].map(e => ({ text: e.textContent, x: +e.getBoundingClientRect().x.toFixed(2), icon: !!e.querySelector('svg.rl-convo-chip-icon') }))");
    cell(B, "chips: Plan + model only (no folder)", chips.filter((c) => c.text !== "Talk").map((c) => c.text).join(" | "), "Plan | Opus 4.5 · High");
    cell(B, "model chip has no ✦ in the column", chips[1]?.icon, false);
    cell(B, "first chip at the composer's inset", chips[0]?.x, 33);
    const send = await rect(".rl-convo-composer .rl-send");
    cell(B, "send right", send?.right, 409);
    await click(".rl-convo-plan-open");
    check("4c: Open in panel → calls onOpenPlan", await cdp.evaluate("window.__qaOpened === 1"));
    await click(".rl-convo-summary");
    check("4c: the summary expands to the four reads it folded", await cdp.evaluate("document.querySelectorAll('.rl-convo-folded .rl-convo-tool').length === 2 && document.querySelector('.rl-convo-folded').textContent.includes('28 Roadmap.md') && document.querySelector('.rl-convo-folded').textContent.includes('and 2 more')"));
    await screenshot("4c-aurora-expanded");
  }
  for (const theme of ["basic", "studio"]) { await open("4c", theme); await screenshot(`4c-${theme}`); }

  // ── 4d: the plan closed; one inline line keeps it a click away ──
  await open("4d");
  await screenshot("4d-aurora");
  {
    const B = "4d";
    const inline = await rect(".rl-convo-inline-plan"), s = await style(".rl-convo-inline-plan", ["padding-top", "padding-left", "border-top-left-radius", "font-size", "--rl-glass-ring"]);
    cell(B, "inline card copy", await cdp.evaluate("[...document.querySelector('.rl-convo-inline-plan').children].map(e => e.textContent).filter(Boolean).join(' | ')"), "Plan · Din roadmap: next steps | 2 marks | Open");
    cell(B, "inline card padding 12/14", `${s["padding-top"]} ${s["padding-left"]}`, "12px 14px");
    cell(B, "inline card r12", px(s["border-top-left-radius"]), 12); cell(B, "inline card 13.5px", px(s["font-size"]), 13.5);
    cell(B, "inline card width = column", inline?.w, 720);
    cell(B, "Open = plan blue", (await style(".rl-convo-inline-open", ["color"])).color, await token("mode-plan-fg"));
    cell(B, "marks = ink-4", (await style(".rl-convo-inline-marks", ["color"])).color, await token("ink-4"));
    await click(".rl-convo-inline-plan");
    check("4d: the inline card opens the plan", await cdp.evaluate("window.__qaOpened === 1"));
  }

  // ── Asks: a permission and a question, open ──
  await open("asks");
  await screenshot("asks-aurora");
  {
    check("asks: the open question and permission show as cards, the answered one as a line", await cdp.evaluate("document.querySelectorAll('.rl-ask-card').length === 2 && [...document.querySelectorAll('.rl-convo-tool')].some(e => e.textContent === 'Allowednpm test')"));
    check("asks: the working row says Needs you", (await text(".rl-convo-working-label")) === "Needs you");
    check("asks: Always shows its rule", (await text(".rl-ask-rule")) === "Always: Always allow Bash(npm test:*) in this project");
    check("asks: cards are the glass sheet with the focus rim", await cdp.evaluate("[...document.querySelectorAll('.rl-ask-card')].every(e => e.matches('.rl-glass.rl-glass-sheet'))"));
    await click('.rl-ask-card[data-ask="permission"] .rl-ask-btn[data-primary]');
    check("asks: Allow once answers {kind: allow}", JSON.stringify((await calls("convo_answer_ask")).pop()) === JSON.stringify({ askId: "ask-3", answer: { kind: "allow" } }), await calls("convo_answer_ask"));
    await click('.rl-ask-card[data-ask="question"] .rl-ask-option');
    await click('.rl-ask-card[data-ask="question"] .rl-ask-options[aria-label="Anything else to check?"] .rl-ask-option');
    await click('.rl-ask-card[data-ask="question"] .rl-ask-options[aria-label="Anything else to check?"] input');
    await type("Lint");
    await click('.rl-ask-card[data-ask="question"] .rl-ask-btn[data-primary]');
    check("asks: a question answers its labels, multi-select comma-joined with free text", JSON.stringify((await calls("convo_answer_ask")).pop()) === JSON.stringify({ askId: "ask-2", answer: { kind: "answers", answers: { "Which failure should I fix first?": "sizeGuard", "Anything else to check?": "Contrast, Lint" } } }), (await calls("convo_answer_ask")).pop());
    await open("asks");
    await click('.rl-ask-card[data-ask="permission"] .rl-ask-terminal');
    check("asks: Answer in terminal releases the hook and shows the terminal", JSON.stringify((await calls("convo_answer_ask")).pop()?.answer) === JSON.stringify({ kind: "terminal" }) && (await cdp.evaluate("window.__qaTerminal")) === 1);
    await cdp.evaluate("window.__qa.push([{ id: 'host:20', epoch: 0, offset: 5000, ts: Date.now(), kind: 'ask_closed', askId: 'ask-3', outcome: 'terminal' }])"); await settle();
    check("asks: a closed ask leaves the end of the conversation", await cdp.evaluate("document.querySelectorAll('.rl-ask-card').length === 1"));
  }

  // ── The composer: sending, Stop, switching, queueing, undelivered ──
  await open("4b");
  {
    await click(".rl-convo-field"); await type("Also check the D3 crash reports"); await key("Enter", "Enter", 13);
    const expectArgs = (await calls("convo_expect")).pop(), submitArgs = (await calls("pty_submit")).pop();
    check("send: Enter announces then types into the PTY", expectArgs?.text === "Also check the D3 crash reports" && submitArgs?.text === "Also check the D3 crash reports" && expectArgs?.terminalId === "term-qa", { expectArgs, submitArgs });
    check("send: the optimistic bubble shows at once", await cdp.evaluate("[...document.querySelectorAll('.rl-convo-bubble')].some(e => e.textContent === 'Also check the D3 crash reports')"));
    await cdp.evaluate(`window.__qa.push([{ id: 'host:30', epoch: 0, offset: 30000, ts: Date.now(), kind: 'undelivered', nonce: ${JSON.stringify(expectArgs?.nonce)} }])`); await settle();
    check("send: undelivered reads Undelivered · Open Terminal", (await text('[data-delivery="undelivered"] .rl-convo-bubble-note')) === "Undelivered · Open Terminal");
    await screenshot("4b-undelivered");
    await click('[data-delivery="undelivered"] .rl-convo-bubble-note button');
    check("send: Open Terminal from an undelivered bubble", (await cdp.evaluate("window.__qaTerminal")) === 1);
    check("send: Stop replaces send on an empty box while working", await cdp.evaluate("document.querySelector('.rl-convo-composer .rl-send').dataset.send === 'stop'"));
    await click(".rl-convo-stop");
    check("stop: the working row's Stop interrupts the PTY", (await calls("pty_interrupt")).length === 1);
    await click(".rl-convo-composer .rl-send");
    check("stop: the composer's Stop interrupts too", (await calls("pty_interrupt")).length === 2);
    await click('.rl-convo-chip[data-mode]');
    check("mode chip opens its menu", await cdp.evaluate("!!document.querySelector('[role=menu][aria-label=Mode]')"));
    await screenshot("4b-mode-menu");
    await click('[role=menu][aria-label=Mode] [role=menuitemradio]:nth-of-type(2)');
    check("mode chip: a pick goes through convo_set_mode", JSON.stringify((await calls("convo_set_mode")).pop()) === JSON.stringify({ terminalId: "term-qa", mode: "default" }), await calls("convo_set_mode"));
    check("mode chip: a terminal-only answer says Switch in terminal", (await text(".rl-convo-hint")) === "Switch in terminal");
    await click('.rl-convo-chips > .rl-convo-chip:nth-of-type(2)');
    check("model chip opens the live catalog", await cdp.evaluate("[...document.querySelectorAll('[role=menu][aria-label=\"Model and effort\"] [role=menuitemradio]')].map(e => e.textContent).join(',').startsWith('Opus,Sonnet,Haiku')") && (await calls("model_catalog_snapshot")).length >= 1);
    await screenshot("4b-model-menu");
    await key("Escape", "Escape", 27);
    await click(".rl-convo-talk");
    check("Talk toggles the voice conversation", await cdp.evaluate("document.querySelector('.rl-convo-talk').getAttribute('aria-pressed') === 'true'"));
  }
  await open("queue");
  {
    check("queue: a blocked composer says why, with Open Terminal", (await text(".rl-convo-readiness"))?.startsWith("Claude is asking something in the terminal") && (await cdp.evaluate("!!document.querySelector('.rl-convo-readiness button')")));
    await click(".rl-convo-field"); await type("First, while blocked"); await key("Enter", "Enter", 13);
    await type("Second, while blocked"); await key("Enter", "Enter", 13);
    check("queue: sends wait in the tray, none typed", (await text(".rl-queue-count")) === "2 queued" && (await calls("pty_submit")).length === 0);
    await screenshot("queue-aurora");
    await cdp.evaluate("window.__qa.push([{ id: 'host:40', epoch: 0, offset: 30000, ts: Date.now(), kind: 'readiness', ready: true, blocker: null }])");
    for (let i = 0; i < 40 && (await calls("pty_submit")).length < 2; i++) await delay(50);
    await settle();
    check("queue: ready flushes them in order and empties the tray", JSON.stringify((await calls("pty_submit")).map((a) => a.text)) === JSON.stringify(["First, while blocked", "Second, while blocked"]) && !(await cdp.evaluate("!!document.querySelector('.rl-queue-pill')")), await calls("pty_submit"));
  }

  // ── 5a's right panel: the column's anatomy at 400px ──
  await open("panel");
  await screenshot("panel-aurora");
  {
    const list = await rect(".rl-convo-list"), panel = await rect(".qa-slot");
    check("panel: fills the 400px Chat tab without overflow", list && panel && Math.abs(list.w - panel.w) < 1 && (await cdp.evaluate("document.querySelector('.rl-convo-scroll').scrollWidth <= document.querySelector('.rl-convo-scroll').clientWidth")), { list, panel });
    check("panel: the Plan ready card shows while the plan is open", !!(await rect(".rl-convo-plan")));
  }

  // ── Contrast: every text, every theme; glyphs at 3:1 ──
  await cdp.evaluate(contrastSweep);
  const themes = await cdp.evaluate("import('/src/theme/themes.ts').then(m => m.THEMES.map(t => t.name))");
  const short = [], shortIcons = [];
  for (const board of ["4b", "4c", "asks", "queue"]) for (const theme of themes) {
    await open(board, theme); await cdp.evaluate(contrastSweep);
    for (const r of await cdp.evaluate("window.__qaContrast('.rl-convo, .rl-ask-card', 'canvas')")) {
      if (r.icon ? r.ratio < 3 : r.ratio < 4.5) (r.icon ? shortIcons : short).push(`${board} ${theme} ${r.text}: ${r.ratio.toFixed(2)}`);
    }
  }
  check(`contrast: every text reaches 4.5:1 in all ${themes.length} themes`, themes.length === 15 && short.length === 0, [...new Set(short)].slice(0, 40));
  check(`contrast: every icon reaches 3:1 in all ${themes.length} themes`, shortIcons.length === 0, [...new Set(shortIcons)].slice(0, 40));
  await open("4b"); check("targets: every control in the conversation is at least 24px", (await smallTargets(".rl-convo")).length === 0, await smallTargets(".rl-convo"));
  await open("asks"); check("targets: every control on an ask card is at least 24px", (await smallTargets(".rl-ask-card")).length === 0, await smallTargets(".rl-ask-card"));
  check("no horizontal page scroll", await cdp.evaluate("document.documentElement.scrollWidth <= innerWidth"));
} catch (error) { report.errors.push(String(error?.stack ?? error)); }
finally {
  report.finishedAt = new Date().toISOString();
  report.passed = !report.errors.length && report.checks.every((item) => item.passed) && report.fidelity.every((item) => item.pass);
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
  cdp?.close(); if (chrome) { chrome.kill("SIGTERM"); await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), delay(3000)]); if (chrome.exitCode === null) chrome.kill("SIGKILL"); }
  await server?.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failedChecks: report.checks.filter((item) => !item.passed).map((c) => c.name), fidelity: `${report.fidelity.filter((f) => f.pass).length}/${report.fidelity.length}`, failedCells: report.fidelity.filter((f) => !f.pass), errors: report.errors, screenshots: report.screenshots.length, output }, null, 2));
if (!report.passed) process.exitCode = 1;
