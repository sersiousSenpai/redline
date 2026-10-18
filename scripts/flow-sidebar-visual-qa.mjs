#!/usr/bin/env node
// Flow sidebar fidelity check (PLAN Wave C, step C2): the production
// SessionSidebar in its flow layout, in a vite fixture with synthetic Tauri
// services, driven by headless Chrome over CDP. Each board state (4a, 4b,
// 4d with its row menu, 5a) is measured against the geometry the design HTML
// renders, captured beside the board's own sidebar crop, then re-captured in
// a light theme (basic) and another dark one (studio) with a WCAG sweep.
//
//   node scripts/flow-sidebar-visual-qa.mjs [outputDir]
//
// The reference boards are read from $FLOW_BOARDS (default
// ../flow-design beside this worktree); without them the side-by-side
// composites are skipped and everything else still runs.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, process.argv[2] ?? "docs/flow-qa/sidebar");
const boards = path.resolve(process.env.FLOW_BOARDS ?? path.join(root, "../flow-design"));
const temporary = await mkdtemp(path.join(tmpdir(), "redline-flow-sidebar-qa-"));
const service = path.join(root, "fixtures/flow-sidebar-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  startedAt: new Date().toISOString(),
  fixture: "fixtures/flow-sidebar-qa",
  screenshots: [],
  checks: [],
  errors: [],
  sourceSha256: {},
  limitations: [
    "Headless Chrome component fixture: not WKWebView or the live app.",
    "Sessions, chats and launches are synthetic; the sidebar, row menu, grouping and themes are the production modules.",
    "Expected geometry is what the design HTML (flow.html) renders, measured in the same Chrome; board crops are the rendered PNGs.",
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
      else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") report.errors.push(msg.params.entry.text);
    });
  }
  async call(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((resolve, reject) => { const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000); this.pending.set(id, { resolve, reject, timeout }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; }
  close() { this.ws.close(); }
}

function check(name, passed, details) { report.checks.push({ name, passed: !!passed, details }); if (!passed) console.error(`FAIL ${name}`, JSON.stringify(details)); }
async function settle() { await cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"); await delay(60); }
async function centre(selector) { return cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing selector: '+${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`); }
async function mouse(type, point, extra = {}) { await cdp.call("Input.dispatchMouseEvent", { type, ...point, ...extra }); }
async function click(selector, button = "left") { const p = await centre(selector); await mouse("mouseMoved", p); await mouse("mousePressed", p, { button, clickCount: 1 }); await mouse("mouseReleased", p, { button, clickCount: 1 }); await settle(); }
async function key(key, code = key, virtual = 0, modifiers = 0, text) { await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtual, modifiers, ...(text ? { text } : {}) }); await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtual, modifiers }); await settle(); }
async function type(text) { await cdp.call("Input.insertText", { text }); await settle(); }
async function shot(name, clip) {
  const result = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(result.data, "base64"));
  report.screenshots.push(`${name}.png`);
  return result.data;
}
async function viewport(width, height) { await cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }); }
async function scene(name, theme = "aurora") {
  await cdp.evaluate(`window.__qa.setScene(${JSON.stringify(name)}); window.__qa.setTheme(${JSON.stringify(theme)})`);
  for (let i = 0; i < 100 && !(await cdp.evaluate(`document.documentElement.dataset.qaScene === ${JSON.stringify(name)} && !!document.querySelector('.rl-sb-row')`)); i++) await delay(50);
  await mouse("mouseMoved", { x: 900, y: 700 });
  await settle();
}

