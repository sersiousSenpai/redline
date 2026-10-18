#!/usr/bin/env node
// The flow stage's fidelity check (PLAN C3, gate 5): the plan panel in the
// split (4c), closed (4d) and full (5a) poses, composed from this branch's
// real components (placeholders where another lane owns the piece), in
// headless Chrome over CDP. Each board is captured at its own size in Aurora,
// then in Basic (light) and Studio (dark); every cell of the fidelity spec
// the stage owns is measured with getBoundingClientRect / getComputedStyle
// against the stated size (±1px) and its mapped token; and every text in the
// stage is swept for WCAG contrast (4.5:1, icon-only controls 3:1).
//
//   node scripts/flow-stage-visual-qa.mjs [outputDir]
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, process.argv[2] ?? "docs/flow-qa/stage");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-flow-stage-qa-"));
const service = path.join(root, "fixtures/flow-stage-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  startedAt: new Date().toISOString(),
  fixture: "fixtures/flow-stage-qa",
  screenshots: [],
  checks: [],
  errors: [],
  limitations: [
    "Headless Chrome component fixture, not WKWebView or the live app.",
    "The conversation, its composer, the Feedback tab and the context hint are this branch's placeholders (owned by convo-ui, feedback and start); the top bar and sidebar are footprints only. The integrator re-runs this with their components merged.",
    "Sizes are checked against the fidelity spec's stated values. The design file has no box-sizing reset, so its bordered boxes render 2px larger than their stated heights; the app is border-box.",
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
const near = (a, b, tol = 1) => typeof a === "number" && Math.abs(a - b) <= tol;
async function settle() { await cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"); await delay(120); }
async function screenshot(name) { const shot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); const file = `${name}.png`; await writeFile(path.join(output, file), Buffer.from(shot.data, "base64")); report.screenshots.push(file); }
async function click(selector) {
  const point = await cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('Missing ' + ${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  await settle();
}

// In the page: what an element measures, and what a token resolves to.
const helpers = `
  window.__m = (sel, from) => {
    const scope = from ? document.querySelector(from) : document;
    const e = typeof sel === 'string' ? scope && scope.querySelector(sel) : sel;
    if (!e) return null;
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom,
      fontSize: parseFloat(s.fontSize), lineHeight: parseFloat(s.lineHeight), fontWeight: s.fontWeight, fontFamily: s.fontFamily,
      color: s.color, bg: s.backgroundColor, radius: parseFloat(s.borderTopLeftRadius),
      pt: parseFloat(s.paddingTop), pr: parseFloat(s.paddingRight), pb: parseFloat(s.paddingBottom), pl: parseFloat(s.paddingLeft),
      ml: parseFloat(s.marginLeft), gap: parseFloat(s.columnGap) || 0, maxWidth: s.maxWidth,
      bt: parseFloat(s.borderTopWidth), bb: parseFloat(s.borderBottomWidth), bl: parseFloat(s.borderLeftWidth), br: parseFloat(s.borderRightWidth),
      bbColor: s.borderBottomColor, btColor: s.borderTopColor, blColor: s.borderLeftColor, brColor: s.borderRightColor,
      shadow: s.boxShadow, text: e.textContent.trim(), display: s.display, visible: r.width > 0 && r.height > 0 };
  };
  window.__tok = (name, prop = 'color') => { const p = document.createElement('i'); p.style[prop] = 'var(--' + name + ')'; document.body.append(p); const v = getComputedStyle(p)[prop]; p.remove(); return v; };
  window.__byText = (scope, text) => { const all = [...document.querySelectorAll(scope + ' *')].filter(e => e.textContent.trim() === text && e.getBoundingClientRect().width > 0); return all.length ? all[all.length - 1] : null; };
`;

// Every visible text in a subtree, with its WCAG contrast on what it is
// painted on (the monochat sweep, reading color(srgb …) as well as rgb()).
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
    if (own) out.push({ text: own.slice(0, 40), ratio: ratio(over(rgba(s.color), bg), bg), min: 4.5 });
    else if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && el.querySelector('svg') && !el.textContent.trim()) out.push({ text: 'icon: ' + (el.getAttribute('aria-label') || ''), ratio: ratio(over(rgba(s.color), bg), bg), min: 3 });
  }
  probe.remove(); return out;
}`;

const VIEW = { "4c": [1280, 800], "4d": [1280, 800], "5a": [1600, 960] };

async function load(board, width, height, theme = "aurora") {
  await cdp.call("Page.navigate", { url: "about:blank" });
  await cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: `${report.fixtureUrl}?board=${board}` });
  for (let i = 0; i < 200 && !(await cdp.evaluate("document.documentElement.dataset.qaReady === 'true' && !!document.querySelector('.rl-flow-stage') && !!document.querySelector('.rl-prose h1')").catch(() => false)); i++) await delay(100);
  await cdp.evaluate(helpers);
  await cdp.evaluate(contrastSweep);
  if (theme !== "aurora") await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(theme)})`);
  await cdp.evaluate("document.fonts.ready");
  await delay(400);
  await settle();
}

