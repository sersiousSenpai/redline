#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Gate 5 for the flow Feedback lane: board 5a's right panel (400 × 960) and
// board 4c's margin note, rendered from the production components in
// headless Chrome, measured against the board numbers (±1px), every colour
// checked against its role token, and laid side by side with the reference
// board crops. Then basic and studio are captured, and every text in both
// pieces is held to 4.5:1 (icon-only controls 3:1) in all fifteen themes.
//
//   node scripts/flow-feedback-visual-qa.mjs [outputDir] [--boards <dir>]
//
// The reference boards (b5a.png, b4c.png) live with the design export, by
// default ../flow-design beside the worktree; without them the side-by-side
// images are skipped and the measurements still run.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const boardsAt = args.indexOf("--boards");
const boards = path.resolve(boardsAt >= 0 ? args[boardsAt + 1] : path.join(root, "../flow-design"));
const output = path.resolve(root, args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--boards") ?? "docs/flow-qa/feedback");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-flow-feedback-qa-"));
const service = path.join(root, "fixtures/flow-feedback-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  startedAt: new Date().toISOString(),
  fixture: "fixtures/flow-feedback-qa",
  boards: path.relative(root, boards),
  screenshots: [],
  checks: [],
  errors: [],
  limitations: [
    "Headless Chrome component fixture, not WKWebView or the live app; the stage's own frame (top bar, plan centre) is a stand-in.",
    "Board numbers are read from the design HTML and the rendered board PNGs; text widths depend on the system font, so tab and note widths are held to ±2px where the board's own text sets them.",
    "POLISH P3 groups the list into piles under small-caps labels, which moves every card down from the board's y: card tops are the current render (measured), and what is inside a card keeps the board's offsets from that top.",
    "The fixture's header is not given the stage's waiting count, so it still reads \"All resolved\"; \"N to review\" and the cross-version vN badge are checked on the same production components mounted beside it.",
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
const near = (a, b, tol = 1) => typeof a === "number" && Math.abs(a - b) <= tol;
async function settle() { await cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"); await delay(80); }
async function shot() { return (await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data; }
async function screenshot(name) { const data = await shot(); await writeFile(path.join(output, `${name}.png`), Buffer.from(data, "base64")); report.screenshots.push(`${name}.png`); return data; }
async function clickAt(point) { await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point }); await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point }); await settle(); }
async function click(selector) { const point = await cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing '+${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`); await clickAt(point); }
async function boot(view, width, height) {
  await cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: `${report.fixtureUrl}?view=${view}` });
  for (let i = 0; i < 150; i++) { try { if (await cdp.evaluate("document.documentElement.dataset.qaReady === 'true'")) break; } catch {} await delay(100); }
  await delay(300); await settle();
}
async function theme(name) { await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(name)})`); await settle(); }

// In the page: an element's box and the styles the spec names, and a role
// token resolved to the same rgb() form a computed colour takes.
const probe = `window.__qaBox = (selector, from) => {
  const scope = from ? document.querySelector(from) : document;
  const e = typeof selector === 'string' ? scope.querySelector(selector) : selector;
  if (!e) return null;
  const r = e.getBoundingClientRect(), s = getComputedStyle(e);
  return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, text: e.textContent,
    font: parseFloat(s.fontSize), lineHeight: parseFloat(s.lineHeight), weight: s.fontWeight, family: s.fontFamily,
    radius: parseFloat(s.borderTopLeftRadius), color: s.color, bg: s.backgroundColor, shadow: s.boxShadow,
    border: s.borderTopWidth + ' ' + s.borderTopColor, borderBottom: s.borderBottomWidth + ' ' + s.borderBottomColor,
    pad: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(parseFloat), clamp: s.webkitLineClamp, overflow: s.overflow };
};
window.__qaToken = (name) => { const i = document.createElement('i'); document.body.append(i); i.style.color = 'var(--' + name + ')'; const c = getComputedStyle(i).color; i.remove(); return c; };
// POLISH P3: the review's piles (lib/feedbackThreads reviewGroups), each a
// small-caps label "Waiting on you 1" with its hint, then its cards.
window.__qaPiles = (scope = '') => [...document.querySelectorAll(scope + ' .rl-fb-pile')].map((p) => {
  const h = p.querySelector('.rl-fb-pile-label'), s = getComputedStyle(h);
  return { aria: p.getAttribute('aria-label'), label: h.firstChild.textContent.trim() + ' ' + h.querySelector('span').textContent, hint: h.querySelector('em')?.textContent ?? null,
    box: window.__qaBox(h), style: { size: s.fontSize, transform: s.textTransform, spacing: s.letterSpacing, weight: s.fontWeight, color: s.color },
    ids: [...p.querySelectorAll('[data-comment-id]')].map((e) => e.dataset.commentId) };
});
// POLISH P3: one more production piece, rendered beside the fixture's own with
// the page's React (the same vite modules main.tsx loaded), for what the
// fixture's frame does not wire: the stage's waiting count, another version.
window.__qaMount = async (build) => {
  window.__qaUnmount?.();
  const dep = (name) => performance.getEntriesByType('resource').map((e) => e.name).find((u) => new URL(u).pathname.endsWith('/deps/' + name));
  // The prebundled deps are CommonJS: their exports sit on the default.
  const cjs = async (name) => { const m = await import(dep(name)); return m.default ?? m; };
  const React = await cjs('react.js'), { createRoot } = await cjs('react-dom_client.js');
  const mods = { h: React.createElement, panel: await import('/src/shell/FeedbackPanel.tsx'), threads: await import('/src/lib/feedbackThreads.ts'), board: await import('/fixtures/flow-feedback-qa/board.ts') };
  const host = document.createElement('div');
  host.dataset.qaMount = '';
  host.style.cssText = 'position: fixed; left: 0; top: 0; width: 400px; height: 960px; display: flex; flex-direction: column; background: var(--color-canvas); z-index: 10';
  document.body.append(host);
  const root = createRoot(host);
  root.render(build(mods));
  await new Promise((r) => setTimeout(r, 120));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__qaUnmount = () => { root.unmount(); host.remove(); window.__qaUnmount = null; };
  return host.childElementCount;
};`;

// Every visible text in a subtree, with its WCAG contrast on what it is
// painted on (the monochat sweep's pattern), plus icon-only controls.
const contrastSweep = `window.__qaContrast = (rootSelector, base, alsoHidden = '') => {
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
    if (!r.width || !r.height || s.visibility !== 'visible' || (el.closest('[aria-hidden=true], [hidden]') && !(alsoHidden && el.matches(alsoHidden)))) continue;
    let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); if (o < 0.99) continue;
    const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join(' ');
    const bg = background(el);
    if (own) out.push({ text: own.slice(0, 32), ratio: ratio(over(rgba(s.color), bg), bg), min: 4.5 });
    if (el.tagName === 'BUTTON' && !own && el.querySelector('svg')) out.push({ text: 'icon: ' + (el.getAttribute('aria-label') || '?'), ratio: ratio(over(rgba(s.color), bg), bg), min: 3 });
    if (el.tagName === 'TEXTAREA' && el.placeholder && !el.value && getComputedStyle(el, '::placeholder').color !== 'rgba(0, 0, 0, 0)') out.push({ text: 'placeholder: ' + el.placeholder, ratio: ratio(over(rgba(getComputedStyle(el, '::placeholder').color), bg), bg), min: 4.5 });
  }
  probe.remove(); return out;
}`;

/** Board crop beside our capture, in one PNG, drawn by the page's canvas. */
async function sideBySide(name, boardFile, crop, oursBase64, label) {
  let board;
  try { await access(boardFile); board = (await readFile(boardFile)).toString("base64"); }
  catch { report.limitations.push(`${path.basename(boardFile)} not found under ${path.relative(root, boards)}: ${name} skipped.`); return; }
  const png = await cdp.evaluate(`(async () => {
    const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const board = await load('data:image/png;base64,${board}'), ours = await load('data:image/png;base64,${oursBase64}');
    const [x, y, w, h] = ${JSON.stringify(crop)}; const gap = 16, head = 22;
    const c = document.createElement('canvas'); c.width = w * 2 + gap; c.height = h + head;
    const g = c.getContext('2d'); g.fillStyle = '#101114'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#a9aebb'; g.font = '12px -apple-system, sans-serif'; g.fillText('Board ${label}', 4, 15); g.fillText('Build (Aurora)', w + gap + 4, 15);
    g.drawImage(board, x, y, w, h, 0, head, w, h); g.drawImage(ours, 0, 0, w, h, w + gap, head, w, h);
    return c.toDataURL('image/png').split(',')[1];
  })()`);
  await writeFile(path.join(output, `${name}.png`), Buffer.from(png, "base64"));
  report.screenshots.push(`${name}.png`);
}

const THEMES_ALL = ["aurora", "studio", "basic"];

try {
  await mkdir(output, { recursive: true });
  server = await createServer({
    configFile: false, root, cacheDir: path.join(temporary, "vite-cache"),
    optimizeDeps: { entries: ["fixtures/flow-feedback-qa/index.html"] },
    plugins: [react(), tailwindcss()],
    resolve: { alias: ["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/webview", "@tauri-apps/api/window", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener"].map((find) => ({ find, replacement: service })) },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null }, clearScreen: false,
  });
  await server.listen();
  report.fixtureUrl = `http://127.0.0.1:${server.httpServer.address().port}/fixtures/flow-feedback-qa/`;
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--user-data-dir=${path.join(temporary, "chrome-profile")}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-extensions", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeLog = ""; chrome.stderr.on("data", (d) => { chromeLog += d; });
  let port;
  for (let i = 0; i < 150; i++) { try { port = (await readFile(path.join(temporary, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch {} await delay(100); }
  if (!port) throw new Error(`Chrome failed to start: ${chromeLog.slice(-3000)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new CDP(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Log.enable");
  report.browserVersion = (await cdp.call("Browser.getVersion")).product;

  // ── 5a right panel, Aurora, 400 × 960 ──────────────────────────────────
  await boot("panel", 400, 960);
  await cdp.evaluate(probe); await cdp.evaluate(contrastSweep);
  const ours5a = await screenshot("5a-panel-aurora");
  await sideBySide("5a-panel-side-by-side", path.join(boards, "b5a.png"), [13 + 1200, 18, 400, 960], ours5a, "5a · right panel");
  const B = (sel, from) => cdp.evaluate(`window.__qaBox(${JSON.stringify(sel)}${from ? `, ${JSON.stringify(from)}` : ""})`);
  const tok = (name) => cdp.evaluate(`window.__qaToken(${JSON.stringify(name)})`);
  const T = {};
  for (const name of ["color-ink", "color-ink-2", "color-ink-3", "color-ink-4", "color-ink-5", "color-fill-2", "color-rule", "color-rule-strong", "color-paper", "color-canvas", "color-focus-rim", "color-mode-plan-fg", "color-mode-build-fg", "color-mode-build-bg", "color-mode-redline-fg", "color-mode-redline-bg", "color-glass-3", "color-bg-elevated", "color-warning", "color-on-warning"]) T[name] = await tok(name);
  T["font-mono"] = await cdp.evaluate("(() => { const i = document.createElement('i'); i.style.fontFamily = 'var(--font-mono)'; document.body.append(i); const f = getComputedStyle(i).fontFamily; i.remove(); return f; })()");
  report.tokens = T;

  // Header row: 48px + hairline, tabs 28px, "All resolved" 12 from the edge.
  const tabs = await B(".rl-fb-tabs");
  check("5a header: 48px row on the board's line (47 → 95), hairline in --color-rule, 12.5px", near(tabs.y, 47) && near(tabs.h, 49) && tabs.borderBottom === `1px ${T["color-rule"]}` && tabs.font === 12.5, tabs);
  const [chat, fb] = await cdp.evaluate(`[...document.querySelectorAll('.rl-fb-tab')].map(e => window.__qaBox(e))`);
  check("5a tabs: copy \"Chat\" / \"Feedback 16\"", chat.text === "Chat" && fb.text === "Feedback16", [chat.text, fb.text]);
  check("5a tab Chat: x 12, 28px tall at y 57, muted ink (--color-ink-4)", near(chat.x, 12) && near(chat.y, 57) && near(chat.h, 28) && chat.color === T["color-ink-4"], chat);
  check("5a tab Feedback: selected fill --color-fill-2, ink, r7, 28px at y 57; x 64, 97 wide as on the board (its fill spans 64 → 160)", fb.bg === T["color-fill-2"] && fb.color === T["color-ink"] && near(fb.radius, 7) && near(fb.y, 57) && near(fb.h, 28) && near(fb.x, 64) && near(fb.w, 97), fb);
  const count = await B(".rl-fb-tab-count");
  check("5a tab count \"16\" in muted ink", count.text === "16" && count.color === T["color-ink-4"], count);
  const status = await B(".rl-fb-tabs-status");
  check("5a \"All resolved\": 11.5px muted, right edge 12 from the panel's", status.text === "All resolved" && status.font === 11.5 && status.color === T["color-ink-4"] && near(status.right, 388), status);
  // POLISH P3 (new): the stage hands the header its waiting count
  // (FlowStage `waiting`); the fixture's header above is not given one. The
  // same header with this session's summary trades "All resolved" for an
  // amber "1 to review" that opens the review.
  await cdp.evaluate("window.__qaMount(({ h, panel, threads, board }) => { const s = threads.feedbackSummary(board.boardSession, 1); return h(panel.FeedbackTabs, { tab: 'chat', onTab: (t) => { window.__qaTab = t; }, count: s.count, allResolved: s.allResolved, waiting: s.waiting }); })");
  const review = await B(".rl-fb-tabs-status", "[data-qa-mount]");
  const reviewTag = await cdp.evaluate("document.querySelector('[data-qa-mount] .rl-fb-tabs-status')?.tagName");
  const reviewRatio = (await cdp.evaluate("window.__qaContrast('[data-qa-mount]', 'canvas')")).find((r) => r.text === "1 to review")?.ratio;
  await click("[data-qa-mount] .rl-fb-tabs-status");
  const reviewOpens = await cdp.evaluate("window.__qaTab === 'feedback'");
  check("5a header with the stage's waiting count: \"1 to review\" in place of \"All resolved\", a button (--color-mode-redline-fg on --color-mode-redline-bg, 600, ≥ 4.5:1) at the right that opens the review",
    review?.text === "1 to review" && reviewTag === "BUTTON" && review.color === T["color-mode-redline-fg"] && review.bg === T["color-mode-redline-bg"] && review.weight === "600" && near(review.right, 388) && reviewRatio >= 4.5 && reviewOpens
      && !(await cdp.evaluate("document.querySelector('[data-qa-mount]').textContent.includes('All resolved')")), { review, reviewTag, reviewRatio, reviewOpens });
  await cdp.evaluate("window.__qaUnmount()");

  // The list and the open thread.
  const list = await B(".rl-fb-list");
  check("5a list: from y 96, padding 14, 13px / 1.55", near(list.y, 96) && list.pad.every((p) => p === 14) && list.font === 13 && near(list.lineHeight, 20.15, 0.1), list);
  const open = await B('[data-comment-id="c-001"]');
  const piles = await cdp.evaluate("window.__qaPiles('[data-qa=panel]')");
  // POLISH P3: the list is in piles; the open card now sits under the
  // "Waiting on you" label (its pile's 10px gap), 27px below the board's 110.
  check("5a open card: first in \"Waiting on you\", 10 under its label: x 14, y 137, 372 × 230.7 (the board's 110 → 339 card), r12", near(open.x, 14) && near(open.y, piles[0]?.box.bottom + 10) && near(open.y, 137) && near(open.w, 372) && near(open.h, 230.7) && near(open.radius, 12), { open, pile: piles[0]?.box });
  // POLISH P3 (new): the piles themselves, and the resolved-but-not-accepted
  // answer waiting on you rather than sitting among the resolved.
  check("5a piles: small-caps labels (11px, uppercase, .04em, 600) \"Waiting on you 1\" in the redlining amber with its hint, holding the voice note Claude answered and you have not accepted; then \"Resolved 15\" in --color-ink-4",
    piles.map((p) => p.label).join("|") === "Waiting on you 1|Resolved 15" && piles[0].hint === "Accept Claude's answer, or reopen it" && piles[0].ids.join() === "c-001" && piles[0].style.color === T["color-mode-redline-fg"] && piles[1].style.color === T["color-ink-4"] && piles[1].hint === null
      && piles.every((p) => p.style.size === "11px" && p.style.transform === "uppercase" && p.style.spacing === "0.44px" && p.style.weight === "600" && near(p.box.x, 14)), piles);
  check("5a open card: glass sheet fill, focus rim from --color-focus-rim, no drop shadow", open.bg === T["color-glass-3"] && open.shadow.includes(`${T["color-focus-rim"]} 0px 0px 0px 1px inset`) && open.shadow.endsWith("rgba(0, 0, 0, 0) 0px 0px 0px 0px"), { bg: open.bg, shadow: open.shadow });
  check("5a open card: content 15 in (board 14 + its 1px border)", open.pad.every((p) => p === 15), open.pad);
  const meta = await B('[data-comment-id="c-001"] .rl-fb-meta');
  const type = await B('[data-comment-id="c-001"] .rl-fb-type');
  // POLISH P3: the meta line leads with the mark's type, in its colour.
  check("5a open meta copy: \"Feedback · Context · ¶3 · voice note … Resolved in v2\" (the mark type first)", meta.text === "Feedback·Context · ¶3·voice noteResolved in v2", meta.text);
  // POLISH P3: positions are the board's, from the card's own top (board 110).
  check("5a open meta: 11.5px muted, led by \"Feedback\" in the redlining amber (--color-mode-redline-fg, 600); first line 15 under the card's top (board 110 → 125)", meta.font === 11.5 && meta.color === T["color-ink-4"] && type.text === "Feedback" && type.color === T["color-mode-redline-fg"] && type.weight === "600" && near(meta.y, open.y + 15), { meta, type });
  const anchor = await B('[data-comment-id="c-001"] .rl-fb-anchor');
  check("5a open anchor in plan blue (--color-mode-plan-fg)", anchor.color === T["color-mode-plan-fg"], anchor.color);
  const mStatus = await B('[data-comment-id="c-001"] .rl-fb-status');
  check("5a \"Resolved in v2\" in building green (--color-mode-build-fg), right edge at the content's", mStatus.color === T["color-mode-build-fg"] && near(mStatus.right, 14 + 372 - 15), mStatus);
  const mic = await B('[data-comment-id="c-001"] .rl-fb-voice svg');
  check("5a voice-note mic icon 11px", near(mic.w, 11) && near(mic.h, 11), mic);
  const note = await B('[data-comment-id="c-001"] .rl-fb-note');
  // POLISH P3: the board's offset from the card's top (153 − 110).
  check("5a note: ink, three lines from 43 under the card's top (board 110 → 153)", note.color === T["color-ink"] && near(note.y, open.y + 43) && near(note.h, 60.45, 1.5), note);
  check("5a note copy verbatim", note.text.trim() === "The pilot firm is my own firm. Keep the vendor-terms and notice gates anyway, and get notice-text sign-off from someone other than me.", note.text);
  const reply = await B('[data-comment-id="c-001"] .rl-fb-reply');
  const rule = await B('[data-comment-id="c-001"] .rl-fb-reply-rule');
  // POLISH P3: the board's offset from the card's top (223 − 110).
  check("5a reply: secondary ink behind a 2px --color-rule-strong rule, gap 10, 2px above, 113 under the card's top (board 110 → 223)", reply.color === T["color-ink-3"] && near(rule.w, 2) && rule.bg === T["color-rule-strong"] && reply.pad[0] === 2 && near(reply.y, open.y + 113), { reply, rule });
  check("5a reply copy verbatim", reply.text.trim() === "Done. §3 and §4 now treat R1 as internal dogfooding. Both gates stay. Notice-text sign-off goes to outside counsel in step 6.", reply.text);
  const [accept, reopen, discuss] = await cdp.evaluate(`[...document.querySelectorAll('[data-comment-id="c-001"] .rl-fb-actions button')].map(e => window.__qaBox(e))`);
  check("5a actions copy: Accept · Reopen … Discuss", [accept.text, reopen.text, discuss.text].join("|") === "Accept|Reopen|Discuss", [accept.text, reopen.text, discuss.text]);
  // POLISH P3: the board's offset from the card's top (297 − 110).
  check("5a ✓ Accept: 28px, r7, green tint (--color-mode-build-bg/fg), 12px, 187 under the card's top (board 110 → 297)", near(accept.h, 28) && near(accept.radius, 7) && accept.bg === T["color-mode-build-bg"] && accept.color === T["color-mode-build-fg"] && accept.font === 12 && near(accept.y, open.y + 187), accept);
  check("5a Reopen: 28px, secondary ink, 8 after Accept", near(reopen.h, 28) && reopen.color === T["color-ink-3"] && near(reopen.x - accept.right, 8), reopen);
  check("5a Discuss: muted ink, flush right", discuss.color === T["color-ink-4"] && near(discuss.right, 14 + 372 - 15), discuss);

  // Resolved threads: paper, hairline, two lines, at the board's rows.
  // POLISH P3: they open the "Resolved" pile, under its label and 10 apart
  // (the pile's gap; the board's list spaced them 12), measured 414.8, 516.8,
  // 618.9 below the Waiting on you pile.
  const tops = [415, 517, 619];
  let above = piles[1]?.box.bottom;
  for (const [i, id] of ["c-002", "c-003", "c-004"].entries()) {
    const card = await B(`[data-comment-id="${id}"]`);
    const cNote = await B(`[data-comment-id="${id}"] .rl-fb-note`);
    const cLabel = await B(`[data-comment-id="${id}"] .rl-fb-anchor`);
    check(`5a resolved ${i + 1}: in the "Resolved" pile, 10 under the ${i ? "card above" : "pile's label"} (y ${tops[i]}), 372 × 92.1, r12, paper with a --color-rule hairline, padding 12/14`, piles[1]?.ids[i] === id && near(card.y, above + 10) && near(card.y, tops[i]) && near(card.h, 92.1) && near(card.w, 372) && near(card.radius, 12) && card.bg === T["color-paper"] && card.border === `1px ${T["color-rule"]}` && card.pad.join() === "12,14,12,14", { card, above });
    above = card.bottom;
    check(`5a resolved ${i + 1}: two clamped lines of secondary ink, anchor muted`, cNote.clamp === "2" && near(cNote.h, 40.3, 1) && cNote.color === T["color-ink-3"] && cLabel.color === T["color-ink-4"], { cNote, cLabel: cLabel.color });
    check(`5a resolved ${i + 1}: anchor copy`, cLabel.text === ["§4 · step 4", "§4 · releases", "§4"][i], cLabel.text);
  }
  const more = await B(".rl-fb-more");
  // POLISH P3: it closes the Resolved pile, 10 under its third card.
  check("5a \"12 more resolved\": 12px muted, padding 2/4, 10 under the third resolved card (y 721), closing the Resolved pile", more.text === "12 more resolved" && more.font === 12 && more.color === T["color-ink-4"] && more.pad.join() === "2,4,2,4" && near(more.y, above + 10) && near(more.y, 721)
    && (await cdp.evaluate("document.querySelector('.rl-fb-more').closest('.rl-fb-pile')?.getAttribute('aria-label') === 'Resolved'")), { more, above });

  // The composer.
  const wrap = await B(".rl-fb-composer-wrap");
  check("5a composer row: hairline at y 891, padding 12/14/14", near(wrap.y, 891) && wrap.border === `1px ${T["color-rule"]}` && wrap.pad.join() === "12,14,14,14", wrap);
  const box = await B(".rl-fb-composer");
  check("5a composer: x 14, y 904, 372 × 42 (40 + its border), r11, glass sheet with a --color-rule-strong rim", near(box.x, 14) && near(box.y, 904) && near(box.w, 372) && near(box.h, 42) && near(box.radius, 11) && box.bg === T["color-glass-3"] && box.shadow.includes(T["color-rule-strong"]), box);
  const hint = await B(".rl-fb-composer-hint");
  check("5a composer hint: verbatim, 13.5px muted, starting 15 in", hint.text === "Select text in the plan, or type feedback…" && hint.font === 13.5 && hint.color === T["color-ink-4"] && near(hint.x, 29), hint);
  const model = await B(".rl-fb-composer-model");
  check("5a composer model chip: \"Opus 4.5 · High\", 11.5px secondary ink", model.text === "Opus 4.5 · High" && model.font === 11.5 && model.color === T["color-ink-3"], model);

  // Nothing in the panel shows a comment id; nothing overflows.
  check("5a no c-0xx id anywhere", !(await cdp.evaluate("/c-0\\d\\d/.test(document.querySelector('[data-qa=panel]').textContent)")));
  check("5a nothing spills past the 400px panel", await cdp.evaluate("document.documentElement.scrollWidth <= 400 && [...document.querySelectorAll('[data-qa=panel] *')].every(e => e.getBoundingClientRect().right <= 400.5)"));
  check("5a nothing moves: no transitions or animations on the panel", await cdp.evaluate("[...document.querySelectorAll('[data-qa=panel] *')].every(e => { const s = getComputedStyle(e); return e.getAnimations().length === 0 && s.transitionDuration.split(',').every(d => parseFloat(d) === 0); })"));
  // POLISH P3 (new): with the latest (v4) on screen, the review reads the
  // whole thread, so the v1 marks are from another version and say so in
  // their anchor; on the version they were made on (above) none does.
  await cdp.evaluate("window.__qaMount(({ h, panel, board }) => h(panel.default, { session: board.boardSession, viewingVersion: 4, onJumpToAnchor: () => {}, composer: null }))");
  const badges = await cdp.evaluate("[...document.querySelectorAll('[data-qa-mount] [data-comment-id]')].map((c) => { const b = c.querySelector('.rl-fb-anchor .rl-fb-elsewhere'), s = b && getComputedStyle(b); return { id: c.dataset.commentId, anchor: c.querySelector('.rl-fb-anchor').textContent, title: c.querySelector('.rl-fb-anchor').title, badge: b?.textContent, font: s?.fontFamily, size: s?.fontSize, border: s && s.borderTopWidth + ' ' + s.borderTopColor, color: s?.color }; })");
  const piles4 = await cdp.evaluate("window.__qaPiles('[data-qa-mount]')");
  check("5a viewing v4: every v1 mark shows a \"v1\" badge in its anchor (10px mono, --color-rule hairline, --color-ink-4; \"Show it on v1, where it was made\"), the piles unchanged; on v1 itself no card has one",
    badges.length === 4 && badges.every((b) => b.badge === "v1" && b.anchor.endsWith("v1") && b.title === "Show it on v1, where it was made" && b.font === T["font-mono"] && b.size === "10px" && b.border === `1px ${T["color-rule"]}` && b.color === T["color-ink-4"])
      && piles4.map((p) => p.label).join("|") === "Waiting on you 1|Resolved 15" && !(await cdp.evaluate("!!document.querySelector('[data-qa=panel] .rl-fb-elsewhere')")), { badges, piles: piles4.map((p) => p.label) });
  await cdp.evaluate("window.__qaUnmount()");

  // Behaviour: a resolved thread opens and jumps; the fold opens; typing arms send.
  await click('[data-comment-id="c-002"] .rl-fb-note');
  check("clicking a resolved thread jumps to its anchor and opens it", await cdp.evaluate("JSON.stringify(window.__qaJump) === JSON.stringify({anchorId:'A.4.p1',commentId:'c-002'}) && !document.querySelector('[data-comment-id=\"c-002\"]').classList.contains('is-settled')"));
  await screenshot("5a-panel-resolved-opened-aurora");
  await click('.rl-fb-more');
  check("\"12 more resolved\" brings all sixteen", (await cdp.evaluate("document.querySelectorAll('[data-comment-id]').length")) === 16);
  await cdp.evaluate("document.querySelector('.rl-fb-composer textarea').focus()");
  await cdp.call("Input.insertText", { text: "Ship the iOS track first." }); await settle();
  check("typing hides the hint, focuses the rim and arms send", await cdp.evaluate("!document.querySelector('.rl-fb-composer-hint') && document.querySelector('.rl-fb-composer').classList.contains('is-focused') && !!document.querySelector('.rl-fb-composer-button.is-send')"));
  await screenshot("5a-panel-composing-aurora");

  // ── 4c margin note, Aurora, in an 839px plan panel ──────────────────────
  await boot("margin", 839, 560);
  await cdp.evaluate(probe);
  const ours4c = await screenshot("4c-margin-aurora");
  await sideBySide("4c-margin-side-by-side", path.join(boards, "b4c.png"), [12 + 441, 56 + 96, 839, 560], ours4c, "4c · plan panel");
  const mn = await B('[data-comment-id="qa-react"]');
  check("4c margin note: indented 24 (x 56 + 24), 42 tall, r10, 13px / 1.5 sans, padding 10/12", near(mn.x, 80) && near(mn.h, 42) && near(mn.radius, 10) && mn.font === 13 && near(mn.lineHeight, 19.5, 0.1) && !/^(ui-serif|"?Source Serif|Georgia)/i.test(mn.family) && mn.pad.join() === "10,12,10,12", mn);
  check("4c margin note: 291 wide like the board (±3, text-set), elevated card with a warm hairline", near(mn.w, 291, 3) && mn.bg === T["color-bg-elevated"] && mn.border.startsWith("1px "), mn);
  check("4c margin note: sits 16 under the list, at the board's y (body 34 + title/lede/h2/list)", near(mn.y - (await B(".qa-plan-p")).bottom, 16), mn.y);
  const av = await B('[data-comment-id="qa-react"] .rl-margin-note-avatar');
  check("4c avatar \"IM\": 20px disc in --color-warning, --color-on-warning ink, 10.5px / 700", av.text === "IM" && near(av.w, 20) && near(av.h, 20) && av.radius >= 10 && av.bg === T["color-warning"] && av.color === T["color-on-warning"] && av.font === 10.5 && av.weight === "700", av);
  const mnText = await B('[data-comment-id="qa-react"] .rl-margin-note-body');
  check("4c note copy verbatim, prose ink", mnText.text === "Run this against staging first, not prod." && mnText.color === T["color-ink-2"], mnText);
  const widget = await B('[data-comment-id="qa-widget"]');
  check("4c the ProseMirror-widget note matches the React one", near(widget.w, mn.w, 0.5) && near(widget.h, mn.h, 0.5) && widget.bg === mn.bg && widget.radius === mn.radius, { widget, mn });

  // ── Every other thread state (draft, with Claude, reopened, question,
  //    suggestion, outside reviewer), for the eye and the sweep ────────────
  await boot("states", 400, 960);
  await cdp.evaluate(probe);
  await screenshot("5a-states-aurora");
  // POLISH P3: the threads are read pile by pile (Waiting on you: the answered
  // question and the agent's suggestion; Your marks: the draft and the
  // reopened one; With Claude: the two sent), not in the order written.
  const statePiles = await cdp.evaluate("window.__qaPiles('[data-qa=panel]')");
  check("states: each thread says where it stands, in its pile: Waiting on you 2 (Resolved in v2, Suggested by agent-1) · Your marks 2 (Not sent yet, Reopened) · With Claude 2 (With Claude, Follow-up with Claude)",
    (await cdp.evaluate("[...document.querySelectorAll('.rl-fb-status')].map(e => e.textContent).join('|')")) === "Resolved in v2|Suggested by agent-1|Not sent yet|Reopened|With Claude|Follow-up with Claude"
      && statePiles.map((p) => `${p.label}: ${p.ids.join()}`).join("|") === "Waiting on you 2: s-004,s-005|Your marks 2: s-001,s-003|With Claude 2: s-002,s-006" && statePiles[1].hint === "Ride your next Send" && statePiles[2].hint === null,
    { status: await cdp.evaluate("[...document.querySelectorAll('.rl-fb-status')].map(e => e.textContent)"), piles: statePiles.map((p) => [p.label, p.ids, p.hint]) });
  check("states: anchors read as places — a table row, a paragraph, a step, a section — in pile order, none from another version (no vN badge)", (await cdp.evaluate("[...document.querySelectorAll('.rl-fb-anchor')].map(e => e.textContent).join('|')")) === "Decisions you made · first pilot|Context · ¶2|§4 · step 5|§3|§5 · ¶1|§4 · releases" && !(await cdp.evaluate("!!document.querySelector('.rl-fb-elsewhere')")), await cdp.evaluate("[...document.querySelectorAll('.rl-fb-anchor')].map(e => e.textContent)"));
  // POLISH P3 (new): every card's meta line leads with the mark's type in its
  // colour (lib/feedbackThreads markType), then "·" and the anchor.
  const types = await cdp.evaluate("[...document.querySelectorAll('[data-qa=panel] [data-comment-id]')].map((c) => { const t = c.querySelector('.rl-fb-meta > .rl-fb-type'); return { id: c.dataset.commentId, first: t === c.querySelector('.rl-fb-meta').firstElementChild, text: t?.textContent, color: t && getComputedStyle(t).color, then: t?.nextElementSibling?.textContent, anchor: t?.nextElementSibling?.nextElementSibling?.classList.contains('rl-fb-anchor') }; })");
  const wantTypes = [["s-004", "Question", "color-mode-build-fg"], ["s-005", "Edit", "color-mode-plan-fg"], ["s-001", "Feedback", "color-mode-redline-fg"], ["s-003", "Feedback", "color-mode-redline-fg"], ["s-002", "Question", "color-mode-build-fg"], ["s-006", "Feedback", "color-mode-redline-fg"]];
  check("states: each card's meta starts with its mark type in its colour (Question green, Edit blue, Feedback amber), then \"·\" and the anchor",
    types.length === wantTypes.length && wantTypes.every(([id, text, token], i) => types[i].id === id && types[i].first && types[i].text === text && types[i].color === T[token] && types[i].then === "·" && types[i].anchor), types);
  check("states: a selection in the plan shows where the composer's note will land", (await cdp.evaluate("document.querySelector('.rl-fb-composer-anchor')?.textContent")) === "§4 · step 5");
  check("states: nothing pulses or fades — every state holds still", await cdp.evaluate("[...document.querySelectorAll('[data-qa=panel] *')].every(e => e.getAnimations().length === 0 && Number(getComputedStyle(e).opacity) === 1)"));

  // ── basic and studio ───────────────────────────────────────────────────
  for (const name of ["basic", "studio"]) {
    await boot("panel", 400, 960); await theme(name);
    await screenshot(`5a-panel-${name}`);
    check(`${name}: panel geometry holds (open card 230, composer 42 at y 904)`, await cdp.evaluate("(() => { const o = document.querySelector('[data-comment-id=\"c-001\"]').getBoundingClientRect(), c = document.querySelector('.rl-fb-composer').getBoundingClientRect(); return Math.abs(o.height - 230) <= 1 && Math.abs(c.height - 42) <= 1 && Math.abs(c.y - 904) <= 1; })()"));
    await boot("states", 400, 960); await theme(name);
    await screenshot(`5a-states-${name}`);
    await boot("margin", 839, 560); await theme(name);
    await screenshot(`4c-margin-${name}`);
  }

  // ── Contrast: every text 4.5:1, icon-only controls 3:1, all themes ─────
  const themes = await cdp.evaluate("import('/src/theme/themes.ts').then(m => m.THEMES.map(t => t.name))");
  const short = [];
  const swept = {};
  for (const view of ["panel", "states", "margin"]) {
    await boot(view, view === "margin" ? 839 : 400, view === "margin" ? 560 : 960);
    await cdp.evaluate(contrastSweep);
    // A resolved thread opened, and a reopen form, so their text is swept too.
    if (view === "panel") await click('[data-comment-id="c-002"] .rl-fb-note');
    if (view === "states") { await cdp.evaluate("[...document.querySelectorAll('[data-comment-id=\"s-004\"] button')].find(b => b.textContent === 'Reopen').click()"); await settle(); }
    for (const name of themes) {
      await theme(name);
      const scope = view === "margin" ? "[data-qa=margin] .rl-margin-note" : "[data-qa=panel]";
      const base = view === "margin" ? "paper" : "canvas";
      // The margin note's initials and the composer's hint are aria-hidden
      // (the note and the field's own placeholder carry them), but both are
      // still read on screen.
      const rows = await cdp.evaluate(`window.__qaContrast(${JSON.stringify(scope)}, ${JSON.stringify(base)}, '.rl-margin-note-avatar, .rl-fb-composer-hint')`);
      swept[view] = rows.length;
      for (const r of rows) if (r.ratio < r.min) short.push(`${name} ${view} ${r.text}: ${r.ratio.toFixed(2)} < ${r.min}`);
    }
  }
  report.contrastSwept = swept;
  check(`contrast: every text ≥ 4.5:1 and icon-only control ≥ 3:1 — board panel, every thread state, margin note — all ${themes.length} themes`, themes.length === 15 && short.length === 0 && swept.panel >= 25 && swept.states >= 35 && swept.margin >= 4, { short, swept });

  await writeFile(path.join(output, "chrome.stderr.log"), chromeLog);
} catch (error) {
  report.errors.push(String(error?.stack ?? error));
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = !report.errors.length && report.checks.every((c) => c.passed);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
  cdp?.close();
  if (chrome) { chrome.kill("SIGTERM"); await Promise.race([new Promise((r) => chrome.once("exit", r)), delay(3000)]); if (chrome.exitCode === null) chrome.kill("SIGKILL"); }
  await server?.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failed: report.checks.filter((c) => !c.passed).map((c) => c.name), errors: report.errors, screenshots: report.screenshots.length, output }, null, 2));
if (!report.passed) process.exitCode = 1;