// What the design HTML renders for each board's sidebar, relative to the
// sidebar's top-left (measured from flow.html in this Chrome: its boxes are
// content-box, so the 232px column is 253 wide and an outlined button 36 tall).
const DESIGN = {
  "4a": { width: 253, newSession: [10, 12, 232, 34], plus: [20, 22, 14, 14], kbd: [213.6, 22.5, 18.4, 13], labels: [["DIN", 10, 60, 232, 19]],
    rows: [["Din backend: Hono + Fly", 10, 81, 232, 32], ["Din retrieval plan", 10, 115, 232, 32], ["Review status check", 10, 149, 232, 32]] },
  "4b": { width: 253, newSession: [10, 12, 232, 36], plus: [21, 23, 14, 14], kbd: [212.6, 23.5, 18.4, 13], labels: [["DIN", 10, 62, 232, 19]],
    rows: [["Din roadmap: next steps", 10, 83, 232, 32], ["Din backend: Hono + Fly", 10, 117, 232, 32], ["Din retrieval plan", 10, 151, 232, 32], ["Review status check", 10, 185, 232, 32]],
    activeDots: [218, 92, 14, 14] },
  "4d": { width: 253, newSession: [10, 12, 232, 36], plus: [21, 23, 14, 14], kbd: [212.6, 23.5, 18.4, 13], labels: [["DIN", 10, 62, 232, 19]],
    rows: [["Din roadmap: next steps", 10, 83, 232, 32], ["Din backend: Hono + Fly", 10, 117, 232, 32], ["Din retrieval plan", 10, 151, 232, 32], ["Review status check", 10, 185, 232, 32]],
    menu: [206, 104, 204, 153], items: [["Open plan", 213, 111, 190, 32], ["Rename", 213, 143, 190, 32], ["Archive", 213, 175, 190, 32], ["Delete plan", 213, 218, 190, 32]],
    rule: [217, 212, 182, 1], key: [381.8, 227.5, 11.3, 13], menuDots: [218, 126, 14, 14] },
  "5a": { width: 281, newSession: [10, 12, 260, 36], plus: [21, 23, 14, 14], kbd: [240.6, 23.5, 18.4, 13],
    labels: [["NEEDS YOU", 10, 64, 260, 19], ["BUILDING", 10, 135, 260, 19], ["IN REVIEW", 10, 344, 260, 19]],
    rows: [["Every vehicle gets a 3D model", 10, 85, 260, 34], ["Dialcrown: fastest credible launch", 10, 156, 260, 34], ["MachineOS \"Full Bore\" sprint", 10, 294, 260, 34],
      ["Component meshes from a splat", 10, 365, 260, 34], ["Foundation docs for gpu-harness", 10, 401, 260, 34], ["Skip the \"trust this folder\" prompt", 10, 437, 260, 34],
      ["Memory surface: kill the jank", 10, 473, 260, 34], ["Theme cull + light theme", 10, 509, 260, 34]],
    nest: [10, 156, 260, 136], versions: [["v1", 40, 190, 224, 24], ["v2", 40, 214, 224, 24], ["v3", 40, 238, 224, 24], ["v4 · latest", 40, 262, 224, 24]],
    more: ["Show 9 more", 10, 545, 260, 34], dot: [20, 98.5, 7, 7], tag: [213, 95.5, 47, 13], activeDots: [246, 166, 14, 14] },
};
// Where each board's sidebar sits in its PNG (the board's top-left, plus the
// 47px top bar), and how wide a crop shows it (4d also shows its row menu).
const CROPS = {
  "4a": { file: "b4a.png", x: 13, y: 103, width: 253, height: 747 },
  "4b": { file: "b4b.png", x: 10, y: 103, width: 253, height: 747 },
  "4d": { file: "b4d.png", x: 9, y: 103, width: 420, height: 747 },
  "5a": { file: "b5a.png", x: 13, y: 65, width: 281, height: 913 },
};
const near = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;
const rectNear = (got, want) => !!got && want.every((v, i) => near(got[i], v));

// Rects relative to the sidebar, plus the computed styles a fidelity cell
// names; and every token resolved, so a colour can be held to its token.
const MEASURE = `(() => {
  const side = document.querySelector('.rl-sb').getBoundingClientRect();
  const rel = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [r.x - side.x, r.y - side.y, r.width, r.height].map((n) => Math.round(n * 10) / 10); };
  const style = (e, ...props) => { if (!e) return null; const s = getComputedStyle(e); return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)])); };
  const probe = document.createElement('i'); document.body.append(probe);
  const token = (name) => { probe.style.color = 'var(--' + name + ')'; return getComputedStyle(probe).color; };
  const tokens = Object.fromEntries(['color-canvas','color-rule','color-fill-1','color-fill-2','color-fill-3','color-focus-rim','color-ink','color-ink-3','color-ink-4','color-ink-5','color-glass-2','color-mode-plan-fg','color-mode-redline-fg','color-mode-build-fg','color-mode-danger-fg','color-mode-danger-bg'].map((n) => [n, token(n)]));
  probe.remove();
  const neu = document.querySelector('.rl-sb-new');
  const rows = [...document.querySelectorAll('.rl-sb-item')].map((li) => {
    const row = li.querySelector('.rl-sb-row'), icon = li.querySelector('.rl-sb-icon > *'), dots = li.querySelector('.rl-sb-dots svg');
    return { title: li.querySelector('.rl-sb-title')?.textContent, li: rel(li), row: rel(row), icon: rel(icon), titleRect: rel(li.querySelector('.rl-sb-title')), dots: rel(dots), tag: rel(li.querySelector('.rl-sb-tag')),
      active: li.hasAttribute('data-active'), nest: li.hasAttribute('data-nest'), menu: li.hasAttribute('data-menu'),
      rowStyle: style(row, 'background-color', 'color', 'border-radius', 'font-size', 'box-shadow'), liStyle: style(li, 'background-color', 'border-radius'),
      iconColor: icon && getComputedStyle(icon).color, iconBg: icon && getComputedStyle(icon).backgroundColor, dotsColor: dots && getComputedStyle(dots).color, dotsOpacity: dots && getComputedStyle(li.querySelector('.rl-sb-dots')).opacity, spinning: !!li.querySelector('.rl-sb-row .rl-sb-spin') };
  });
  const labels = [...document.querySelectorAll('.rl-sb-label')].map((e) => ({ text: e.innerText.trim(), rect: rel(e), style: style(e, 'font-size', 'letter-spacing', 'color', 'text-transform'), add: rel(e.querySelector('.rl-sb-add')) }));
  const versions = [...document.querySelectorAll('.rl-sb-version')].map((e) => ({ text: e.firstChild.textContent, date: e.querySelector('span').textContent, rect: rel(e), style: style(e, 'background-color', 'color', 'font-size', 'border-radius'), current: e.getAttribute('aria-current') }));
  const folds = [...document.querySelectorAll('.rl-sb-fold')].map((e) => ({ text: e.textContent.trim(), rect: rel(e), style: style(e, 'font-size', 'color') }));
  const layer = document.querySelector('.rl-row-menu-layer');
  const menu = layer && { rect: rel(layer), surface: style(layer.firstElementChild, 'border-radius', 'padding-top', 'background-color'), glass: layer.firstElementChild.className,
    items: [...layer.querySelectorAll('.rl-row-menu-item')].map((e) => ({ text: e.querySelector('.rl-row-menu-label').textContent, rect: rel(e), style: style(e, 'background-color', 'color', 'border-radius', 'font-size'), icon: rel(e.querySelector('svg')), focused: document.activeElement === e })),
    rule: rel(layer.querySelector('.rl-row-menu-rule')), key: rel(layer.querySelector('.rl-row-menu-key')), keyText: layer.querySelector('.rl-row-menu-key')?.textContent };
  return { side: [side.width, side.height], sideStyle: style(document.querySelector('.rl-sb'), 'border-right-color', 'border-right-width'),
    newSession: { rect: rel(neu), plus: rel(neu.querySelector('svg')), kbd: rel(neu.querySelector('kbd')), style: style(neu, 'background-color', 'color', 'border-top-color', 'border-top-width', 'border-radius', 'font-size'), current: neu.getAttribute('aria-current') },
    labels, rows, versions, folds, menu, tokens };
})()`;