const tok = (name, prop) => cdp.evaluate(`window.__tok(${JSON.stringify(name)}${prop ? `, ${JSON.stringify(prop)}` : ""})`);
const m = (sel, from) => cdp.evaluate(`window.__m(${JSON.stringify(sel)}${from ? `, ${JSON.stringify(from)}` : ""})`);
const mText = (scope, text) => cdp.evaluate(`window.__m(window.__byText(${JSON.stringify(scope)}, ${JSON.stringify(text)}))`);

async function sweep(board, theme) {
  const rows = await cdp.evaluate("window.__qaContrast('.rl-flow-stage', 'canvas')");
  const short = rows.filter((r) => r.ratio < r.min).map((r) => `${r.text}: ${r.ratio.toFixed(2)} < ${r.min}`);
  check(`${board} ${theme}: every text in the stage reaches 4.5:1, icon-only controls 3:1 (${rows.length} swept)`, rows.length > 0 && short.length === 0, short);
}

async function board4c() {
  const [w, h] = VIEW["4c"];
  await load("4c", w, h);
  await screenshot("4c-aurora");
  const stage = await m(".rl-flow-stage");
  check("4c: the stage paints the window colour", stage.bg === (await tok("color-canvas", "backgroundColor")), stage.bg);
  const column = await m('.rl-flow-convo[data-layout="column"]');
  check("4c: the conversation is a 440px column with a hairline on its right", near(column?.w, 440) && column.br === 1 && column.brColor === (await tok("color-rule")), column);
  const plan = await m(".rl-flow-plan");
  check("4c: the plan panel sits beside it on the paper", near(plan.x, 440) && plan.bg === (await tok("color-paper", "backgroundColor")), { x: plan.x, bg: plan.bg });
  const head = await m(".rl-plan-head");
  check("4c header: 48px, 0 14 0 22, 12.5px, hairline under", near(head.h, 48) && near(head.pl, 22) && near(head.pr, 14) && near(head.fontSize, 12.5) && head.bb === 1 && head.bbColor === (await tok("color-rule")) && near(head.gap, 10), head);
  const name = await m(".rl-plan-head-name"), meta = await m(".rl-plan-head-meta");
  check('4c header: "Plan" in ink and a faint "v1 · 2 marks"', name.text === "Plan" && name.color === (await tok("color-ink")) && meta.text === "v1 · 2 marks" && meta.color === (await tok("color-ink-5")), { name, meta });
  const icon = await m(".rl-plan-head-icon");
  check("4c header: the 📄 icon is 14px in the muted ink", near(icon.w, 14) && icon.color === (await tok("color-ink-4")), icon);
  const full = await mText(".rl-plan-head", "Full screen");
  check('4c header: "⤢ Full screen" is a 28px ghost, r7, 0 10, secondary ink', near(full.h, 28) && near(full.radius, 7) && near(full.pl, 10) && near(full.pr, 10) && full.bg === "rgba(0, 0, 0, 0)" && full.color === (await tok("color-ink-3")), full);
  const close = await mText(".rl-plan-head", "Close plan");
  check('4c header: "✕ Close plan" is a 28px filled chip, r7', near(close.h, 28) && near(close.radius, 7) && close.bg === (await tok("color-fill-1", "backgroundColor")) && close.color === (await tok("color-ink-3")), close);
  check("4c header: Close plan is the last thing on the right, Full screen before it", close.x > full.x && near(close.right, plan.right - 14), { close: close.right, plan: plan.right });
  const article = await m(".rl-flow-plan .doc-article");
  check("4c body: a 680px column, padding 34/56, set on the panel's left edge", near(article.w, 680) && near(article.pt, 34) && near(article.pl, 56) && near(article.pr, 56) && near(article.x, plan.x), article);
  const title = await m(".rl-flow-plan .rl-prose h1");
  check("4c body: title 28px/1.25, 600, ink, serif", near(title.fontSize, 28) && near(title.lineHeight, 35) && title.fontWeight === "600" && title.color === (await tok("color-ink")) && !/sans/i.test(title.fontFamily.split(",")[0]), title);
  const lede = await m(".rl-flow-plan .rl-prose h1 + p");
  check("4c body: lede 16/1.65 in the muted ink", near(lede.fontSize, 16) && near(lede.lineHeight, 26.4) && lede.color === (await tok("color-ink-3")), lede);
  const h2 = await m(".rl-flow-plan .rl-prose h2");
  check("4c body: h2 19px, 600, ink", near(h2.fontSize, 19) && h2.fontWeight === "600" && h2.color === (await tok("color-ink")), h2);
  const body = await cdp.evaluate("window.__m([...document.querySelectorAll('.rl-flow-plan .rl-prose > p')].pop())");
  check("4c body: body 16/1.75 in the prose ink", near(body.fontSize, 16) && near(body.lineHeight, 28) && body.color === (await tok("color-ink-2")), body);
  check("4c body: blocks 16px apart, h2 6px more", near(lede.y - title.bottom, 16) && near(h2.y - lede.bottom, 22), { titleToLede: lede.y - title.bottom, ledeToH2: h2.y - lede.bottom });
  const mark = await m(".rl-flow-plan .rl-comment-highlight");
  check("4c mark: amber — a tinted run with a 2px amber rule under it", mark?.text === "0018_vault_revisions.sql before the next build" && mark.bb === 2 && mark.bbColor === (await tok("color-warning")) && mark.bg !== "rgba(0, 0, 0, 0)", mark);
  const note = await m(".rl-flow-plan .rl-margin-note");
  const who = await m(".rl-flow-plan .rl-margin-note-who");
  check("4c margin note: r10, 13px sans, indented 24px, under its block", note && near(note.radius, 10) && near(note.fontSize, 13) && /system|apple|sans/i.test(note.fontFamily) && near(note.x - (article.x + article.pl), 24) && note.text.endsWith("Run this against staging first, not prod."), note);
  check('4c margin note: a 20px amber "IM" disc', near(who.w, 20) && near(who.h, 20) && who.text === "IM" && who.bg === (await tok("color-warning", "backgroundColor")), who);
  const foot = await m(".rl-plan-foot");
  check("4c footer: 64px, 0 16 0 22, 13px, hairline above", near(foot.h, 64) && near(foot.pl, 22) && near(foot.pr, 16) && near(foot.fontSize, 13) && foot.bt === 1 && foot.btColor === (await tok("color-rule")), foot);
  const hint = await m(".rl-plan-foot .rl-context-hint");
  check('4c footer: "Select text to mark it." in the muted ink', hint.text === "Select text to mark it." && hint.color === (await tok("color-ink-4")) && near(hint.fontSize, 13), hint);
  const send = await mText(".rl-plan-foot", "Send marks to Claude");
  check('4c footer: "Send marks to Claude" — 34px, r9, outlined', near(send.h, 34) && near(send.radius, 9) && near(send.pl, 14) && send.bt === 1 && send.btColor === (await tok("color-rule-strong")) && send.color === (await tok("color-ink-3")), send);
  const approve = await cdp.evaluate("window.__m(document.querySelector('.rl-plan-split > .rl-plan-btn--primary'))");
  check('4c footer: "🔨 Approve & build" — 34px, r9, ink-filled, 600, 0 16', approve.text === "Approve & build" && near(approve.h, 34) && near(approve.radius, 9) && near(approve.pl, 16) && approve.bg === (await tok("color-ink", "backgroundColor")) && approve.color === (await tok("color-paper")) && approve.fontWeight === "600", approve);
  check("4c footer: the buttons sit 10px apart, against the right inset", near(approve.x - send.right, 10) && near(foot.right - (await m(".rl-plan-split")).right, 16), { gap: approve.x - send.right });
  // The plan card in the conversation (PlanReadyCard, "ready"), as the placeholder renders it.
  const card = await m('.rl-plan-card[data-variant="ready"]');
  const cardTitle = await m('.rl-plan-card[data-variant="ready"] .rl-plan-card-title');
  check('4c card: "Plan ready" — r12, padding 14, gap 10; title 13.5/600', card && near(card.radius, 12) && near(card.pt, 14) && near(card.pl, 14) && near(card.gap, 10) && cardTitle.text === "Plan ready" && near(cardTitle.fontSize, 13.5) && cardTitle.fontWeight === "600" && card.shadow.includes(`${await tok("color-focus-rim")} 0px 0px 0px 1px inset`), card);
  const link = await mText(".rl-plan-card", "Open in panel →");
  check('4c card: "Open in panel →" 11.5px in the muted ink', near(link.fontSize, 11.5) && link.color === (await tok("color-ink-4")), link);
  await sweep("4c", "aurora");

  // Contents in the split pose: the rail docks under the header, on the plan.
  await cdp.evaluate("window.__qa.setContents(true)"); await settle();
  const rail = await m(".rl-toc-rail"); const pane = await m(".rl-surface-pane");
  check("4c contents: the rail docks on the plan, under its header", near(rail.x - pane.x, 440) && near(rail.y - pane.y, 48) && near(pane.bottom - rail.bottom, 64), { rail, pane: { x: pane.x, y: pane.y, bottom: pane.bottom } });
  await screenshot("4c-contents-aurora");
  await cdp.evaluate("window.__qa.setContents(false)"); await settle();
  const zoom = await m(".rl-doc-zoom");
  check("4c: the zoom/width pill sits above the plan's footer", zoom.visible && near(pane.bottom - zoom.bottom, 80) && near(pane.right - zoom.right, 16), zoom);
  // A mark being written beside the chat: the composer on a glass sheet.
  await cdp.evaluate("window.__qa.setComposing(true)"); await settle();
  const sheet = await m(".rl-flow-compose-sheet");
  check("4c: a comment being written sits on a glass sheet over the plan's foot", sheet?.visible && /rl-glass/.test(await cdp.evaluate("document.querySelector('.rl-flow-compose-sheet').className")) && near((await m(".rl-plan-foot")).y - sheet.bottom, 14), sheet);
  await cdp.evaluate("window.__qa.setComposing(false)"); await settle();

  // The conversation keeps its identity across the poses: the same host
  // node, carried — detached while the Feedback tab has it out of sight.
  const host = '[data-portal-host="session-conversation"]';
  await cdp.evaluate(`window.__qaHost = document.querySelector('${host}')`);
  await click(".rl-plan-head-btn[aria-pressed=false]:not(.rl-plan-head-icon-btn)");
  const toFull = await cdp.evaluate(`({ pose: document.querySelector('.rl-flow-stage').dataset.pose, tab: document.querySelector('.rl-fb-tab[aria-selected=true]')?.textContent, connected: window.__qaHost.isConnected })`);
  check("4c → Full screen: full, and with marks waiting the panel opens on Feedback, the conversation waiting detached", toFull.pose === "full" && toFull.tab === "Feedback2" && !toFull.connected, toFull);
  await screenshot("4c-to-full-aurora");
  await cdp.evaluate("window.__qa.setTab('chat')"); await settle();
  const back = await cdp.evaluate(`({ same: document.querySelector('${host}') === window.__qaHost, inPanel: !!window.__qaHost.closest('.rl-flow-panel .rl-flow-convo[data-layout=panel]') })`);
  check("4c full, Chat tab: the same conversation node, now in the panel", back.same && back.inPanel, back);
  await cdp.evaluate("window.__qa.setPose('split')"); await settle();
  const home = await cdp.evaluate(`({ same: document.querySelector('${host}') === window.__qaHost, column: !!window.__qaHost.closest('.rl-flow-convo[data-layout=column]') })`);
  check("4c back to split: the same node is back in the column", home.same && home.column, home);
  // Close plan, then the narrow rule.
  await click(".rl-plan-head-close");
  const closed = await cdp.evaluate("({ pose: document.querySelector('.rl-flow-stage').dataset.pose, hidden: document.querySelector('.rl-flow-plan').hidden, zoom: getComputedStyle(document.querySelector('.rl-doc-zoom')).display, editor: !!document.querySelector('.rl-flow-plan .rl-prose') })");
  check("4c ✕ Close plan: closed, the plan hidden but mounted, the zoom pill waiting mounted", closed.pose === "closed" && closed.hidden && closed.zoom === "none" && closed.editor, closed);
  await cdp.evaluate("window.__qa.openPlan()"); await settle();
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 860, height: 800, deviceScaleFactor: 1, mobile: false }); await delay(200); await settle();
  check("narrow (<900px): split paints as full", (await cdp.evaluate("document.querySelector('.rl-flow-stage').dataset.pose")) === "full");
  await screenshot("4c-narrow-aurora");
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await delay(200); await settle();
  check("…and comes back to split when wide again", (await cdp.evaluate("document.querySelector('.rl-flow-stage').dataset.pose")) === "split");

  for (const theme of ["basic", "studio"]) {
    await load("4c", w, h, theme);
    await screenshot(`4c-${theme}`);
    const t = await m(".rl-flow-plan .rl-prose h1"), mk = await m(".rl-flow-plan .rl-comment-highlight");
    check(`4c ${theme}: the plan reads in its tokens`, t.color === (await tok("color-ink")) && mk.bbColor === (await tok("color-warning")) && (await m(".rl-flow-plan")).bg === (await tok("color-paper", "backgroundColor")), { title: t.color, mark: mk.bbColor });
    await sweep("4c", theme);
  }
}

