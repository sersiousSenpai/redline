#!/usr/bin/env node
// The flow top bar and Tools menu (Wave C, C1) against the design boards
// 4a–4d and 5a: the real components and styles in a vite fixture
// (fixtures/flow-topbar-qa), synthetic Tauri services, headless Chrome over CDP.
//
//   node scripts/flow-topbar-visual-qa.mjs [outputDir] [--boards <dir>]
//
// For each board it renders the bar at the board's size in Aurora and checks
// three ways: the spec values off the DOM (sizes, radii, type steps, and every
// colour equal to its mapped token), the positions of everything drawn on the
// bar against the board PNG (the same pixel-run grouping on both, the left
// cluster shifted by the traffic-light clearance), and a side-by-side strip
// for the eye. Then basic and studio, and a WCAG sweep of every text in the
// bar and the menu across all fifteen themes.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { PNG } from "pngjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const boardsFlag = args.indexOf("--boards");
const boardsDir = boardsFlag >= 0 ? path.resolve(args[boardsFlag + 1]) : path.join(homedir(), "redline-wt/flow-design");
const output = path.resolve(root, args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--boards") ?? "docs/flow-qa/topbar");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-flow-topbar-qa-"));
const service = path.join(root, "fixtures/flow-topbar-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  startedAt: new Date().toISOString(),
  fixture: "fixtures/flow-topbar-qa",
  boards: boardsDir,
  screenshots: [],
  checks: [],
  deviations: [],
  positions: {},
  errors: [],
  sourceSha256: {},
  limitations: [
    "Headless Chrome component fixture; not WKWebView, native window drag or the live app.",
    "The bar alone in each board's state, with a stand-in stage under it. Synthetic memory status; no live sessions.",
  ],
};