// Every visible text in a subtree with its WCAG contrast on what it is
// painted on (the monochat sweep), and the icon-only controls at 3:1.
const CONTRAST = `window.__qaContrast = (rootSelector, base) => {
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
    if (!r.width || !r.height || s.visibility !== 'visible' || el.closest('[aria-hidden=true], [disabled], [hidden]')) continue;
    let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); if (o < 0.99) continue;
    const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join(' ');
    const bg = background(el);
    if (own) out.push({ text: own.slice(0, 32), ratio: ratio(over(rgba(s.color), bg), bg) });
    if (el.tagName === 'INPUT' && el.value) out.push({ text: 'input: ' + el.value.slice(0, 24), ratio: ratio(over(rgba(s.color), bg), bg) });
  }
  const icons = [];
  for (const control of document.querySelectorAll(rootSelector + ' :is(.rl-sb-dots, .rl-sb-add)')) {
    let o = 1; for (let n = control; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); if (o < 0.99) continue;
    const bg = background(control);
    icons.push({ text: control.getAttribute('aria-label').slice(0, 32), ratio: ratio(over(rgba(getComputedStyle(control).color), bg), bg) });
  }
  probe.remove(); return { text: out, icons };
}`;
async function contrast(label, selector) {
  const result = await cdp.evaluate(`window.__qaContrast(${JSON.stringify(selector)}, 'canvas')`);
  const lowText = result.text.filter((t) => t.ratio < 4.5).map((t) => `${t.text} ${t.ratio.toFixed(2)}`);
  const lowIcons = result.icons.filter((t) => t.ratio < 3).map((t) => `${t.text} ${t.ratio.toFixed(2)}`);
  check(`${label}: every text ≥ 4.5:1 (${result.text.length} runs), every icon-only control ≥ 3:1 (${result.icons.length})`, result.text.length > 0 && !lowText.length && !lowIcons.length,
    { lowText, lowIcons, min: Math.min(...result.text.map((t) => t.ratio)).toFixed(2) });
}
async function smallTargets(label, selector) {
  const small = await cdp.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)} + ' :is(button, a[href], input, [role=button])')].filter(e => { const r = e.getBoundingClientRect(); let o = 1; for (let n = e; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return r.width > 0 && o > 0.01 && getComputedStyle(e).visibility === 'visible' && (r.width < 24 || r.height < 24); }).map(e => (e.getAttribute('aria-label') || e.textContent.trim()).slice(0, 24) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))`);
  check(`${label}: no control under 24 × 24`, small.length === 0, small);
}

function geometry(name, m) {
  const want = DESIGN[name];
  check(`${name}: sidebar is ${want.width}px wide with a 1px rule in --color-rule`, near(m.side[0], want.width) && m.sideStyle["border-right-width"] === "1px" && m.sideStyle["border-right-color"] === m.tokens["color-rule"], { side: m.side, style: m.sideStyle });
  check(`${name}: "+ New session ⌘N" at the board's rect, r8, 13px`, rectNear(m.newSession.rect, want.newSession) && rectNear(m.newSession.plus, want.plus) && rectNear(m.newSession.kbd, want.kbd) && m.newSession.style["border-radius"] === "8px" && m.newSession.style["font-size"] === "13px",
    { got: m.newSession, want: { rect: want.newSession, plus: want.plus, kbd: want.kbd } });
  const labels = m.labels.map((l) => [l.text, ...l.rect]);
  check(`${name}: group labels: copy, rects, 11px, .04em, uppercase, --color-ink-5`, want.labels.every(([text, ...rect], i) => labels[i]?.[0] === text && rectNear(labels[i].slice(1), rect)) && m.labels.every((l) => l.style["font-size"] === "11px" && l.style["letter-spacing"] === "0.44px" && l.style["text-transform"] === "uppercase" && l.style.color === m.tokens["color-ink-5"]),
    { got: m.labels.map((l) => [l.text, l.rect, l.style]), want: want.labels });
  const rows = m.rows.filter((r) => r.title !== undefined);
  check(`${name}: rows: copy, order, rects (r7, 13px)`, want.rows.every(([title, ...rect], i) => rows[i]?.title === title && rectNear(rows[i].row, rect)) && rows.every((r) => r.rowStyle["border-radius"] === "7px" && r.rowStyle["font-size"] === "13px"),
    { got: rows.map((r) => [r.title, r.row]), want: want.rows });
  check(`${name}: each row's icon 13px at x 20 (a 7px dot on Needs you), title at x 42 (36), centred`, rows.every((r) => {
    const dot = r.icon && r.icon[2] === 7;
    return near(r.icon[0], 20) && near(r.icon[1] + r.icon[3] / 2, r.row[1] + r.row[3] / 2) && near(r.titleRect[0], dot ? 36 : 42) && near(r.titleRect[3], 16) && (dot || near(r.icon[2], 13));
  }), rows.map((r) => [r.title, r.icon, r.titleRect]));
  check(`${name}: idle rows read --color-ink-3, their icons --color-ink-4, their ⋯ --color-ink-5`, rows.filter((r) => !r.active && !r.nest && !r.menu && r.icon[2] !== 7).every((r) => r.rowStyle.color === m.tokens["color-ink-3"] && r.iconColor === m.tokens["color-ink-4"] && r.dotsColor === m.tokens["color-ink-5"]),
    rows.map((r) => [r.title, r.rowStyle.color, r.iconColor, r.dotsColor]));
}