async function board4d() {
  const [w, h] = VIEW["4d"];
  await load("4d", w, h);
  await screenshot("4d-aurora");
  const state = await cdp.evaluate("({ pose: document.querySelector('.rl-flow-stage').dataset.pose, hidden: document.querySelector('.rl-flow-plan').hidden })");
  check("4d: the plan is closed (and stays mounted, hidden)", state.pose === "closed" && state.hidden, state);
  const stage = await m(".rl-flow-stage"), convo = await m('.rl-flow-convo[data-layout="stage"]');
  check("4d: the conversation has the whole stage", near(convo.w, stage.w) && near(convo.h, stage.h), { convo, stage });
  const card = await m('.rl-plan-card[data-variant="inline"]');
  check('4d inline card: r12, padding 12/14, gap 10, 13.5px, the strong rim', card && near(card.radius, 12) && near(card.pt, 12) && near(card.pl, 14) && near(card.gap, 10) && near(card.fontSize, 13.5) && card.shadow.includes(`${await tok("color-rule-strong")} 0px 0px 0px 1px inset`), card);
  const t = await m('.rl-plan-card[data-variant="inline"] .rl-plan-card-title');
  const meta = await m('.rl-plan-card[data-variant="inline"] .rl-plan-card-meta');
  const open = await m('.rl-plan-card[data-variant="inline"] .rl-plan-card-open');
  check('4d inline card: "Plan · Din roadmap: next steps" · "2 marks" · "Open"', t.text === "Plan · Din roadmap: next steps" && meta.text === "2 marks" && meta.color === (await tok("color-ink-4")) && open.text === "Open" && open.color === (await tok("color-mode-plan-fg")), { t: t.text, meta, open });
  const icon = await m('.rl-plan-card[data-variant="inline"] .rl-plan-card-icon');
  check("4d inline card: the plan icon is plan-blue, 14px", near(icon.w, 14) && icon.color === (await tok("color-mode-plan-fg")), icon);
  await sweep("4d", "aurora");
  await click('.rl-plan-card[data-variant="inline"] .rl-plan-card-open');
  check("4d: Open puts the plan back beside the conversation", (await cdp.evaluate("document.querySelector('.rl-flow-stage').dataset.pose")) === "split");
  for (const theme of ["basic", "studio"]) {
    await load("4d", w, h, theme);
    await screenshot(`4d-${theme}`);
    await sweep("4d", theme);
  }
}