// The traffic-light clearance: the bar keeps the classic header's pl-20 (80px)
// where the boards, drawn without a window's controls, pad 16.
const LIGHTS = 80 - 16;
// Each board's frame content box inside its PNG (the 1px frame border is
// outside it) and the window size it was drawn at.
const BOARDS = {
  "4a": { file: "b4a.png", width: 1280, height: 800, origin: [13, 56] },
  "4b": { file: "b4b.png", width: 1280, height: 800, origin: [10, 56] },
  "4c": { file: "b4c.png", width: 1280, height: 800, origin: [12, 56] },
  "4d": { file: "b4d.png", width: 1280, height: 800, origin: [9, 56] },
  "5a": { file: "b5a.png", width: 1600, height: 960, origin: [13, 18] },
};
// Where the build departs from a board on purpose (REPORT → Deviations). Keyed
// board → right-cluster group index (from the right) → what moved and why.
const KNOWN = {
  "4d": {
    1: "Tools, open: the boards draw it as a bare label at rest and a padded box when open, which moves the label 10px left as the menu opens. The build keeps the label where it rests and draws the box out into the gaps, so the open box sits 10px right of the board's and nothing moves.",
  },
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
async function settle() { await cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"); await delay(80); }
async function pointAt(selector) { return cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw new Error('Missing selector: '+${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`); }
async function click(selector) { const p = await pointAt(selector); await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...p }); await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...p }); await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...p }); await settle(); }
async function moveAway() { await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 600 }); await settle(); }
async function key(key, code = key, virtual = 0, modifiers = 0) { await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtual, modifiers }); await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtual, modifiers }); await settle(); }
async function shot() { const s = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); return Buffer.from(s.data, "base64"); }
async function save(name, buffer) { await writeFile(path.join(output, `${name}.png`), buffer); report.screenshots.push(`${name}.png`); }

// ---- Pixels ---------------------------------------------------------------
const px = (png, x, y) => { const i = (png.width * y + x) << 2; return [png.data[i], png.data[i + 1], png.data[i + 2]]; };
/** Boxes of everything drawn on a flat background inside a region: columns
 *  with any pixel off the background, grouped where the gap between them is
 *  at least `gap` columns. The same rule runs on the board and the build. */
function groups(png, x0, y0, w, h, { tol = 10, gap = 6 } = {}) {
  const bg = px(png, x0 + Math.floor(w / 2), y0 + 2);
  const out = []; let cur = null, empty = 0;
  for (let x = x0; x < x0 + w; x++) {
    let lo = -1, hi = -1;
    for (let y = y0; y < y0 + h; y++) { const p = px(png, x, y); if (Math.max(Math.abs(p[0] - bg[0]), Math.abs(p[1] - bg[1]), Math.abs(p[2] - bg[2])) > tol) { if (lo < 0) lo = y; hi = y; } }
    if (lo >= 0) { if (!cur) cur = { x, right: x, top: lo, bottom: hi }; else { cur.right = x; cur.top = Math.min(cur.top, lo); cur.bottom = Math.max(cur.bottom, hi); } empty = 0; }
    else if (cur && ++empty >= gap) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map((g) => ({ x: g.x - x0, right: g.right - x0 + 1, top: g.top - y0, height: g.bottom - g.top + 1, width: g.right - g.x + 1 }));
}
function crop(png, x, y, w, h) { const out = new PNG({ width: w, height: h }); PNG.bitblt(png, out, x, y, w, h, 0, 0); return out; }
function stack(parts, gap = 8) {
  const width = Math.max(...parts.map((p) => p.width)); const height = parts.reduce((n, p) => n + p.height, 0) + gap * (parts.length - 1);
  const out = new PNG({ width, height }); out.data.fill(255);
  let y = 0; for (const p of parts) { PNG.bitblt(p, out, 0, 0, p.width, p.height, 0, y); y += p.height + gap; }
  return PNG.sync.write(out);
}

// ---- The DOM ----------------------------------------------------------------
const measure = `(() => {
  const css = (e, p) => e ? getComputedStyle(e).getPropertyValue(p).trim() : null;
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2) }; };
  const probe = document.createElement('i'); document.body.append(probe);
  const token = (name) => { probe.style.color = 'var(' + name + ')'; const c = getComputedStyle(probe).color; probe.style.color = ''; return c; };
  const q = (s) => document.querySelector(s);
  const bar = q('.rl-ftb'), mode = q('.rl-ftb-mode'), plan = q('.rl-ftb-show-plan'), needs = q('.rl-ftb-needs'), seg = q('.rl-ftb-seg'), tools = q('.rl-ftb-tools'), gear = q('.rl-ftb button[aria-label=Settings]');
  const out = {
    bar: { rect: rect(bar), font: css(bar, 'font-size'), border: css(bar, 'border-bottom-width'), borderColor: css(bar, 'border-bottom-color'), bg: css(bar, 'background-color'), gap: css(bar, 'column-gap'), padLeft: css(bar, 'padding-left'), padRight: css(bar, 'padding-right'), drag: bar?.classList.contains('rl-app-header') },
    icon: rect(q('.rl-ftb .rl-ftb-icon svg')), iconColor: css(q('.rl-ftb .rl-ftb-icon'), 'color'),
    mark: { rect: rect(q('.rl-ftb-mark')), radius: css(q('.rl-ftb-mark'), 'border-radius'), bg: css(q('.rl-ftb-mark'), 'background-color') },
    brand: { weight: css(q('.rl-ftb-brand'), 'font-weight'), color: css(q('.rl-ftb-brand'), 'color') },
    divider: css(q('.rl-ftb-divider'), 'color'),
    title: { text: q('.rl-ftb-title')?.textContent, color: css(q('.rl-ftb-title'), 'color') },
    mode: mode && { text: mode.textContent, rect: rect(mode), radius: css(mode, 'border-radius'), font: css(mode, 'font-size'), weight: css(mode, 'font-weight'), pad: css(mode, 'padding'), gap: css(mode, 'column-gap'), color: css(mode, 'color'), bg: css(mode, 'background-color'), icon: rect(mode.querySelector('svg')) },
    plan: plan && { text: plan.textContent, rect: rect(plan), radius: css(plan, 'border-radius'), font: css(plan, 'font-size'), pad: css(plan, 'padding'), border: css(plan, 'border-top-color'), borderWidth: css(plan, 'border-top-width'), color: css(plan, 'color') },
    needs: needs && { text: needs.textContent, rect: rect(needs), radius: css(needs, 'border-radius'), pad: css(needs, 'padding'), gap: css(needs, 'column-gap'), color: css(needs, 'color'), bg: css(needs, 'background-color'), dot: rect(needs.querySelector('.rl-ftb-needs-dot')) },
    seg: seg && { rect: rect(seg), radius: css(seg, 'border-radius'), border: css(seg, 'border-top-color'), pad: css(seg, 'padding'), font: css(seg, 'font-size'), items: [...seg.querySelectorAll('button')].map((b) => ({ text: b.textContent, checked: b.getAttribute('aria-checked'), rect: rect(b), radius: css(b, 'border-radius'), bg: css(b, 'background-color'), color: css(b, 'color') })) },
    tools: { rect: rect(tools), radius: css(tools, 'border-radius'), color: css(tools, 'color'), bg: css(tools, 'background-color'), expanded: tools?.getAttribute('aria-expanded'), up: !!tools?.querySelector('.lucide-chevron-up'), down: !!tools?.querySelector('.lucide-chevron-down') },
    gear: { svg: rect(gear?.querySelector('svg')), color: css(gear, 'color') },
    tokens: Object.fromEntries(['--color-rule', '--color-rule-strong', '--color-fill-3', '--color-canvas', '--color-ink', '--color-ink-2', '--color-ink-3', '--color-ink-4', '--color-ink-5', '--color-fill-1', '--color-fill-2', '--color-mode-plan-fg', '--color-mode-plan-bg', '--color-mode-redline-fg', '--color-mode-redline-bg', '--color-mode-build-fg', '--color-mode-build-bg', '--color-mode-danger-fg', '--color-glass-2', '--rl-brand-mark'].map((t) => [t, token(t)])),
    stageOpacity: css(q('.rl-flow-stage'), 'opacity'),
    dim: document.documentElement.hasAttribute('data-rl-stage-dim'),
    overflow: bar ? bar.scrollWidth - bar.clientWidth : null,
  };
  const menu = q('.rl-tools-menu');
  out.menu = menu && {
    rect: rect(menu), radius: css(menu, 'border-radius'), pad: css(menu, 'padding'), glass: menu.classList.contains('rl-glass') && menu.classList.contains('rl-glass-menu'), font: css(menu, 'font-size'), bg: css(menu, 'background-color'),
    rows: [...menu.querySelectorAll('button')].map((b) => ({ text: b.textContent, rect: rect(b), radius: css(b, 'border-radius'), gap: css(b, 'column-gap'), pad: css(b, 'padding'), color: css(b, 'color'), icon: rect(b.querySelector('svg, .rl-tools-menu-dot')), iconColor: css(b.querySelector('svg'), 'color'), key: b.querySelector('.rl-tools-menu-key')?.textContent ?? null, keyColor: css(b.querySelector('.rl-tools-menu-key'), 'color'), keyFont: css(b.querySelector('.rl-tools-menu-key'), 'font-size'), live: b.querySelector('.rl-tools-menu-live')?.textContent ?? null, liveColor: css(b.querySelector('.rl-tools-menu-live'), 'color') })),
    divider: (() => { const d = menu.querySelector('.rl-tools-menu-divider'); return d && { rect: rect(d), margin: css(d, 'margin'), bg: css(d, 'background-color') }; })(),
  };
  probe.remove();
  return out;
})()`;

// Every visible text in a subtree, with its WCAG contrast on what it is
// painted on (the monochat QA's sweep).
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
    if (!r.width || !r.height || s.visibility !== 'visible' || el.closest('[aria-hidden=true], [disabled], [hidden]')) continue;
    let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); if (o < 0.99) continue;
    const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join(' ');
    const bg = background(el);
    if (own) out.push({ text: own.slice(0, 32), ratio: ratio(over(rgba(s.color), bg), bg) });
  }
  // Icon-only controls: the glyph's colour on what it sits on, held to 3:1.
  for (const el of document.querySelectorAll(rootSelector + ' button')) {
    if (el.textContent.trim() || !el.querySelector('svg')) continue;
    const bg = background(el);
    out.push({ text: 'icon: ' + (el.getAttribute('aria-label') || '?'), icon: true, ratio: ratio(over(rgba(getComputedStyle(el).color), bg), bg) });
  }
  probe.remove(); return out;
}`;

const near = (a, b, tol = 1) => a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) <= tol;

try {
  await mkdir(output, { recursive: true });
  for (const file of ["src/shell/FlowTopBar.tsx", "src/shell/ToolsMenu.tsx", "src/shell/topbar.css", "src/shell/stageDim.ts", "src/lib/sessionMode.ts", "src/config/workspace.ts", "src/components/SettingsGear.tsx", "src/components/SettingsMenu.tsx"]) {
    report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
  server = await createServer({
    configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), logLevel: "error",
    optimizeDeps: { entries: ["fixtures/flow-topbar-qa/index.html"] }, plugins: [react(), tailwindcss()],
    resolve: { alias: ["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/window", "@tauri-apps/api/webview", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener"].map((find) => ({ find, replacement: service })) },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null }, clearScreen: false,
  });
  await server.listen();
  report.fixtureUrl = `http://127.0.0.1:${server.httpServer.address().port}/fixtures/flow-topbar-qa/`;
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--user-data-dir=${path.join(temporary, "chrome-profile")}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-extensions", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeLog = ""; chrome.stderr.on("data", (data) => { chromeLog += data; });
  let port;
  for (let i = 0; i < 150; i++) { try { port = (await readFile(path.join(temporary, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch {} await delay(100); }
  if (!port) throw new Error(`Chrome failed to start: ${chromeLog.slice(-3000)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new CDP(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Log.enable");
  report.browserVersion = (await cdp.call("Browser.getVersion")).product;

  const open = async (board, theme, size = BOARDS[board] ?? BOARDS["4b"]) => {
    await cdp.call("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
    await cdp.call("Page.navigate", { url: `${report.fixtureUrl}?board=${board}&theme=${theme}` });
    for (let i = 0; i < 200 && !(await cdp.evaluate("document.documentElement.dataset.qaReady === 'true' && !!document.querySelector('.rl-ftb')").catch(() => false)); i++) await delay(100);
    await cdp.evaluate("document.fonts.ready.then(() => true)");
    await settle();
  };
  const openTools = async () => { await click(".rl-ftb-tools"); for (let i = 0; i < 50 && !(await cdp.evaluate("!!document.querySelector('.rl-tools-menu')")); i++) await delay(50); await delay(260); await moveAway(); };

  // ---- Aurora, at each board's size ------------------------------------
  for (const [board, spec] of Object.entries(BOARDS)) {
    await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await open(board, "aurora");
    if (board === "4d") await openTools();
    const m = await cdp.evaluate(measure);
    const t = m.tokens;
    const image = await shot();
    await save(`${board}-aurora`, image);
    const mine = PNG.sync.read(image);
    const ref = PNG.sync.read(await readFile(path.join(boardsDir, spec.file)));
    const [ox, oy] = spec.origin;
    const W = spec.width;

    // The bar.
    check(`${board}: the bar is 46px plus its 1px hairline, in the rule token, on the canvas`, m.bar.rect.h === 47 && m.bar.border === "1px" && m.bar.borderColor === t["--color-rule"] && m.bar.bg === t["--color-canvas"], m.bar);
    check(`${board}: the bar sets 12.5px type and 14px gaps, keeps pl-20 for the traffic lights and the window-drag class`, m.bar.font === "12.5px" && m.bar.gap === "14px" && m.bar.padLeft === "80px" && m.bar.padRight === "16px" && m.bar.drag, m.bar);
    check(`${board}: nothing on the bar overflows it`, m.overflow <= 0, m.overflow);
    // Centred half a pixel high, which is where the boards' icon font draws
    // the glyph (the pixel comparison below holds it to the board).
    check(`${board}: the sidebar glyph is 15px, at the bar's centre line, muted`, m.icon?.w === 15 && near(m.icon.x, 80) && near(m.icon.y + m.icon.h / 2, 22.5, 0.5) && m.iconColor === t["--color-ink-4"], m.icon);
    check(`${board}: the brand square is 16px, r4, the brand-mark red, beside a 600 "Redline"`, m.mark.rect?.w === 16 && m.mark.rect?.h === 16 && m.mark.radius === "4px" && m.mark.bg === t["--rl-brand-mark"] && m.brand.weight === "600" && m.brand.color === t["--color-ink"], m.mark);
    check(`${board}: the divider is the strong rule`, m.divider === t["--color-rule-strong"], m.divider);
    check(`${board}: the gear is a bare 15px glyph, 16px from the right edge`, m.gear.svg?.w === 15 && near(m.gear.svg.right, W - 16) && m.gear.color === t["--color-ink-4"], m.gear);

    // The left cluster, board by board.
    if (board === "4a") {
      check("4a: the title reads a muted New session, with no chip and no Show plan", m.title.text === "New session" && m.title.color === t["--color-ink-4"] && !m.mode && !m.plan, m.title);
      check("4a: on the right only Tools and the gear", !m.needs && !m.seg && m.tools.expanded === "false", m);
    } else {
      const title = { "4b": "Din roadmap: next steps", "4c": "Din roadmap: next steps", "4d": "Din roadmap: next steps", "5a": "Dialcrown: fastest credible launch" }[board];
      check(`${board}: the title is the session's, in ink`, m.title.text === title && m.title.color === t["--color-ink"], m.title);
      const want = { "4b": ["Plan mode", "plan"], "4c": ["Redlining", "redline"], "4d": ["Redlining", "redline"], "5a": ["Building v4", "build"] }[board];
      check(`${board}: the mode chip reads ${want[0]}: 22px, r6, 11.5/600, 0 8px, gap 6, an 11px icon, the ${want[1]} tokens`,
        m.mode?.text === want[0] && m.mode.rect.h === 22 && m.mode.radius === "6px" && m.mode.font === "11.5px" && m.mode.weight === "600" && m.mode.pad === "0px 8px" && m.mode.gap === "6px" && m.mode.icon?.w === 11 && m.mode.color === t[`--color-mode-${want[1]}-fg`] && m.mode.bg === t[`--color-mode-${want[1]}-bg`], m.mode);
      if (board === "4d") check("4d: Show plan: 24px inside a 1px strong-rule border (26 drawn), r6, 0 9px, 11.5px, secondary ink", m.plan?.text === "Show plan" && m.plan.rect.h === 26 && m.plan.borderWidth === "1px" && m.plan.border === t["--color-rule-strong"] && m.plan.radius === "6px" && m.plan.pad === "0px 9px" && m.plan.font === "11.5px" && m.plan.color === t["--color-ink-3"], m.plan);
      else check(`${board}: no Show plan while the plan is ${board === "4b" ? "not written yet" : "open"}`, !m.plan, m.plan);
    }
    // The right cluster.
    if (board === "4b") {
      const [conv, term] = m.seg?.items ?? [];
      check("4b: Conversation | Terminal: 22px segments in a 2px track (28 drawn, outlined in the track colour), r7, 11.5px, the selected one on fill-2",
        m.seg && m.seg.rect.h === 28 && m.seg.pad === "2px" && m.seg.radius === "7px" && m.seg.border === t["--color-fill-3"] && m.seg.font === "11.5px" && conv.rect.h === 22 && conv.radius === "5px" && conv.checked === "true" && conv.bg === t["--color-fill-2"] && conv.color === t["--color-ink"] && term.checked === "false" && term.color === t["--color-ink-4"] && term.text === "Terminal", m.seg);
    } else check(`${board}: no Conversation | Terminal (${board === "4a" ? "no terminal yet" : board === "4d" ? "the plan waits on review: Show plan is the next step" : "the plan panel is open"})`, !m.seg, m.seg);
    if (board === "5a") check("5a: ● 1 needs you: 28px, r7, 0 10px, gap 7, a 6px dot, the redlining tokens", m.needs?.text === "1 needs you" && m.needs.rect.h === 28 && m.needs.radius === "7px" && m.needs.pad === "0px 10px" && m.needs.gap === "7px" && m.needs.dot?.w === 6 && m.needs.color === t["--color-mode-redline-fg"] && m.needs.bg === t["--color-mode-redline-bg"], m.needs);
    else check(`${board}: nothing needs you`, !m.needs, m.needs);
    if (board === "4d") check("4d: Tools open: the elevated fill, ink, a chevron-up, 28px r7", m.tools.expanded === "true" && m.tools.bg === t["--color-fill-2"] && m.tools.color === t["--color-ink"] && m.tools.up && !m.tools.down && m.tools.rect.h === 28 && m.tools.radius === "7px", m.tools);
    else check(`${board}: Tools at rest: a bare muted label and chevron-down`, m.tools.expanded === "false" && m.tools.bg === "rgba(0, 0, 0, 0)" && m.tools.color === t["--color-ink-4"] && m.tools.down, m.tools);

    // Positions: everything drawn on the bar, the board's PNG against ours.
    // 4d: the menu's top edge starts at 44, so stop above it; and the open
    // Tools box ends 4px from the gear, so split on smaller gaps there.
    const scanH = board === "4d" ? 41 : 44;
    const half = W / 2;
    const rightGap = board === "4d" ? 4 : 6;
    const refL = groups(ref, ox + 8, oy + 2, half - 8, scanH);
    const myL = groups(mine, 8, 2, half - 8, scanH);
    const refR = groups(ref, ox + half, oy + 2, half - 8, scanH, { gap: rightGap }).map((g) => ({ ...g, x: g.x + half - 8, right: g.right + half - 8 })).reverse();
    const myR = groups(mine, half, 2, half - 8, scanH, { gap: rightGap }).map((g) => ({ ...g, x: g.x + half - 8, right: g.right + half - 8 })).reverse();
    const left = refL.map((r, i) => { const g = myL[i]; return g && { board: r, build: { ...g, x: g.x - LIGHTS, right: g.right - LIGHTS }, dx: g.x - LIGHTS - r.x, dw: g.width - r.width, dy: g.top - r.top, dh: g.height - r.height }; });
    const right = refR.map((r, i) => { const g = myR[i]; return g && { board: r, build: g, dRight: (W - 16 - g.right) - (W - 16 - r.right), dw: g.width - r.width, dy: g.top - r.top, dh: g.height - r.height, known: KNOWN[board]?.[i] }; });
    report.positions[board] = { left, right };
    const bad = (d) => !d || [d.dx ?? d.dRight, d.dw, d.dy, d.dh].some((v) => Math.abs(v) > 1);
    check(`${board}: the board and the build draw the same number of things on the bar`, refL.length === myL.length && refR.length === myR.length, { board: [refL.length, refR.length], build: [myL.length, myR.length] });
    check(`${board}: every left-cluster box within ±1px of the board (after the ${LIGHTS}px traffic-light shift)`, left.every((d) => !bad(d)), left.filter(bad));
    const unknown = right.filter((d) => bad(d) && !d?.known);
    check(`${board}: every right-cluster box within ±1px of the board, measured from the right edge`, unknown.length === 0, unknown);
    for (const d of right) if (d?.known && bad(d)) report.deviations.push({ board, measured: d, why: d.known });

    // Side by side: the board's bar over the build's.
    await writeFile(path.join(output, `${board}-compare.png`), stack([crop(ref, ox, oy, W, 47), crop(mine, 0, 0, W, 47)]));
    report.screenshots.push(`${board}-compare.png`);

    if (board === "4d") {
      const menu = m.menu;
      const rows = menu?.rows ?? [];
      const trigger = m.tools.rect;
      check("4d: the Tools menu is 250px inside 6px padding and a 1px rim (264 drawn), r12, the glass menu tier, 13px", menu && menu.rect.w === 264 && menu.radius === "12px" && menu.pad === "6px" && menu.glass && menu.font === "13px" && menu.bg === t["--color-glass-2"], menu);
      check("4d: it hangs 7px under Tools, its right edge 1px past the trigger's", menu && near(menu.rect.y, trigger.bottom + 7, 0.5) && near(menu.rect.right, trigger.right + 1, 0.5), { menu: menu?.rect, trigger });
      check("4d: rows Browser ⌘1 · Prompt drafter ⌘2 · Code review ⌘3 · Localhost ⌘4 · Runs 1 live · divider · Memory 2h ago · Terminals",
        rows.map((r) => [r.text]).join("|") === ["Browser⌘1", "Prompt drafter⌘2", "Code review⌘3", "Localhost⌘4", "Runs1 live", "Memory2h ago", "Terminals"].join("|"), rows.map((r) => r.text));
      check("4d: each row 34px, r8, 0 10px, gap 10, a 14px muted icon, 11px faint keys", rows.length === 7 && rows.every((r) => r.rect.h === 34 && r.radius === "8px" && r.pad === "0px 10px" && r.gap === "10px") && rows.filter((r) => r.iconColor).every((r) => r.icon.w === 14 && r.iconColor === t["--color-ink-4"]) && rows.filter((r) => r.key && /⌘/.test(r.key)).every((r) => r.keyFont === "11px" && r.keyColor === t["--color-ink-5"]), rows);
      check("4d: Runs says 1 live in the building green; Memory's dot is green and the row secondary ink", rows[4]?.live === "1 live" && rows[4].liveColor === t["--color-mode-build-fg"] && rows[5]?.color === t["--color-ink-3"] && rows[5].icon?.w === 7, [rows[4], rows[5]]);
      check("4d: one 1px divider, 5px 4px, in the rule", menu?.divider && menu.divider.rect.h === 1 && menu.divider.margin === "5px 4px" && menu.divider.bg === t["--color-rule"], menu?.divider);
      check("4d: the stage steps back to 55% while the menu is open", m.dim && m.stageOpacity === "0.55", { dim: m.dim, opacity: m.stageOpacity });
      // The menu, the board's over the build's (the build's carries the
      // Terminals row the board predates).
      const refMenu = crop(ref, ox + W - 340, oy, 340, 300);
      const myMenu = crop(mine, W - 340, 0, 340, 340);
      await writeFile(path.join(output, "4d-menu-compare.png"), stack([refMenu, myMenu]));
      report.screenshots.push("4d-menu-compare.png");
      // The menu's box in both: a row through it at y 250 (bare canvas on
      // either side of it on the board) and a column for its top and bottom.
      const canvasAt = (png, x, y) => px(png, x, y);
      const span = (png, x0, x1, y) => { const bg = canvasAt(png, x0, y); const xs = []; for (let x = x0; x < x1; x++) { const p = px(png, x, y); if (Math.max(Math.abs(p[0] - bg[0]), Math.abs(p[1] - bg[1]), Math.abs(p[2] - bg[2])) > 6) xs.push(x); } return xs.length ? [xs[0], xs[xs.length - 1] + 1] : null; };
      const [bl, br] = span(ref, ox + 900, ox + W - 1, oy + 250) ?? [0, 0];
      const [ml, mr] = span(mine, 900, W - 1, 250) ?? [0, 0];
      const boardMenu = { left: bl - ox, right: br - ox, width: br - bl };
      const buildMenu = { left: ml, right: mr, width: mr - ml };
      report.positions["4d-menu"] = { board: boardMenu, build: buildMenu, boardToolsBox: { left: 1166, right: 1235 }, buildToolsBox: { left: trigger.x, right: trigger.right } };
      check("4d: the menu is as wide as the board's (264) and hangs off its trigger the same way (1px past its right edge)", near(buildMenu.width, boardMenu.width) && near(boardMenu.right - 1235, buildMenu.right - trigger.right), { boardMenu, buildMenu });
      report.deviations.push({ board: "4d", measured: { menuRightBoard: boardMenu.right, menuRightBuild: buildMenu.right, dx: buildMenu.right - boardMenu.right }, why: "The menu hangs off the Tools box, which sits 10px right of the board's open box (see Tools, open); its width, radius, padding, rows and its offset from the trigger match." });
      // Behaviour: Escape closes, the dim lifts, focus goes home.
      await key("Escape", "Escape", 27);
      const after = await cdp.evaluate("({ menu: !!document.querySelector('.rl-tools-menu'), dim: document.documentElement.hasAttribute('data-rl-stage-dim'), opacity: getComputedStyle(document.querySelector('.rl-flow-stage')).opacity, focus: document.activeElement?.classList.contains('rl-ftb-tools') })");
      check("4d: Escape closes the menu, lifts the dim and hands focus back to Tools", !after.menu && !after.dim && after.opacity === "1" && after.focus, after);
      await openTools();
      await click(".rl-tools-menu button:nth-child(3)");
      check("4d: a pick closes the menu and opens that tool", await cdp.evaluate("!document.querySelector('.rl-tools-menu') && window.__qa.picked() === 'review'"), await cdp.evaluate("window.__qa.picked()"));
      await openTools();
      await click(".rl-flow-stage");
      check("4d: a press outside closes it", await cdp.evaluate("!document.querySelector('.rl-tools-menu') && !document.documentElement.hasAttribute('data-rl-stage-dim')"));
      await click(".rl-ftb button[aria-label=Settings]");
      check("4d: the gear opens the same Settings menu, Shell row included, and the stage steps back for it too", await cdp.evaluate("(() => { const m = document.querySelector('[role=menu][aria-label=Settings]'); return !!m && /Shell/.test(m.textContent) && !!m.querySelector('select[aria-label=Shell]') && document.documentElement.hasAttribute('data-rl-stage-dim'); })()"));
      await key("Escape", "Escape", 27);
      check("4d: Show plan opens the plan beside the conversation", await (async () => { await click(".rl-ftb-show-plan"); return cdp.evaluate("!document.querySelector('.rl-ftb-show-plan')"); })());
    }
    if (board === "4b") {
      await click(".rl-ftb-seg button:nth-child(2)");
      check("4b: Terminal takes the stage on a click", await cdp.evaluate("document.querySelector('.rl-ftb-seg button:nth-child(2)').getAttribute('aria-checked') === 'true'"));
      const drags = await cdp.evaluate("(async () => { window.__qaDrags = 0; const s = document.querySelector('.rl-ftb-spacer').getBoundingClientRect(); return { x: s.x + s.width / 2, y: s.y + s.height / 2 }; })()");
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...drags });
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...drags });
      await click(".rl-ftb-seg button:nth-child(1)");
      check("4b: a press on bare bar drags the window; a press on a control does not", await cdp.evaluate("window.__qaDrags === 1"), await cdp.evaluate("window.__qaDrags"));
    }
    if (board === "5a") {
      await click(".rl-ftb-needs");
      check("5a: ● 1 needs you jumps to it", await cdp.evaluate("window.__qaJumped === true"));
    }
  }

  // ---- basic (light) and studio (another dark) --------------------------
  for (const theme of ["basic", "studio"]) {
    for (const board of ["4a", "4b", "4d", "5a"]) {
      await open(board, theme);
      if (board === "4d") await openTools();
      const m = await cdp.evaluate(measure);
      await save(`${board}-${theme}`, await shot());
      check(`${theme} ${board}: the bar holds its geometry and nothing overflows`, m.bar.rect.h === 47 && m.overflow <= 0 && (!m.mode || m.mode.rect.h === 22) && (!m.menu || m.menu.rect.w === 264), { bar: m.bar.rect, overflow: m.overflow });
      check(`${theme} ${board}: every colour on the bar is its theme's token`, m.bar.bg === m.tokens["--color-canvas"] && m.bar.borderColor === m.tokens["--color-rule"] && (!m.mode || m.mode.bg !== m.tokens["--color-canvas"]) && m.iconColor === m.tokens["--color-ink-4"], { bg: m.bar.bg, rule: m.bar.borderColor });
    }
  }

  // ---- Contrast: every text in the bar and the menu, all fifteen themes ----
  await open("sink", "aurora", { width: 1280, height: 800 });
  const themes = await cdp.evaluate("import('/src/theme/themes.ts').then(m => m.THEMES.map(t => t.name))");
  await cdp.evaluate(contrastSweep);
  const short = [];
  let swept = 0;
  for (const theme of themes) {
    await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(theme)})`);
    for (const kind of ["chat", "plan", "redline", "build"]) {
      await cdp.evaluate(`window.__qa.setMode(${JSON.stringify({ chat: { kind: "chat", label: "Chat" }, plan: { kind: "plan", label: "Plan mode" }, redline: { kind: "redline", label: "Redlining" }, build: { kind: "build", label: "Building v4", version: 4 } }[kind])})`);
      await settle();
      for (const r of await cdp.evaluate("window.__qaContrast('.rl-ftb', 'canvas')")) { swept++; if (r.ratio < (r.icon ? 3 : 4.5)) short.push(`${theme} ${kind} bar ${r.text}: ${r.ratio.toFixed(2)}`); }
    }
    await openTools();
    for (const r of await cdp.evaluate("window.__qaContrast('.rl-tools-menu', 'canvas')")) { swept++; if (r.ratio < 4.5) short.push(`${theme} menu ${r.text}: ${r.ratio.toFixed(2)}`); }
    await key("Escape", "Escape", 27);
  }
  report.contrast = { themes: themes.length, samples: swept, short };
  check(`every text on the bar and in the Tools menu reaches 4.5:1 (icon-only controls 3:1) in all ${themes.length} themes`, themes.length === 15 && swept > 0 && short.length === 0, short);
  await cdp.evaluate("window.__qa.setTheme('aurora')"); await settle();
  await openTools();
  await save("sink-aurora-tools", await shot());
} catch (error) { report.errors.push(String(error?.stack ?? error)); }
finally {
  report.finishedAt = new Date().toISOString(); report.passed = !report.errors.length && report.checks.every((item) => item.passed);
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
  cdp?.close(); if (chrome) { chrome.kill("SIGTERM"); await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), delay(3000)]); if (chrome.exitCode === null) chrome.kill("SIGKILL"); }
  await server?.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failed: report.checks.filter((item) => !item.passed).map((c) => c.name), deviations: report.deviations.length, errors: report.errors, screenshots: report.screenshots.length, output }, null, 2));
if (!report.passed) process.exitCode = 1;
