#!/usr/bin/env node
// Real React components, synthetic service responses, and an isolated Chrome profile.
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
const output = path.resolve(root, process.argv[2] ?? "docs/front-door-qa-2026-10-10");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-browser-visual-qa-"));
const service = path.join(root, "fixtures/monochat-aurora-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/monochat-aurora-qa", screenshots: [], checks: [], errors: [], sourceSha256: {}, limitations: ["Headless Chrome component fixture; not WKWebView/native hit-testing or live Redline.", "Agent, dictation, audio and Tauri service interfaces are synthetic; no capture, database, user profile or agent launch.", "Document, browser page and recents contents are illustrative. Production chat, island, compact card, chips, setup, menus and theme components are imported intact."] };
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
function check(name, passed, details) { report.checks.push({ name, passed: !!passed, details }); if (!passed) console.error(`FAIL ${name}`, details); }
async function settle() { await cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"); await delay(80); }
async function click(selector) { const rect = await cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw new Error('Missing selector: '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`); await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...rect }); await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...rect }); await settle(); }
async function key(key, code = key, virtual = 0, modifiers = 0) { await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtual, modifiers }); await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtual, modifiers }); await settle(); }
async function screenshot(name) { const shot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); const file = `${name}.png`; await writeFile(path.join(output, file), Buffer.from(shot.data, "base64")); report.screenshots.push(file); }
async function bounds(selector) { return cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,visible:r.width>0&&r.height>0,within:r.x>=-1&&r.y>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1};})()`); }
try {
  await mkdir(output, { recursive: true });
  for (const file of ["src/hooks/useFrontDoorConversation.ts", "src/components/MonochatIsland.tsx", "src/components/MonochatIsland.css", "src/components/MonochatCard.tsx", "src/components/MonochatCard.css", "src/components/SurfaceChips.tsx", "src/lib/surfaceContext.ts", "src/components/ChatRoom.tsx", "src/components/MonochatTrace.tsx", "src/components/FrontDoor.tsx", "src/components/ComposerMenu.tsx", "src/components/ComposerMenu.css", "src/App.tsx", "src/components/IntegrationSetupDialog.tsx", "src/components/Footer.tsx", "src/styles.css"]) report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root,file))).digest("hex");
  server = await createServer({ configFile:false, root, cacheDir:path.join(temporary,"vite-cache"), optimizeDeps:{entries:["fixtures/monochat-aurora-qa/index.html"], include:["@tauri-apps/plugin-deep-link", "@tauri-apps/api/webview", "@tauri-apps/api/dpi", "@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-webgl"]}, plugins:[react(),tailwindcss()], resolve:{alias:[
    {find:/^.*\/hooks\/useAgentTurn$/,replacement:service}, {find:/^.*\/audio\/useReadAloud$/,replacement:service},
    ...["@tauri-apps/api/core","@tauri-apps/api/event","@tauri-apps/api/window","@tauri-apps/plugin-dialog","@tauri-apps/plugin-opener"].map(find=>({find,replacement:service}))
  ]},server:{host:"127.0.0.1",port:0,watch:{ignored:["**/src-tauri/**","**/docs/**"]}},clearScreen:false});
  await server.listen(); report.fixtureUrl=`http://127.0.0.1:${server.httpServer.address().port}/fixtures/monochat-aurora-qa/`;
  chrome=spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",["--headless=new",`--user-data-dir=${path.join(temporary,"chrome-profile")}`,"--remote-debugging-port=0","--remote-debugging-address=127.0.0.1","--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-sync","--disable-extensions","about:blank"],{stdio:"ignore"});
  let port; for(let i=0;i<150;i++){try{port=(await readFile(path.join(temporary,"chrome-profile/DevToolsActivePort"),"utf8")).split("\n")[0];break;}catch{} await delay(100);}
  if(!port)throw new Error("Chrome did not start");
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(); cdp=new CDP(targets.find(t=>t.type==="page").webSocketDebuggerUrl);
  await cdp.call("Page.enable");await cdp.call("Runtime.enable");await cdp.call("Log.enable");
  const card = () => bounds('.rl-monochat-float');
  // On screen and open: a card on its way back into the pill is leaving.
  const cardOpen = "!!document.querySelector('.rl-monochat-float:not([data-leaving])')";
  const cardGone = async () => { for (let i = 0; i < 30 && await cdp.evaluate("!!document.querySelector('.rl-monochat-float')"); i++) await delay(50); };
  const pose = "document.querySelector('.rl-monochat').dataset.pose";
  const doorComposer = "document.querySelector('.rl-frontdoor-focus [data-chat-composer] textarea')";
  const move = (x, y) => cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  const press = async (point) => { await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point}); await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point}); };
  const centre = (selector) => cdp.evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  // Frame by frame, in the page: `probe` is an expression read every frame
  // into `window[name]` (a promise of the frames) until `frames` are in.
  const film = (name, probe, frames = 30) => cdp.evaluate(`void (window.${name} = new Promise(resolve => { const out = []; const t0 = performance.now(); (function tick() { const v = (${probe}); if (v) out.push({ t: Math.round(performance.now() - t0), ...v }); if (out.length < ${frames} && performance.now() - t0 < 4000) requestAnimationFrame(tick); else resolve(out); })(); }))`);
  const rectOf = (selector) => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`;
  // Every visible text in a subtree, with its WCAG contrast on what it is painted on.
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
      if (el.tagName === 'TEXTAREA' && el.placeholder && !el.value) out.push({ text: 'placeholder: ' + el.placeholder, ratio: ratio(over(rgba(getComputedStyle(el, '::placeholder').color), bg), bg) });
    }
    probe.remove(); return out;
  }`;
  // Every control in a subtree smaller than 24 × 24 (WCAG 2.5.8).
  const smallTargets = (rootSelector) => cdp.evaluate(`[...document.querySelectorAll(${JSON.stringify(rootSelector)} + ' :is(button, a[href], [role=button], [tabindex="0"])')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && getComputedStyle(e).visibility === 'visible' && !e.closest('[aria-hidden=true], [hidden]') && (r.width < 24 || r.height < 24); }).map(e => (e.getAttribute('aria-label') || e.textContent.trim()).slice(0, 24) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))`);
  for(const [width,height] of [[1440,960],[900,640],[480,720]]) {
    const size=`${width}x${height}`;
    await cdp.call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
    await cdp.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
    await cdp.call("Page.navigate",{url:report.fixtureUrl});
    let ready=false;for(let i=0;i<150;i++){if(await cdp.evaluate("document.documentElement.dataset.qaReady==='true'")){ready=true;break;}await delay(100);}
    if(!ready)throw new Error(`Fixture did not render: ${report.errors.join("\n")}`);
    await delay(700); await settle();
    // Boot on the empty plate: the door rests there — headline, composer,
    // recents — with no pill and no caret taken.
    await screenshot(`${size}-rest`);
    const footer = await bounds('.rl-app-footer');
    check(`${size} boot rests the door on the empty plate`, await cdp.evaluate(`${pose}==='entry'`) && !!await cdp.evaluate("document.querySelector('.rl-fd-welcome-hero h1')?.textContent.includes('Every build starts as a draft.')"));
    check(`${size} boot takes no caret and opens nothing modal`, await cdp.evaluate("document.activeElement===document.body && !document.querySelector('[aria-modal]') && !document.querySelector('.qa-nav').closest('[inert]')"));
    check(`${size} no pill while the door rests`, await cdp.evaluate("getComputedStyle(document.querySelector('.rl-monochat-notch')).visibility==='hidden'"));
    check(`${size} recents sit below the composer`, await cdp.evaluate("(() => { const r=document.querySelector('[aria-label=\"Jump back in\"]'); const i=document.querySelector('.rl-frontdoor-focus .rl-fd-island'); return !!r && r.getBoundingClientRect().top >= i.getBoundingClientRect().bottom - 1; })()"));
    check(`${size} page recents never scroll`, await cdp.evaluate("(() => { const l=document.querySelector('.rl-fd-browse-list'); return !l || l.scrollHeight <= l.clientHeight + 1; })()"));
    check(`${size} tour anchor measurable at rest`, (await bounds('[data-tour="landing"]'))?.visible);
    check(`${size} every target in the resting door is at least 24 × 24`, (await smallTargets('.rl-frontdoor-focus')).length === 0, await smallTargets('.rl-frontdoor-focus'));
    // A press in the resting composer engages it. Only the paper changes: the
    // composer — and the caret in it — never moves, on any frame (the check
    // 58020d9 failed by 27 px while the layer's insets glided).
    await film('__qaEngage', `{ ...${rectOf('.rl-frontdoor-focus .rl-fd-island')}, paper: Number(getComputedStyle(document.querySelector('.rl-frontdoor-focus'), '::before').opacity), flights: document.querySelector('.rl-monochat').getAnimations().length }`, 24);
    const restBox = await bounds('.rl-frontdoor-focus .rl-fd-island');
    await press(await centre('.rl-frontdoor-focus .rl-fd-input'));
    const engage = await cdp.evaluate('window.__qaEngage');
    const shift = Math.max(...engage.map(f => Math.max(Math.abs(f.x - restBox.x), Math.abs(f.y - restBox.y), Math.abs(f.w - restBox.width), Math.abs(f.h - restBox.height))));
    check(`${size} home focus keeps composer and caret in place throughout transition`, await cdp.evaluate(`document.activeElement===document.querySelector('.rl-frontdoor-focus .rl-fd-input')`) && engage.every(f => f.flights === 0) && shift < 1, { shift, frames: engage.length });
    check(`${size} focus backdrop fades to opaque`, engage[0].paper < 1 && engage.at(-1).paper === 1, engage.map(f => f.paper));
    check(`${size} a press engages the resting door as a modal`, await cdp.evaluate(`${pose}==='conversation'`) && await cdp.evaluate("!!document.querySelector('[role=dialog][aria-modal=true]')"));
    check(`${size} the welcome stays until a keystroke`, await cdp.evaluate("!document.querySelector('.rl-frontdoor-focus .rl-frontdoor').classList.contains('is-engaged')"));
    await cdp.call("Input.insertText",{text:"Plan the billing export"}); await settle();
    const typedBox = await bounds('.rl-frontdoor-focus .rl-fd-island');
    check(`${size} typing fades the welcome and keeps the composer in place`, await cdp.evaluate("document.querySelector('.rl-frontdoor-focus .rl-frontdoor').classList.contains('is-engaged')") && Math.abs(typedBox.y-restBox.y)<1, { restBox, typedBox });
    await screenshot(`${size}-engaged`);
    await cdp.evaluate("window.__qa.setText('')"); await settle();
    await key('Escape','Escape',27);
    check(`${size} Esc returns the door to rest, with no flight`, await cdp.evaluate(`${pose}==='entry' && !document.querySelector('.rl-frontdoor-focus[data-closing]')`));
    // Document surface: the pill, centred in the footer row.
    await cdp.evaluate("window.__qa.setSurface('Document')"); await settle();
    const pill = await bounds('.rl-monochat-notch');
    const membrane = await bounds('.rl-portal-membrane');
    check(`${size} pill centred in the footer row`, Math.abs(pill.x+pill.width/2-width/2)<1 && Math.abs(pill.y+pill.height/2-footer.y-footer.height/2)<1 && pill.width===160 && pill.height===40, { pill, footer });
    check(`${size} pill clear of footer controls`, pill.x>=(await bounds('.rl-footer-status')).right && pill.right<=(await bounds('.rl-footer-actions')).x);
    // 10/11: the brand's mark and the door's one name, inside the same
    // 144 × 32 skin — no tricolour bars, no draft dot, no count.
    const pillFace = () => cdp.evaluate("(() => { const m=document.querySelector('.rl-portal-membrane'), svg=m.querySelector('svg'), label=m.querySelector('.rl-pill-label'), r=svg.getBoundingClientRect(), l=label.getBoundingClientRect(), b=m.getBoundingClientRect(); return { label: label.textContent, name: document.querySelector('.rl-monochat-notch').getAttribute('aria-label'), children: m.children.length, mark: [r.width, r.height], markInside: r.left >= b.left && r.right <= l.left && r.top >= b.top && r.bottom <= b.bottom, labelInside: l.right <= b.right - 12 && label.scrollWidth <= label.clientWidth, extras: m.querySelectorAll('.rl-monochat-signal, .rl-monochat-draft, .rl-monochat-news').length }; })()");
    const face = await pillFace();
    check(`${size} the pill's skin stays 144 × 32`, Math.round(membrane.width) === 144 && Math.round(membrane.height) === 32, membrane);
    check(`${size} the pill reads "Plan a build" beside the 14 px mark, uncut`, face.label === 'Plan a build' && face.name === 'Plan a build' && face.children === 2 && face.mark[0] === 14 && face.mark[1] === 14 && face.markInside && face.labelInside && face.extras === 0, face);
    await screenshot(`${size}-pill`);
    await cdp.evaluate(`window.__qa.setText('Plan the billing export')`); await settle();
    const drafted = await pillFace();
    check(`${size} a waiting draft is "Continue draft", uncut`, drafted.label === 'Continue draft' && drafted.name === 'Continue draft' && drafted.labelInside && drafted.extras === 0, drafted);
    await cdp.evaluate(`window.__qa.setText('')`); await cdp.evaluate("window.__qa.setBusy(true)"); await settle();
    const spinning = await cdp.evaluate("document.querySelector('.rl-portal-membrane .rl-pulse-blades').getAnimations().filter(a => a.playState === 'running').length");
    const working = await pillFace();
    check(`${size} working, the mark's strike spins and the pill still says what a press does`, spinning > 0 && working.label === 'Working' && working.name === 'Working, plan a build', { spinning, working });
    await cdp.evaluate("window.__qa.setBusy(false)"); await settle();
    // News that moves nothing (R12, R14): an arrival changes nothing on the
    // pill; a review an agent waits on is a chip in the footer, clear of it.
    await cdp.evaluate("window.__qa.setReviewNews('Review ready')"); await settle();
    const news = await pillFace();
    check(`${size} news never changes the pill`, news.label === 'Plan a build' && news.extras === 0 && await cdp.evaluate(`${pose}==='notch' && !document.querySelector('.rl-monochat-float')`), news);
    // The app never gets narrower than 900 px (tauri.conf minWidth); below
    // that the footer is the fixture's, not a window anyone can have.
    if (width >= 900) {
      const chip = await bounds('.rl-footer-status button[title="Open the review surface"]');
      const status = await bounds('.rl-footer-status');
      check(`${size} a waiting review is a footer chip, 24 px tall, in full view and clear of the pill`, chip?.visible && chip.height >= 24 && chip.x >= status.x && chip.right <= status.right && chip.right <= pill.x && await cdp.evaluate("document.querySelector('.rl-footer-status button[title=\"Open the review surface\"]').textContent==='Review ready → Open'"), { chip, status, pill });
    }
    await screenshot(`${size}-news`);
    await cdp.evaluate("window.__qa.setReviewNews(null)"); await settle();
    // Setup left to finish waits in the composer as one chip, in the door and
    // the card alike — never a dialog that pops up by itself.
    await cdp.evaluate("window.__qa.setSetupFault(true)"); await cdp.evaluate("window.__qa.setOpen(true)"); await delay(450); await settle();
    const fix = await bounds('.rl-frontdoor-focus .rl-fd-setup');
    check(`${size} setup to finish is a chip in the door's composer, not a dialog`, fix?.visible && fix.height >= 24 && await cdp.evaluate("(() => { const c=document.querySelector('.rl-frontdoor-focus .rl-fd-setup').getBoundingClientRect(), i=document.querySelector('.rl-frontdoor-focus .rl-fd-island').getBoundingClientRect(); return c.left>=i.left && c.right<=i.right && c.top>=i.top && c.bottom<=i.bottom && !document.querySelector('dialog:modal'); })()"), fix);
    await screenshot(`${size}-setup-chip`);
    await cdp.evaluate("window.__qa.setOpen(false)"); await delay(400);
    await cdp.evaluate("window.__qa.setCompact(true)"); await delay(700); await settle();
    check(`${size} the card shows the same one chip, once`, await cdp.evaluate("document.querySelectorAll('.rl-monochat-float .rl-fd-setup').length===1 && !document.querySelector('.rl-monochat-float .rl-fd-strip')?.textContent.includes('integration')"));
    await cdp.evaluate("window.__qa.setCompact(false)"); await cdp.evaluate("window.__qa.setSetupFault(false)"); await cardGone(); await settle();
    // Tabbing onto the pill rings and lights it, and opens nothing (WCAG 3.2.1).
    await cdp.evaluate("document.querySelector('#qa-document-focus').focus()");
    for (let i = 0; i < 40 && !await cdp.evaluate("document.activeElement?.classList.contains('rl-monochat-notch')"); i++) await key('Tab','Tab',9);
    await delay(500);
    check(`${size} tabbing onto the pill rings it and opens nothing`, await cdp.evaluate("document.activeElement.classList.contains('rl-monochat-notch') && document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle !== 'none' && !document.querySelector('.rl-monochat-float') && document.querySelector('.rl-monochat').dataset.pose === 'notch'"));
    await screenshot(`${size}-pill-focus`);
    // Hover springs the compact card out, without the caret: out of the
    // pill's own box, the content following behind the shell.
    await cdp.evaluate("document.querySelector('#qa-document-focus').focus()");
    await film('__qaCardOpen', `(() => { const c = document.querySelector('.rl-monochat-float'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, content: Number(getComputedStyle(c.firstElementChild).opacity) }; })()`, 40);
    await move(pill.x+pill.width/2, pill.y+pill.height/2);
    for (let i = 0; i < 40 && !await cdp.evaluate("!!document.querySelector('.rl-monochat-float')"); i++) await delay(20);
    await delay(90);
    await screenshot(`${size}-card-opening`);
    await delay(900); await settle();
    const opening = await cdp.evaluate('window.__qaCardOpen');
    const peek = await card();
    const growing = opening.filter(f => f.w > membrane.width + 4 && f.w < peek.width - 4);
    check(`${size} the card springs out of the pill's box, frame by frame`, opening.length > 5 && opening[0].w < peek.width * 0.5 && Math.abs(opening[0].x + opening[0].w / 2 - (membrane.x + membrane.width / 2)) < 30 && growing.length >= 3 && Math.abs(opening.at(-1).w - peek.width) < 1, { first: opening[0], growing: growing.length, last: opening.at(-1), membrane, peek });
    check(`${size} the card's content follows the shell in`, opening[0].content < 0.2 && opening.at(-1).content === 1, opening.map(f => +f.content.toFixed(2)));
    check(`${size} a resting pointer springs the compact card out without taking focus`, await cdp.evaluate(cardOpen) && await cdp.evaluate("document.activeElement.id==='qa-document-focus'"));
    check(`${size} the card is bounded, centred and above the pill`, peek?.within && Math.abs(peek.x + peek.width/2 - width/2) < 1 && peek.width <= 641 && peek.bottom <= pill.y + 1, { peek, pill });
    check(`${size} the card is a region named by its heading`, await cdp.evaluate("(() => { const c=document.querySelector('.rl-monochat-float'); return c.getAttribute('role')==='region' && document.getElementById(c.getAttribute('aria-labelledby'))?.tagName==='H2'; })()"));
    // A plan on screen offers no chip (10/11): nothing rides along unseen.
    check(`${size} the card on a plan carries no context chip`, await cdp.evaluate("!document.querySelector('.rl-monochat-float .rl-context-chips button')"));
    check(`${size} the card holds no headline, recents or History`, await cdp.evaluate("!document.querySelector('.rl-monochat-float h1, .rl-monochat-float [aria-label=\"Jump back in\"], .rl-monochat-float [aria-label=\"Conversation history\"]')"));
    check(`${size} the card never scrolls sideways`, await cdp.evaluate("(() => { const c=document.querySelector('.rl-monochat-float'); return c.scrollWidth <= c.clientWidth && getComputedStyle(c).overflowX==='hidden'; })()"));
    check(`${size} the pill stays a live target while the card is out`, await cdp.evaluate("getComputedStyle(document.querySelector('.rl-monochat-notch')).visibility==='visible'"));
    check(`${size} every target in the card is at least 24 × 24`, (await smallTargets('.rl-monochat-float')).length === 0, await smallTargets('.rl-monochat-float'));
    await screenshot(`${size}-card-document`);
    // Leaving an untouched card: after the grace it goes back into the pill.
    await film('__qaCardClose', `(() => { const c = document.querySelector('.rl-monochat-float[data-leaving]'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`, 30);
    await move(20, height/2); await delay(350 + 90);
    await screenshot(`${size}-card-closing`);
    await delay(500); await settle();
    const closing = await cdp.evaluate('window.__qaCardClose');
    check(`${size} leaving an untouched card closes it, back into the pill`, !await cdp.evaluate("!!document.querySelector('.rl-monochat-float')") && closing.length >= 3 && Math.abs(closing.at(-1).w - membrane.width) < 12 && closing.at(-1).t - closing[0].t <= 260, { frames: closing.length, first: closing[0], last: closing.at(-1), membrane });
    // Pinned by a press inside; a press outside still closes it — and lands.
    await move(pill.x+pill.width/2, pill.y+pill.height/2); await delay(1200); await settle();
    await click('.rl-monochat-float .rl-fd-input');
    await move(20, height/2); await delay(700); await settle();
    check(`${size} a press inside pins the card`, await cdp.evaluate(cardOpen));
    // Bare title bar is a window drag, not "outside"; its buttons are.
    await press({ x: 40, y: 50 }); await settle();
    check(`${size} a press on bare title bar leaves the card open`, await cdp.evaluate(cardOpen));
    await click('.qa-nav button:nth-of-type(4)');
    check(`${size} a press outside closes it and still lands`, !await cdp.evaluate(cardOpen) && await cdp.evaluate("!!document.querySelector('.qa-discussion')"));
    await cardGone();
    await cdp.evaluate("window.__qa.setSidecar(false)"); await settle();
    // A click on the pill grows the card into the door: out of the card's
    // own box, the draft and the caret's place carried along.
    await move(pill.x+pill.width/2, pill.y+pill.height/2); await delay(1200); await settle();
    await click('.rl-monochat-float .rl-fd-input');
    await cdp.call("Input.insertText",{text:"Grow this sentence"}); await settle();
    await cdp.evaluate("document.querySelector('.rl-monochat-float textarea').setSelectionRange(5, 9)");
    const cardBox = await card();
    await film('__qaGrow', `document.querySelector('.rl-frontdoor-focus[data-open=true]') ? { ...${rectOf('.rl-frontdoor-focus .rl-frontdoor')}, paper: Number(getComputedStyle(document.querySelector('.rl-frontdoor-focus'), '::before').opacity) } : null`, 30);
    await press(await centre('.rl-monochat-notch')); await delay(120);
    await screenshot(`${size}-door-growing`);
    await delay(500); await settle();
    const grow = (await cdp.evaluate('window.__qaGrow')).filter(f => f.w);
    const doorBox = await bounds('.rl-frontdoor-focus .rl-frontdoor');
    check(`${size} the door grows out of the card's box`, grow.length > 5 && Math.abs(grow[0].x - cardBox.x) < 8 && Math.abs(grow[0].w - cardBox.width) < 12 && Math.abs(grow.at(-1).w - doorBox.width) < 1, { first: grow[0], cardBox, last: grow.at(-1), doorBox });
    check(`${size} the paper fades in behind it`, grow[0].paper < 0.5 && grow.at(-1).paper === 1, grow.map(f => +f.paper.toFixed(2)));
    check(`${size} a click on the pill opens the full door with the caret where the card had it`, !await cdp.evaluate("!!document.querySelector('.rl-monochat-float')") && await cdp.evaluate(`${pose}==='conversation'`) && await cdp.evaluate(`document.activeElement===${doorComposer} && ${doorComposer}.value==='Grow this sentence' && ${doorComposer}.selectionStart===5 && ${doorComposer}.selectionEnd===9`));
    await cdp.evaluate("window.__qa.setText('')"); await delay(400); await settle();
    check(`${size} the door wears its headline`, await cdp.evaluate("!!document.querySelector('.rl-frontdoor-focus .rl-fd-welcome-hero h1') && getComputedStyle(document.querySelector('.rl-fd-welcome-hero')).opacity === '1'"));
    check(`${size} every target in the door is at least 24 × 24`, (await smallTargets('.rl-frontdoor-focus')).length === 0, await smallTargets('.rl-frontdoor-focus'));
    await screenshot(`${size}-door`);
    for (const label of ['Choose project','Destination']) {
      await click(`.rl-frontdoor-focus [aria-label="${label}"]`);
      check(`${size} ${label} menu bounded`,(await bounds(`[role="menu"][aria-label="${label}"]`))?.within);
      await key('Escape','Escape',27);
      check(`${size} ${label} Escape keeps the door open`, await cdp.evaluate(`${pose}==='conversation'`));
    }
    // Closing goes back toward the pill: still painted, already inert, then gone.
    const openBox = await bounds('.rl-frontdoor-focus .rl-frontdoor');
    await film('__qaShut', `document.querySelector('.rl-frontdoor-focus[data-closing]') ? { ...${rectOf('.rl-frontdoor-focus .rl-frontdoor')}, inert: document.querySelector('.rl-frontdoor-focus').inert } : null`, 30);
    await click('[aria-label="Return to workspace"]');
    await screenshot(`${size}-door-closing`);
    await delay(500); await settle();
    const shut = await cdp.evaluate('window.__qaShut');
    check(`${size} ⌄ returns to the workspace, the door falling back toward the pill`, await cdp.evaluate(`${pose}==='notch' && !document.querySelector('.rl-frontdoor-focus[data-closing]') && getComputedStyle(document.querySelector('.rl-frontdoor-focus')).visibility==='hidden'`) && shut.length >= 3 && shut.every(f => f.inert) && shut.at(-1).w < openBox.width * 0.6 && shut.at(-1).y > openBox.y, { frames: shut.length, first: shut[0], last: shut.at(-1) });
    // Shift+Enter summons from the document, never from a text field.
    await cdp.evaluate("document.querySelector('#qa-document-focus').focus()");
    await film('__qaWelcome', `document.querySelector('.rl-frontdoor-focus[data-open=true]') ? { hero: Number(getComputedStyle(document.querySelector('.rl-fd-welcome-hero')).opacity) } : null`, 30);
    await key('Enter','Enter',13,8); await delay(500);
    const welcomeIn = (await cdp.evaluate('window.__qaWelcome')).map(f => f.hero);
    check(`${size} the welcome fades in once the door is on its way`, welcomeIn[0] < 0.1 && welcomeIn.at(-1) === 1 && welcomeIn.some(o => o > 0.1 && o < 0.9), welcomeIn.map(o => +o.toFixed(2)));
    check(`${size} Shift+Enter summons the door with the caret at the end of the draft`, await cdp.evaluate(`${pose}==='conversation'`) && await cdp.evaluate(`document.activeElement===${doorComposer} && ${doorComposer}.selectionStart===${doorComposer}.value.length`));
    await key('Escape','Escape',27);
    check(`${size} Esc returns focus to the document`, await cdp.evaluate("document.activeElement.id==='qa-document-focus'"));
    await cdp.evaluate("window.__qa.setSidecar(true)"); await settle();
    await cdp.evaluate("document.querySelector('[aria-label=\"Anchored reply\"]').focus()");
    await key('Enter','Enter',13,8);
    check(`${size} Shift+Enter in a text field stays that field's newline`, await cdp.evaluate(`${pose}==='notch'`));
    await cdp.evaluate("window.__qa.setSidecar(false)"); await settle();
    // Navigating from inside the card lands the caret in the new surface's main area.
    await move(20, height/2); await move(pill.x+pill.width/2, pill.y+pill.height/2); await delay(1200); await settle();
    await click('.rl-monochat-float .rl-fd-input');
    await cdp.evaluate("window.__qa.setSurface('Browser')"); await settle();
    check(`${size} navigation hands the caret to the new surface's main area`, await cdp.evaluate("document.activeElement === document.querySelector('.rl-doc-column') && !document.querySelector('.rl-monochat-float:not([data-leaving])')"));
    await cardGone();
    // Browser surface: This page / Task list, Plan and Run only.
    await move(20, height/2); await move(pill.x+pill.width/2, pill.y+pill.height/2); await delay(1200); await settle();
    check(`${size} the browser card keeps This page and Task list`, await cdp.evaluate("[...document.querySelectorAll('.rl-monochat-float .rl-context-chips button')].map(b=>b.textContent+':'+b.getAttribute('aria-pressed')).join()==='This page:true,Task list:false'"));
    await click('.rl-monochat-float [aria-label="Destination"]');
    check(`${size} the browser card offers Plan and Run alone`, await cdp.evaluate("[...document.querySelectorAll('[role=menu][aria-label=Destination] [role=menuitemradio]')].map(b=>b.textContent).join('|').match(/Plan a build|Just run it/g)?.length===2 && document.querySelectorAll('[role=menu][aria-label=Destination] [role=menuitemradio]').length===2"));
    await key('Escape','Escape',27);
    await screenshot(`${size}-card-browser`);
    await click('.qa-nav strong');
    await cardGone();
    // A chat takes the room at the room's size; its heading carries the one New.
    await cdp.evaluate("window.__qa.openChat('qa')"); await delay(500); await settle();
    const chat = await bounds('.rl-monochat');
    check(`${size} a chat opens in the room`, await cdp.evaluate(`${pose}==='conversation'`) && chat.within && !!await cdp.evaluate("document.querySelector('.rl-monochat [data-chat-messages]')?.textContent.includes('How do we preserve')"), chat);
    check(`${size} one composer, at the bottom of the thread`, await cdp.evaluate("document.querySelectorAll('textarea[aria-label=\"Message Redline\"]').length===1"));
    check(`${size} one New, in the room's heading`, await cdp.evaluate("document.querySelectorAll('.rl-monochat-new').length===1 && document.querySelector('.rl-monochat-heading h2')?.textContent==='Redline Aurora'"));
    await screenshot(`${size}-chat`);
    check(`${size} the window-drag strip never covers the room's heading`, await cdp.evaluate("(() => { const r=document.querySelector('.rl-monochat-new').getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.rl-monochat-new') != null; })()"));
    await click('.rl-monochat-new'); await settle();
    check(`${size} New returns to a blank composer`, await cdp.evaluate("!document.querySelector('[data-chat-room]') && !!document.querySelector('.rl-frontdoor-focus [data-chat-composer] textarea')"));
    await cdp.evaluate("window.__qa.setSetup(true)");await settle();
    check(`${size} setup remains accessible above the door`,await cdp.evaluate("!!document.querySelector('dialog:modal')"));
    await key('Escape','Escape',27);
    await click('[aria-label="Return to workspace"]'); await delay(400); await settle();
    // Reduced motion: nothing travels — the card and the door crossfade.
    await cdp.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]}); await settle();
    check(`${size} reduced motion disables attraction`,await cdp.evaluate("document.querySelector('.rl-portal-membrane').style.getPropertyValue('--portal-pull')===''"));
    await cdp.evaluate("window.__qa.setBusy(true)"); await settle();
    check(`${size} reduced motion: the working mark stays still`, await cdp.evaluate("document.querySelector('.rl-portal-membrane .rl-pulse-blades').getAnimations().length === 0 && document.querySelector('.rl-pill-label').textContent === 'Working'"));
    await cdp.evaluate("window.__qa.setBusy(false)"); await settle();
    const flightKinds = (selector) => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e ? e.getAnimations().map(a => [...new Set(a.effect.getKeyframes().flatMap(k => Object.keys(k).filter(p => !['offset', 'easing', 'composite', 'computedOffset'].includes(p))))].join('+') + '@' + a.effect.getTiming().duration) : null; })()`;
    await film('__qaReducedCard', `(() => { const k = ${flightKinds('.rl-monochat-float')}; return k && k.length ? { k } : null; })()`, 3);
    await move(20, height/2); await move(pill.x+pill.width/2, pill.y+pill.height/2); await delay(1000); await settle();
    const reducedCard = await cdp.evaluate('window.__qaReducedCard');
    check(`${size} reduced motion: the card crossfades in 120 ms`, reducedCard.length > 0 && reducedCard.every(f => f.k.every(kind => kind === 'opacity@120')), reducedCard);
    await move(20, height/2); await delay(700); await settle();
    await film('__qaReducedDoor', `(() => { const k = ${flightKinds('.rl-monochat')}; return k && k.length ? { k } : null; })()`, 3);
    await click('.rl-monochat-notch'); await delay(300); await settle();
    const reducedDoor = await cdp.evaluate('window.__qaReducedDoor');
    check(`${size} reduced motion: the door crossfades in 120 ms`, await cdp.evaluate(`${pose}==='conversation'`) && reducedDoor.length > 0 && reducedDoor.every(f => f.k.every(kind => kind === 'opacity@120')), reducedDoor);
    await key('Escape','Escape',27); await delay(300);
    await cdp.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
    // Every text in the door and the card, in every theme, at 4.5:1.
    if (size === "1440x960") {
      const themes = await cdp.evaluate("import('/src/theme/themes.ts').then(m => m.THEMES.map(t => t.name))");
      const short = [];
      await cdp.evaluate(contrastSweep);
      await cdp.evaluate("window.__qa.setSurface('Document')"); await cdp.evaluate("window.__qa.setSetupFault(true)"); await settle();
      for (const theme of themes) {
        await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(theme)})`); await delay(450);
        await cdp.evaluate("window.__qa.setOpen(true)"); await delay(450);
        for (const r of await cdp.evaluate("window.__qaContrast('.rl-frontdoor-focus', 'paper')")) if (r.ratio < 4.5) short.push(`${theme} door ${r.text}: ${r.ratio.toFixed(2)}`);
        await cdp.evaluate("window.__qa.setOpen(false)"); await delay(400);
        await cdp.evaluate("window.__qa.setCompact(true)"); await delay(700);
        for (const r of await cdp.evaluate("window.__qaContrast('.rl-monochat-float', 'bg-elevated')")) if (r.ratio < 4.5) short.push(`${theme} card ${r.text}: ${r.ratio.toFixed(2)}`);
        await cdp.evaluate("window.__qa.setCompact(false)"); await delay(400);
      }
      check(`every text in the door and the card reaches 4.5:1 in all ${themes.length} themes`, themes.length === 15 && short.length === 0, short);
      await cdp.evaluate("window.__qa.setTheme('aurora')"); await cdp.evaluate("window.__qa.setSetupFault(false)");
    }
  }
  // The recents (10/11): the 10-04 table — Plans and Chats as labelled rows
  // in even columns, pages full width below — on one edge and one 4 px
  // scale, titles whole where their column has room and cut only at a word
  // where it has not. Real-length titles, plain and in the shell (sessions
  // sidebar + open terminal dock).
  const boot = async (width, height, query) => {
    await cdp.call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
    await cdp.call("Page.navigate",{url:`${report.fixtureUrl}?${query}`});
    let ready=false;for(let i=0;i<150;i++){try{if(await cdp.evaluate("document.documentElement.dataset.qaReady==='true'")){ready=true;break;}}catch{}await delay(100);}
    if(!ready)throw new Error(`Fixture did not render: ${report.errors.join("\n")}`);
    await delay(700); await settle();
  };
  const recentsGeometry = `(() => {
    const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
    const group = document.querySelector('[aria-label="Jump back in"]'), table = group.querySelector('.rl-fd-recent-chips');
    const input = document.querySelector('.rl-frontdoor-focus .rl-fd-input'), layer = document.querySelector('.rl-frontdoor-focus');
    const inputText = input.getBoundingClientRect().x + parseFloat(getComputedStyle(input).paddingLeft);
    const rows = [...table.querySelectorAll('.rl-fd-recent-row')].map(row => ({ kind: row.dataset.kind, head: box(row.querySelector('.rl-fd-recent-head')), entries: [...row.querySelectorAll('.rl-fd-recent')].map(e => ({ ...box(e), label: e.getAttribute('aria-label'), text: e.querySelector('.rl-fd-recent-title').textContent.replace(/\u2011/g, '-'), lines: Math.round(e.querySelector('.rl-fd-recent-title').getBoundingClientRect().height / 20) })) }));
    const columns = getComputedStyle(table).gridTemplateColumns.split(' ').map(parseFloat);
    const section = group.querySelector('.rl-fd-browse-section');
    const pages = [...group.querySelectorAll('.rl-fd-browse')].map(e => ({ ...box(e), text: e.querySelector('.rl-fd-browse-title').getBoundingClientRect().x }));
    return { inputText, layerBottom: layer.getBoundingClientRect().bottom, table: box(table), columns, rows, pages,
      heads: [...group.querySelectorAll('.rl-fd-recent-head')].map(h => h.getBoundingClientRect().x + parseFloat(getComputedStyle(h).paddingLeft)),
      searches: section ? { head: box(section.querySelector('.rl-fd-recent-head')), empty: section.hasAttribute('data-empty'), visibility: getComputedStyle(section).visibility } : null,
      scrolls: document.scrollingElement.scrollHeight > innerHeight + 1 || [...group.querySelectorAll('*')].some(e => e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY)) };
  })()`;
  // Whole, or cut after a whole word of the label with "…".
  const wholeWords = (entry) => entry.text === entry.label || (entry.text.endsWith('…') && entry.label.split(' ').some((_, i, words) => words.slice(0, i + 1).join(' ').replace(/[\s,;:·—–-]+$/u, '') === entry.text.slice(0, -1)));
  for (const [width, height] of [[1440, 900], [1100, 760]]) for (const shell of [false, true]) for (const set of ["long", "vlong"]) {
    if (set === "vlong" && shell) continue;
    const tag = `${width}x${height}-recents-${set}${shell ? "-shell" : ""}`;
    await boot(width, height, `recents=${set}${shell ? "&shell=1" : ""}`);
    const g = await cdp.evaluate(recentsGeometry);
    const entries = g.rows.flatMap(row => row.entries);
    await screenshot(tag);
    check(`${tag}: titles are whole, or cut only after a whole word`, entries.length >= 3 && entries.every(wholeWords), entries.map(e => [e.label, e.text]));
    if (set === "long") check(`${tag}: no title is cut where its column has room`, entries.every(e => e.text === e.label && e.lines <= 2), entries.map(e => [e.text, e.lines]));
    else check(`${tag}: a title past two lines is cut at a word, in two lines`, entries.some(e => e.text.endsWith('…')) && entries.every(e => e.lines <= 2), entries.map(e => [e.text, e.lines]));
    check(`${tag}: the two entry columns are even`, Math.abs(g.columns[1] - g.columns[2]) <= 1, g.columns);
    check(`${tag}: second entries share a column`, (() => { const second = g.rows.map(row => row.entries[1]).filter(Boolean); return second.length < 2 || Math.abs(second[0].x - second[1].x) <= 1; })(), g.rows.map(row => row.entries.map(e => e.x)));
    check(`${tag}: every head and page starts on the placeholder's x`, g.heads.every(x => Math.abs(x - g.inputText) <= 1) && g.pages.every(p => Math.abs(p.text - g.inputText) <= 1), { input: g.inputText, heads: g.heads, pages: g.pages.map(p => p.text) });
    if (g.rows.length === 2) {
      const bottom = Math.max(g.rows[0].head.bottom, ...g.rows[0].entries.map(e => e.bottom)), top = Math.min(g.rows[1].head.y, ...g.rows[1].entries.map(e => e.y));
      check(`${tag}: Plans → Chats is 12`, Math.abs(top - bottom - 12) <= 1, { bottom, top });
    }
    if (g.searches && !g.searches.empty) {
      check(`${tag}: the table → Searches is 20`, Math.abs(g.searches.head.y - g.table.bottom - 20) <= 1, { table: g.table.bottom, head: g.searches.head.y });
      check(`${tag}: pages sit on a 36 px pitch, clear of the edge by 72`, g.pages.length > 0 && g.pages.every((p, i) => i === 0 || Math.abs(p.y - g.pages[i - 1].y - 36) <= 0.5) && g.pages.at(-1).bottom <= g.layerBottom - 72 + 0.5, { pages: g.pages.map(p => p.y), layerBottom: g.layerBottom });
    } else check(`${tag}: with no page row to show, the section shows nothing`, !g.searches || g.searches.visibility === 'hidden', g.searches);
    check(`${tag}: nothing scrolls`, !g.scrolls);
    check(`${tag}: every recent is at least 24 × 24`, (await smallTargets('[aria-label="Jump back in"]')).length === 0, await smallTargets('[aria-label="Jump back in"]'));
    report.recents = { ...report.recents, [tag]: { columns: g.columns, rows: g.rows.map(row => row.entries.map(e => [e.text, e.lines])), pages: g.pages.length } };
  }
} catch(error) {report.errors.push(error.stack??String(error));}
finally {
  report.finishedAt=new Date().toISOString(); report.passed=report.checks.every(check=>check.passed)&&report.errors.length===0;
  await mkdir(output,{recursive:true});await writeFile(path.join(output,"report.json"),JSON.stringify(report,null,2)+"\n");
  cdp?.close();chrome?.kill();await server?.close();await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,errors:report.errors,output},null,2));if(!report.passed)process.exitCode=1;
}