async function board5a() {
  const [w, h] = VIEW["5a"];
  await load("5a", w, h);
  await screenshot("5a-aurora");
  const pose = await cdp.evaluate("document.querySelector('.rl-flow-stage').dataset.pose");
  check("5a: the full pose", pose === "full", pose);
  const plan = await m(".rl-flow-plan"), panel = await m(".rl-flow-panel");
  check("5a: the plan in the centre (1600 − 260 − 400), on the paper", near(plan.w, 940) && near(plan.x, 260) && plan.bg === (await tok("color-paper", "backgroundColor")), plan);
  check("5a: the right panel is 400px with a hairline on its left", near(panel.w, 400) && panel.bl === 1 && panel.blColor === (await tok("color-rule")), panel);
  const head = await m('.rl-plan-head[data-pose="full"]');
  check("5a header: 48px, 0 16 0 24, 12.5px", near(head.h, 48) && near(head.pl, 24) && near(head.pr, 16) && near(head.fontSize, 12.5) && head.bb === 1, head);
  const contents = await m(".rl-plan-head-contents");
  check('5a header: "☰ Contents" at the left inset, secondary ink', contents.text === "Contents" && near(contents.x - plan.x, 24) && contents.color === (await tok("color-ink-3")), contents);
  const pill = await m(".rl-version-pill"), go = await m(".rl-version-pill-go");
  check('5a version pill: 30px, r8, 0 6 0 12, gap 10, amber, "Viewing v1 · read-only"', near(pill.h, 30) && near(pill.radius, 8) && near(pill.pl, 12) && near(pill.pr, 6) && near(pill.gap, 10) && pill.color === (await tok("color-mode-redline-fg")) && pill.text.startsWith("Viewing v1 · read-only"), pill);
  check('5a version pill: an inner 22px amber-filled "Go to v4", r6, 600', go.text === "Go to v4" && near(go.h, 22) && near(go.radius, 6) && near(go.pl, 9) && go.bg === (await tok("color-warning", "backgroundColor")) && go.fontWeight === "600", go);
  const full = await mText(".rl-plan-head", "Full screen");
  check('5a header: "Full screen" on the right inset, 28px, pressed', near(full.h, 28) && near(plan.right - full.right, 16) && (await cdp.evaluate("window.__byText('.rl-plan-head', 'Full screen').closest('button').getAttribute('aria-pressed')")) === "true", full);
  check("5a header: the pill centred between Contents and Full screen", near((pill.x - contents.right) - (full.x - pill.right), 0, 2), { left: pill.x - contents.right, right: full.x - pill.right });
  const article = await m(".rl-flow-plan .doc-article");
  check("5a body: a 720px column, centred, 40px from the header", near(article.w, 720) && near(article.x - plan.x, (940 - 720) / 2) && near(article.pt, 40), article);
  const title = await m(".rl-flow-plan .rl-prose h1"), h2 = await m(".rl-flow-plan .rl-prose h2");
  check("5a body: title 30px/1.25, h2 19px", near(title.fontSize, 30) && near(title.lineHeight, 37.5) && near(h2.fontSize, 19) && h2.fontWeight === "600", { title, h2 });
  const body = await m(".rl-flow-plan .rl-prose > p");
  check("5a body: 16.5/1.75 prose", near(body.fontSize, 16.5) && near(body.lineHeight, 28.875) && body.color === (await tok("color-ink-2")), body);
  const mark = await m(".rl-flow-plan .rl-comment-highlight");
  check("5a: the followed mark is plan-blue", mark && mark.bbColor === (await tok("color-info")) && mark.bb === 2 && mark.text.startsWith("The test throughout"), mark);
  const label = await m(".rl-flow-plan .rl-prose tr > :first-child"), cell = await m(".rl-flow-plan .rl-prose tr > :first-child + *");
  const table = await m(".rl-flow-plan .rl-prose table");
  check("5a decisions table: a 130px label column, hairline rows, 15/1.6", near(label.w, 130) && near(label.pt, 12) && label.bb === 1 && label.bbColor === (await tok("color-rule")) && table.bt === 1 && near(cell.fontSize, 15) && near(cell.lineHeight, 24) && label.color === (await tok("color-ink-3")), { label, cell, table: { bt: table.bt } });
  const foot = await m('.rl-plan-foot[data-pose="full"]');
  check("5a footer: 60px, 0 16 0 24, 13px", near(foot.h, 60) && near(foot.pl, 24) && near(foot.pr, 16) && near(foot.fontSize, 13) && foot.bt === 1, foot);
  const status = await m(".rl-plan-foot-status .rl-plan-foot-line");
  const faint = await m(".rl-plan-foot-terminals");
  const spin = await m(".rl-plan-foot .rl-stage-spin");
  check('5a footer: a green spinner, "Building v4: step 3 of 11" and a faint "· 1 terminal"', status.text.startsWith("Building v4: step 3 of 11") && status.color === (await tok("color-ink-3")) && faint.text === "· 1 terminal" && faint.color === (await tok("color-ink-5")) && spin.color === (await tok("color-mode-build-fg")) && near(spin.w, 13), { status: status.text, faint, spin: spin.color });
  const reopen = await mText(".rl-plan-foot", "Reopen plan");
  check('5a footer: "Reopen plan" — 34px, r9, outlined, at the right inset', near(reopen.h, 34) && near(reopen.radius, 9) && reopen.bt === 1 && near(foot.right - reopen.right, 16), reopen);
  // The right panel's header and Feedback tab are the feedback lane's; the
  // stage seats them. Measured here because the panel is the stage's cell.
  const ph = await m(".rl-fb-tabs");
  check("5a right panel header: 48px, 0 12, gap 4, 12.5px, hairline under", near(ph.h, 48) && near(ph.pl, 12) && near(ph.pr, 12) && near(ph.gap, 4) && near(ph.fontSize, 12.5) && ph.bb === 1, ph);
  const chat = await mText(".rl-fb-tabs", "Chat"), fb = await m('.rl-fb-tab[aria-selected="true"]'), count = await m(".rl-fb-tab-count");
  check('5a tabs: "Chat" quiet; "Feedback 16" selected — 28px, r7, the selected-row fill', near(chat.h, 28) && near(chat.pl, 10) && chat.color === (await tok("color-ink-4")) && fb.text === "Feedback16" && near(fb.h, 28) && near(fb.radius, 7) && fb.bg === (await tok("color-fill-2", "backgroundColor")) && fb.color === (await tok("color-ink")) && count.color === (await tok("color-ink-4")), { chat, fb, count });
  const all = await m(".rl-fb-tabs-status");
  check('5a: "All resolved" at 11.5px, muted, on the right', all?.text === "All resolved" && near(all.fontSize, 11.5) && all.color === (await tok("color-ink-4")) && near(panel.right - all.right, 12), all);
  await sweep("5a", "aurora");
  for (const theme of ["basic", "studio"]) {
    await load("5a", w, h, theme);
    await screenshot(`5a-${theme}`);
    await sweep("5a", theme);
  }
}

try {
  await mkdir(output, { recursive: true });
  server = await createServer({
    configFile: false, root, cacheDir: path.join(temporary, "vite-cache"),
    optimizeDeps: { entries: ["fixtures/flow-stage-qa/index.html"] },
    plugins: [react(), tailwindcss()],
    resolve: { alias: [{ find: /^@tauri-apps\/.*$/, replacement: service }] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null }, clearScreen: false,
  });
  await server.listen();
  report.fixtureUrl = `http://127.0.0.1:${server.httpServer.address().port}/fixtures/flow-stage-qa/`;
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
  await board4c();
  await board4d();
  await board5a();
} catch (error) { report.errors.push(String(error?.stack ?? error)); }
finally {
  report.finishedAt = new Date().toISOString();
  report.passed = !report.errors.length && report.checks.every((item) => item.passed);
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
  cdp?.close(); if (chrome) { chrome.kill("SIGTERM"); await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), delay(3000)]); if (chrome.exitCode === null) chrome.kill("SIGKILL"); }
  await server?.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failed: report.checks.filter((item) => !item.passed).map((c) => c.name), errors: report.errors, screenshots: report.screenshots.length, output }, null, 2));
if (!report.passed) process.exitCode = 1;