try {
  await mkdir(output, { recursive: true });
  for (const file of ["src/components/SessionSidebar.tsx", "src/shell/FlowSidebar.tsx", "src/shell/FlowSidebar.css", "src/components/RowMenu.tsx", "src/lib/sessionGroups.ts", "src/lib/sessionMode.ts"]) {
    report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
  server = await createServer({
    configFile: false, root, cacheDir: path.join(temporary, "vite-cache"),
    optimizeDeps: { entries: ["fixtures/flow-sidebar-qa/index.html"] },
    plugins: [react(), tailwindcss()],
    resolve: { alias: ["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/webview", "@tauri-apps/api/window", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener"].map((find) => ({ find, replacement: service })) },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null }, clearScreen: false,
  });
  await server.listen();
  report.fixtureUrl = `http://127.0.0.1:${server.httpServer.address().port}/fixtures/flow-sidebar-qa/`;
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--user-data-dir=${path.join(temporary, "chrome-profile")}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-extensions", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeLog = ""; chrome.stderr.on("data", (data) => { chromeLog += data; });
  let port;
  for (let i = 0; i < 150; i++) { try { port = (await readFile(path.join(temporary, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch {} await delay(100); }
  if (!port) throw new Error(`Chrome failed to start: ${chromeLog.slice(-3000)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new CDP(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Log.enable");
  report.browserVersion = (await cdp.call("Browser.getVersion")).product;
  // The spinner holds still for the captures; motion is not under test.
  await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await viewport(1280, 800);
  await cdp.call("Page.navigate", { url: report.fixtureUrl });
  for (let i = 0; i < 200 && !(await cdp.evaluate("!!window.__qa && !!document.querySelector('.rl-sb-row')")); i++) await delay(100);
  await cdp.evaluate(CONTRAST);
  const builds = {};

  // ── 4a: the start screen ──────────────────────────────────────────────
  await scene("4a");
  let m = await cdp.evaluate(MEASURE);
  geometry("4a", m);
  check("4a: New session is filled (--color-fill-2, ink, no rule) and current", m.newSession.style["background-color"] === m.tokens["color-fill-2"] && m.newSession.style.color === m.tokens["color-ink"] && m.newSession.style["border-top-width"] === "0px" && m.newSession.current === "page", m.newSession);
  check("4a: plans wear the doc icon, the chat the chat icon, and no row is open", await cdp.evaluate("(() => { const icons = [...document.querySelectorAll('.rl-sb-icon svg')].map(s => [...s.classList].find(c => c.startsWith('lucide-') && c !== 'lucide')); return JSON.stringify(icons) === JSON.stringify(['lucide-file-text','lucide-file-text','lucide-message-square']) && !document.querySelector('[data-active]'); })()"));
  builds["4a"] = await shot("4a-sidebar-aurora", { x: 0, y: 47, width: 253, height: 753 });
  await shot("4a-aurora");
  await contrast("4a aurora", ".rl-sb");
  await smallTargets("4a", ".rl-sb");

  // ── 4b: the active launch, working ─────────────────────────────────────
  await scene("4b");
  m = await cdp.evaluate(MEASURE);
  geometry("4b", m);
  const active = m.rows.find((r) => r.active);
  check("4b: New session is outlined (1px --color-rule, --color-ink-3) and not current", m.newSession.style["background-color"] === "rgba(0, 0, 0, 0)" && m.newSession.style["border-top-color"] === m.tokens["color-rule"] && m.newSession.style.color === m.tokens["color-ink-3"] && !m.newSession.current, m.newSession);
  check("4b: the active row: --color-fill-2, ink, a spinner in the plan blue, its ⋯ visible at the board's spot in --color-ink-4",
    active?.title === "Din roadmap: next steps" && active.rowStyle["background-color"] === m.tokens["color-fill-2"] && active.rowStyle.color === m.tokens["color-ink"] && active.spinning && active.iconColor === m.tokens["color-mode-plan-fg"] && rectNear(active.dots, DESIGN["4b"].activeDots) && active.dotsColor === m.tokens["color-ink-4"], active);
  builds["4b"] = await shot("4b-sidebar-aurora", { x: 0, y: 47, width: 253, height: 753 });
  await shot("4b-aurora");
  await contrast("4b aurora", ".rl-sb");

  // ── 4d: the row menu on "Din backend: Hono + Fly", the open row amber ──
  await scene("4d");
  await click('.rl-sb-item:nth-child(2) .rl-sb-dots');
  // The menu opens over its own ⋯, so the pointer that opened it rests on
  // Open plan; the board is drawn with it elsewhere.
  await mouse("mouseMoved", { x: 900, y: 700 });
  await settle();
  m = await cdp.evaluate(MEASURE);
  geometry("4d", m);
  const want = DESIGN["4d"];
  const redline = m.rows.find((r) => r.active);
  const target = m.rows.find((r) => r.menu);
  check("4d: the open row's icon is the amber pen (Redlining)", redline?.title === "Din roadmap: next steps" && redline.iconColor === m.tokens["color-mode-redline-fg"] && redline.rowStyle["background-color"] === m.tokens["color-fill-2"], redline);
  check("4d: the row under the menu: menu fill, an inset --color-focus-rim ring, ink, its ⋯ lit", target?.title === "Din backend: Hono + Fly" && target.rowStyle["background-color"] === m.tokens["color-glass-2"] && target.rowStyle["box-shadow"].includes(m.tokens["color-focus-rim"]) && target.rowStyle["box-shadow"].includes("inset") && target.rowStyle.color === m.tokens["color-ink"] && target.dotsColor === m.tokens["color-ink"] && rectNear(target.dots, want.menuDots), target);
  check("4d: the menu: 204 × 153 at the board's spot, glass menu tier, r12, 6px padding", rectNear(m.menu?.rect, want.menu) && /rl-glass rl-glass-menu/.test(m.menu.glass) && m.menu.surface["border-radius"] === "12px" && m.menu.surface["padding-top"] === "6px", { got: m.menu?.rect, want: want.menu, surface: m.menu?.surface });
  check("4d: menu rows: Open plan · Rename · Archive · rule · Delete plan, 190 × 32, r8, 13px, 14px icons at x+10",
    want.items.every(([text, ...rect], i) => m.menu.items[i]?.text === text && rectNear(m.menu.items[i].rect, rect) && near(m.menu.items[i].icon[0], rect[0] + 10) && near(m.menu.items[i].icon[2], 14)) && m.menu.items.every((it) => it.style["border-radius"] === "8px" && it.style["font-size"] === "13px") && rectNear(m.menu.rule, want.rule),
    { got: m.menu.items.map((it) => [it.text, it.rect, it.icon]), rule: m.menu.rule });
  const del = m.menu.items[3];
  check("4d: Delete plan is tinted (--color-mode-danger-fg on -bg) with ⌫ at the right", del.style["background-color"] === m.tokens["color-mode-danger-bg"] && del.style.color === m.tokens["color-mode-danger-fg"] && m.menu.keyText === "⌫" && rectNear(m.menu.key, want.key, 1.5), { del, key: m.menu.key, want: want.key });
  check("4d: a mouse-opened menu shows no focus ring, but its first item holds focus for the keyboard", m.menu.items[0].focused && m.menu.items[0].style["background-color"] === "rgba(0, 0, 0, 0)", m.menu.items[0]);
  builds["4d"] = await shot("4d-sidebar-aurora", { x: 0, y: 47, width: 420, height: 753 });
  await shot("4d-aurora");
  await contrast("4d menu aurora", ".rl-row-menu-layer");
  await contrast("4d sidebar aurora", ".rl-sb");
  // Keyboard: arrows move, Escape closes and hands focus back to the ⋯.
  await key("ArrowDown", "ArrowDown", 40);
  check("4d: ↓ moves to Rename", await cdp.evaluate("document.activeElement?.textContent === 'Rename'"));
  await key("End", "End", 35);
  check("4d: End goes to Delete plan", await cdp.evaluate("document.activeElement?.textContent.startsWith('Delete plan')"));
  await key("ArrowDown", "ArrowDown", 40);
  check("4d: ↓ wraps to Open plan", await cdp.evaluate("document.activeElement?.textContent === 'Open plan'"));
  await key("Escape", "Escape", 27);
  check("4d: Escape closes and focus returns to the row's ⋯", await cdp.evaluate("!document.querySelector('.rl-row-menu-layer') && document.activeElement?.classList.contains('rl-sb-dots') && !document.querySelector('[data-menu]')"));

  // Right-click opens it at the pointer; Rename edits in place.
  const point = await centre('.rl-sb-item:nth-child(3) .rl-sb-title');
  await mouse("mouseMoved", point); await mouse("mousePressed", point, { button: "right", clickCount: 1 }); await mouse("mouseReleased", point, { button: "right", clickCount: 1 });
  await settle();
  const ctx = await cdp.evaluate("(() => { const l = document.querySelector('.rl-row-menu-layer'); if (!l) return null; const r = l.getBoundingClientRect(); return { x: r.x, y: r.y, row: document.querySelector('[data-menu] .rl-sb-title')?.textContent }; })()");
  check("Right-click opens the row menu at the pointer, on that row", ctx && near(ctx.x, point.x) && near(ctx.y, point.y) && ctx.row === "Din retrieval plan", { ctx, point });
  await click('.rl-row-menu-item:nth-child(2)');
  const editing = await cdp.evaluate("(() => { const i = document.querySelector('.rl-sb-rename'); if (!i) return null; const row = i.closest('.rl-sb-row').getBoundingClientRect(); return { focused: document.activeElement === i, selected: i.selectionStart === 0 && i.selectionEnd === i.value.length, value: i.value, rowH: row.height, inputX: i.getBoundingClientRect().x + 6 - document.querySelector('.rl-sb').getBoundingClientRect().x }; })()");
  check("Rename edits in place: the row keeps its height, the title selected where it stood", editing?.focused && editing.selected && editing.value === "Din retrieval plan" && near(editing.rowH, 32) && near(editing.inputX, 42), editing);
  await shot("rename-inline-aurora", { x: 0, y: 47, width: 253, height: 260 });
  await cdp.evaluate("window.__qa.calls.length = 0");
  await type("Din retrieval v2");
  await key("Enter", "Enter", 13);
  check("Enter saves the new title and hands focus back to the row", await cdp.evaluate("JSON.stringify(window.__qa.calls) === JSON.stringify([['rename','retrieval','Din retrieval v2']]) && document.activeElement?.classList.contains('rl-sb-row') && !document.querySelector('.rl-sb-rename')"), await cdp.evaluate("window.__qa.calls"));
  await key("ContextMenu", "ContextMenu", 93);
  await click('.rl-row-menu-item:nth-child(2)');
  await type(" and more");
  await key("Escape", "Escape", 27);
  check("Escape cancels the rename and writes nothing", await cdp.evaluate("window.__qa.calls.length === 1 && !document.querySelector('.rl-sb-rename')"));
  await cdp.evaluate("document.querySelector('.rl-sb-item:nth-child(3) .rl-sb-row').focus()");
  await key("ContextMenu", "ContextMenu", 93);
  await click('.rl-row-menu-item:nth-child(2)');
  await cdp.evaluate("(() => { const i = document.querySelector('.rl-sb-rename'); i.select(); })()");
  await type("Retrieval, blurred");
  await click(".qa-stage");
  check("Leaving the field saves", await cdp.evaluate("JSON.stringify(window.__qa.calls.at(-1)) === JSON.stringify(['rename','retrieval','Retrieval, blurred'])"), await cdp.evaluate("window.__qa.calls"));
  // ⌫ on a focused row asks, inline; Escape backs out, Delete deletes.
  await cdp.evaluate("document.querySelector('.rl-sb-item:nth-child(2) .rl-sb-row').focus()");
  await key("Backspace", "Backspace", 8);
  const ask = await cdp.evaluate("(() => { const g = document.querySelector('.rl-sb-confirm'); return g && { label: g.getAttribute('aria-label'), focused: document.activeElement?.textContent, title: g.closest('.rl-sb-item').querySelector('.rl-sb-title').textContent }; })()");
  check("⌫ on a focused row asks to delete it, in the row, Delete focused", ask?.label === "Delete this plan?" && ask.focused === "Delete" && ask.title === "Din backend: Hono + Fly" && await cdp.evaluate("!window.__qa.calls.some(c => c[0] === 'delete')"), ask);
  await shot("delete-confirm-aurora", { x: 0, y: 47, width: 253, height: 260 });
  await contrast("delete confirm aurora", ".rl-sb");
  await key("Escape", "Escape", 27);
  check("Escape backs out and focus returns to the row", await cdp.evaluate("!document.querySelector('.rl-sb-confirm') && document.activeElement?.closest('.rl-sb-item')?.querySelector('.rl-sb-title')?.textContent === 'Din backend: Hono + Fly'"));
  await click('.rl-sb-item:nth-child(2) .rl-sb-dots');
  await click('.rl-row-menu-item[data-danger]');
  await click('.rl-sb-confirm-yes');
  check("Delete plan in the menu → Delete deletes that plan", await cdp.evaluate("JSON.stringify(window.__qa.calls.at(-1)) === JSON.stringify(['delete','backend'])"), await cdp.evaluate("window.__qa.calls.at(-1)"));
  await click('.rl-sb-new');
  await click('.rl-sb-add');
  check("+ New session and a project's + start a session, the + in that folder", await cdp.evaluate("JSON.stringify(window.__qa.calls.slice(-2)) === JSON.stringify([['new-session'],['new-session-in','/Users/me/projects/din']])"), await cdp.evaluate("window.__qa.calls.slice(-2)"));
  await click('.rl-sb-item:nth-child(4) .rl-sb-row');
  check("A chat row opens the chat", await cdp.evaluate("JSON.stringify(window.__qa.calls.at(-1)) === JSON.stringify(['select-chat','status'])"));

  // ── 5a: sorted by need, versions nested under the open session ────────
  await viewport(1600, 960);
  await scene("5a");
  m = await cdp.evaluate(MEASURE);
  geometry("5a", m);
  const d5 = DESIGN["5a"];
  const nest = m.rows.find((r) => r.nest);
  check("5a: the open session is one grouped container (menu fill, r8) at the board's rect", rectNear(nest?.li, d5.nest) && nest.liStyle["background-color"] === m.tokens["color-glass-2"] && nest.liStyle["border-radius"] === "8px" && nest.rowStyle["background-color"] === "rgba(0, 0, 0, 0)" && nest.rowStyle.color === m.tokens["color-ink"], nest);
  check("5a: its spinner is the building green; its ⋯ at the board's spot", nest.spinning && nest.iconColor === m.tokens["color-mode-build-fg"] && rectNear(nest.dots, d5.activeDots), nest);
  check("5a: versions: v1 … v4 · latest, 24px rows at 12px, r5, dates at the right; v1 is on screen (--color-fill-3, ink), latest --color-ink-3",
    d5.versions.every(([text, ...rect], i) => m.versions[i]?.text === text && rectNear(m.versions[i].rect, rect)) && m.versions.every((v) => v.style["font-size"] === "12px" && v.style["border-radius"] === "5px")
    && m.versions[0].current === "true" && m.versions[0].style["background-color"] === m.tokens["color-fill-3"] && m.versions[0].style.color === m.tokens["color-ink"]
    && m.versions[3].style.color === m.tokens["color-ink-3"] && m.versions[1].style.color === m.tokens["color-ink-4"] && m.versions.map((v) => v.date).join() === "Oct 14,Oct 14,Oct 15,Oct 15",
    m.versions);
  const needRow = m.rows.find((r) => r.title === "Every vehicle gets a 3D model");
  check("5a: Needs you: an amber dot, ink title, the reason tag at the right (11px, --color-ink-4), its ⋯ held back until hover", rectNear(needRow?.icon, d5.dot) && needRow.iconBg === m.tokens["color-mode-redline-fg"] && needRow.rowStyle.color === m.tokens["color-ink"] && rectNear(needRow.tag, d5.tag) && needRow.dotsOpacity === "0", needRow);
  const sprint = m.rows.find((r) => r.title === "MachineOS \"Full Bore\" sprint");
  check("5a: a building row that is not open: a --color-ink-4 spinner, --color-ink-3 title", sprint?.spinning && sprint.iconColor === m.tokens["color-ink-4"] && sprint.rowStyle.color === m.tokens["color-ink-3"], sprint);
  check("5a: In review rows wear the pen; then Show 9 more (12.5px, --color-ink-4) at the board's rect", m.rows.filter((r) => r.title && m.rows.indexOf(r) >= 3).every((r) => !r.spinning) && m.folds[0]?.text === d5.more[0] && rectNear(m.folds[0].rect, d5.more.slice(1)) && m.folds[0].style["font-size"] === "12.5px" && m.folds[0].style.color === m.tokens["color-ink-4"], m.folds);
  builds["5a"] = await shot("5a-sidebar-aurora", { x: 0, y: 47, width: 281, height: 913 });
  await shot("5a-aurora");
  await contrast("5a aurora", ".rl-sb");
  await smallTargets("5a", ".rl-sb");
  // Hovering the Needs you row trades its tag for the ⋯.
  await mouse("mouseMoved", await centre('.rl-sb-item[data-need] .rl-sb-title'));
  await settle();
  check("5a: under the pointer, the Needs you row shows its ⋯ in place of the tag", await cdp.evaluate("(() => { const li = document.querySelector('.rl-sb-item[data-need]'); return getComputedStyle(li.querySelector('.rl-sb-dots')).opacity === '1' && getComputedStyle(li.querySelector('.rl-sb-tag')).visibility === 'hidden'; })()"));
  await click('.rl-sb-version:not([aria-current])');
  check("5a: a version row shows that revision", await cdp.evaluate("JSON.stringify(window.__qa.calls.at(-1)) === JSON.stringify(['revision','dial',2])"), await cdp.evaluate("window.__qa.calls.at(-1)"));
  await click('.rl-sb-fold');
  check("5a: Show 9 more opens all fourteen, then offers Show less", await cdp.evaluate("document.querySelectorAll('.rl-sb-section:nth-child(3) .rl-sb-item').length === 14 && document.querySelector('.rl-sb-section:nth-child(3) .rl-sb-fold').textContent === 'Show less'"));
  await shot("5a-expanded-aurora", { x: 0, y: 47, width: 281, height: 913 });

  // ── Archived fold, chats without a folder ──────────────────────────────
  await viewport(1280, 800);
  await scene("archive");
  check("Archived · N closes the list, folded; the folderless chat closes the groups as Chats", await cdp.evaluate("(() => { const f = [...document.querySelectorAll('.rl-sb-fold')].at(-1); return f.textContent.trim() === 'Archived · 2' && f.getAttribute('aria-expanded') === 'false' && [...document.querySelectorAll('.rl-sb-label')].map(l => l.innerText.trim()).join() === 'DIN,CHATS' && !document.body.textContent.includes('Old brainstorm'); })()"));
  await click('.rl-sb-section:last-child .rl-sb-fold');
  check("Opening the fold shows the archived plan and chat, newest archive first, their menus offering Unarchive", await cdp.evaluate("[...document.querySelectorAll('.rl-sb-section:last-child .rl-sb-title')].map(t => t.textContent).join() === 'Old brainstorm,Din search spike'"));
  await click('.rl-sb-section:last-child .rl-sb-item:first-child .rl-sb-dots');
  check("An archived chat's menu: Open chat · Rename · Unarchive · Delete chat", await cdp.evaluate("[...document.querySelectorAll('.rl-row-menu-item .rl-row-menu-label')].map(t => t.textContent).join() === 'Open chat,Rename,Unarchive,Delete chat'"));
  await click('.rl-row-menu-item:nth-child(3)');
  check("Unarchive goes through the chat archive with archived=false", await cdp.evaluate("JSON.stringify(window.__qa.calls.at(-1)) === JSON.stringify(['archive-chat','gone',false])"), await cdp.evaluate("window.__qa.calls.at(-1)"));
  await shot("archive-aurora", { x: 0, y: 47, width: 253, height: 400 });

  // ── The classic list: its row shares RowMenu and must not nest buttons ─
  await scene("classic");
  for (let i = 0; i < 100 && !(await cdp.evaluate("!!document.querySelector('.rl-session-row')")); i++) await delay(50);
  await settle();
  check("Classic: no row nests an interactive element inside its own button", await cdp.evaluate("document.querySelectorAll('.rl-session-row button :is(button, a[href], input), .rl-sb-row :is(button, a[href], input, [role=button])').length === 0"),
    await cdp.evaluate("[...document.querySelectorAll('.rl-session-row button button')].map(b => b.getAttribute('aria-label') || b.textContent)"));
  await shot("classic-aurora", { x: 0, y: 47, width: 300, height: 400 });
  await cdp.evaluate("window.__qa.calls.length = 0; document.querySelector('.rl-session-row [aria-label=\"Move to repo…\"]').focus()");
  await key("Enter", "Enter", 13);
  await cdp.evaluate("document.querySelectorAll('.rl-session-row')[1].querySelector('[title^=\"Orchestrated run\"]').focus()");
  await key(" ", "Space", 32);
  await click('.rl-session-row [aria-label="Change plan state"]');
  check("Classic: the project line, run chip and plan-state label still answer Enter, Space and clicks, and never select the row",
    await cdp.evaluate("JSON.stringify(window.__qa.calls) === JSON.stringify([['move-project','roadmap'],['run-report','built']]) && !!document.querySelector('[role=menu][aria-label=\"Plan state\"]')"),
    await cdp.evaluate("window.__qa.calls"));
  await key("Escape", "Escape", 27);

  // ── basic (light) and studio (another dark) ────────────────────────────
  for (const theme of ["basic", "studio"]) {
    for (const name of ["4a", "4b", "4d", "5a"]) {
      const board = DESIGN[name];
      await viewport(name === "5a" ? 1600 : 1280, name === "5a" ? 960 : 800);
      await scene(name, theme);
      if (name === "4d") { await click('.rl-sb-item:nth-child(2) .rl-sb-dots'); await mouse("mouseMoved", { x: 900, y: 700 }); await settle(); }
      const t = await cdp.evaluate(MEASURE);
      check(`${name} ${theme}: same geometry as Aurora (rows, labels, New session)`, rectNear(t.newSession.rect, board.newSession) && board.rows.every(([title, ...rect], i) => t.rows.filter((r) => r.title !== undefined)[i]?.title === title && rectNear(t.rows.filter((r) => r.title !== undefined)[i].row, rect)), { rows: t.rows.map((r) => r.row) });
      await shot(`${name}-${theme}`, { x: 0, y: 0, width: name === "4d" ? 520 : board.width + 40, height: name === "5a" ? 960 : 800 });
      await contrast(`${name} ${theme}`, ".rl-sb");
      if (name === "4d") await contrast(`${name} menu ${theme}`, ".rl-row-menu-layer");
    }
  }

  // ── Side by side with the boards ───────────────────────────────────────
  if (existsSync(path.join(boards, "b4a.png"))) {
    await viewport(1000, 1000);
    for (const [name, crop] of Object.entries(CROPS)) {
      const ref = (await readFile(path.join(boards, crop.file))).toString("base64");
      const html = `<body style="margin:0;background:#101114;color:#a9aebb;font:12px -apple-system;display:flex;gap:24px;padding:12px">
        <figure style="margin:0"><figcaption>design ${name}</figcaption><div style="width:${crop.width}px;height:${crop.height}px;background:url(data:image/png;base64,${ref}) -${crop.x}px -${crop.y}px no-repeat"></div></figure>
        <figure style="margin:0"><figcaption>build ${name} (aurora)</figcaption><img src="data:image/png;base64,${builds[name]}" style="display:block;width:${crop.width}px;height:${crop.height}px;object-fit:none;object-position:0 0"></figure></body>`;
      await viewport(crop.width * 2 + 48, crop.height + 40);
      await cdp.call("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
      await delay(400);
      await shot(`compare-${name}`);
    }
  } else {
    report.limitations.push(`Board PNGs not found at ${boards}: no side-by-side composites.`);
  }
  await writeFile(path.join(output, "chrome.stderr.log"), chromeLog);
} catch (error) {
  report.errors.push(String(error?.stack ?? error));
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = !report.errors.length && report.checks.every((item) => item.passed);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
  cdp?.close();
  if (chrome) { chrome.kill("SIGTERM"); await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), delay(3000)]); if (chrome.exitCode === null) chrome.kill("SIGKILL"); }
  await server?.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failed: report.checks.filter((item) => !item.passed).map((item) => item.name), errors: report.errors, screenshots: report.screenshots.length, output }, null, 2));
if (!report.passed) process.exitCode = 1;
