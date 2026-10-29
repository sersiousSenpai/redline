#!/usr/bin/env node
// The sessions sidebar: the real component, fixture sessions, an isolated
// Chrome profile. `node scripts/sidebar-visual-qa.mjs <out dir>`; screenshots
// belong outside the repo.
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
const output = path.resolve(root, process.argv[2] ?? "build-analysis/sidebar-visual-qa");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-sidebar-qa-"));
const service = path.join(root, "fixtures/sidebar-visual-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/sidebar-visual-qa", screenshots: [], checks: [], errors: [], sourceSha256: {}, limitations: ["Headless Chrome component fixture; not WKWebView, no PTYs, no hooks.", "The real SessionSidebar and themes; the sessions, servers and terminals are fixture data."] };
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
async function screenshot(name, selector) { const clip = selector ? await cdp.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`) : undefined; const shot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...(clip ? { clip } : {}) }); const file = `${name}.png`; await writeFile(path.join(output, file), Buffer.from(shot.data, "base64")); report.screenshots.push(file); }
async function bounds(selector) { return cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,visible:r.width>0&&r.height>0,within:r.x>=-1&&r.y>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1};})()`); }
try {
  await mkdir(output, { recursive: true });
  for (const file of ["src/components/SessionSidebar.tsx", "src/components/SessionSidebar.css", "src/lib/sessionGroups.ts", "src/lib/sessionPorts.ts"]) {
    report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
  server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), optimizeDeps: { entries: ["fixtures/sidebar-visual-qa/index.html"] }, plugins: [react(), tailwindcss()], resolve: { alias: [
    ...["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/window", "@tauri-apps/api/webview", "@tauri-apps/api/webviewWindow"].map((find) => ({ find, replacement: service })),
  ] }, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null }, clearScreen: false });
  await server.listen();
  const address = server.httpServer.address();
  report.fixtureUrl = `http://127.0.0.1:${address.port}/fixtures/sidebar-visual-qa/`;
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--user-data-dir=${path.join(temporary, "chrome-profile")}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-extensions", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeLog = ""; chrome.stderr.on("data", (data) => { chromeLog += data; });
  let port;
  for (let i = 0; i < 150; i++) { try { port = (await readFile(path.join(temporary, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch {} await delay(100); }
  if (!port) throw new Error(`Chrome failed to start: ${chromeLog.slice(-3000)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new CDP(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Log.enable");
  report.browserVersion = await cdp.call("Browser.getVersion");
  await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const sizes = (process.env.QA_SIZES ?? "1440x900,900x640").split(",").map((s) => s.split("x").map(Number));
  const rows = "[...document.querySelectorAll('li.rl-session-row > button.hover-elevated')]";
  // Every piece of a plan row's status line — the state word, the need word,
  // the pills, the count badge, the port chip — shown whole: not cut by its
  // own box, and not run past the row's edge.
  const cut = `(() => { const out = []; for (const line of document.querySelectorAll('.rl-sb-status-line')) { const row = line.closest('li.rl-session-row').getBoundingClientRect(); for (const e of line.querySelectorAll(':scope > *, .rl-sb-statusword, .rl-sb-pill, .rl-sb-needword')) { const r = e.getBoundingClientRect(); if (!r.width) continue; if (e.scrollWidth > e.clientWidth + 1 || r.right > row.right + 0.5 || r.left < row.left - 0.5) out.push(e.textContent + ' @' + Math.round(r.width) + 'px'); } } return out; })()`;
  const pieces = "[...document.querySelectorAll('.rl-sb-status-line')].map(l=>[...l.children].filter(e=>e.getBoundingClientRect().width).map(e=>e.textContent).join(' | '))";
  const narrow = async (tag, sidebar) => {
    await cdp.evaluate(`window.__qa.setWidth(${sidebar})`); await settle();
    const bad = await cdp.evaluate(cut);
    check(`${tag}, sidebar ${sidebar}px: no state word, pill, badge or chip is truncated`, bad.length === 0, bad.length ? bad : await cdp.evaluate(pieces));
    check(`${tag}, sidebar ${sidebar}px: every state word and pill is on screen`, await cdp.evaluate("[...document.querySelectorAll('.rl-sb-statusword,.rl-sb-pill')].every(e=>e.getBoundingClientRect().width>0)"));
    check(`${tag}, sidebar ${sidebar}px: titles end in an ellipsis inside the row, the version chip in view`, await cdp.evaluate(`${rows}.every(b=>{const r=b.getBoundingClientRect();const v=b.querySelector('.font-mono,.rl-cmb-node').getBoundingClientRect();return v.right<=r.right-28})`));
    check(`${tag}, sidebar ${sidebar}px: no horizontal overflow in the sidebar`, await cdp.evaluate("(()=>{const a=document.querySelector('[data-qa-sidebar]');return [...a.querySelectorAll('.rl-session-row')].every(li=>li.getBoundingClientRect().right<=a.getBoundingClientRect().right+0.5)})()"));
  };
  // Chats: one flat list after the projects, closed until opened. Opened, its
  // rows are single 28px lines: icon, title, a project's pill only on a chat
  // that has one, how long ago at the far right; eight, then "Show 2 more".
  const chatsHead = "document.querySelector('.rl-sb-part[data-part=chats] > .rl-sb-part-toggle')";
  const toEnd = "(()=>{const s=document.querySelector('[data-qa-sidebar] .rl-sb-scroll');s.scrollTop=s.scrollHeight})()";
  // The sidebar's own scroller, never the page: scrollIntoView would move the page too.
  const toChats = "(()=>{const s=document.querySelector('[data-qa-sidebar] .rl-sb-scroll');const c=document.querySelector('.rl-sb-part[data-part=chats]');s.scrollTop+=c.getBoundingClientRect().top-s.getBoundingClientRect().top})()";
  const setChats = async (open) => {
    if ((await cdp.evaluate(`${chatsHead}.getAttribute('aria-expanded')`)) !== String(open)) { await cdp.evaluate(`${chatsHead}.click()`); await settle(); }
  };
  const chatRows = "[...document.querySelectorAll('.rl-sb-part[data-part=chats] li.rl-sb-item')]";
  const chatChecks = async (tag) => {
    check(`${tag}: Chats open shows eight one-line rows, then Show 2 more`, await cdp.evaluate(`(()=>{const r=${chatRows};const f=document.querySelector('.rl-sb-part[data-part=chats] .rl-sb-fold');return r.length===8&&r.every(li=>Math.round(li.querySelector('.rl-sb-row').getBoundingClientRect().height)===28)&&f&&f.textContent==='Show 2 more'})()`), await cdp.evaluate(`${chatRows}.map(li=>li.querySelector('.rl-sb-row').getBoundingClientRect().height)`));
    check(`${tag}: a project's chat wears its project's pill, a general chat none`, await cdp.evaluate(`(()=>{const pill=t=>${chatRows}.find(li=>li.querySelector('.rl-sb-title').textContent.startsWith(t))?.querySelector('.rl-sb-chip')?.textContent??null;return pill('Pricing page')==='qwallah'&&pill('Why does the PTY')==='redline'&&pill('Literature')==='research'&&pill('Lunch-and-learn')===null&&pill('Weekend')===null})()`));
    check(`${tag}: the chat that became a plan is not in Chats`, await cdp.evaluate(`!${chatRows}.some(li=>li.textContent.includes('Onboarding checklist'))`));
    check(`${tag}: each chat row's pieces stay inside the row, the age at its far right`, await cdp.evaluate(`${chatRows}.every(li=>{const r=li.querySelector('.rl-sb-row').getBoundingClientRect();const a=li.querySelector('.rl-sb-age').getBoundingClientRect();const t=li.querySelector('.rl-sb-title').getBoundingClientRect();const c=li.querySelector('.rl-sb-chip')?.getBoundingClientRect();return a.right<=r.right-7&&a.right>=r.right-9&&t.left>=r.left&&(!c||(c.left>=t.right&&c.right<=a.left))})`));
    check(`${tag}: the working chat wears the spinner where its icon was`, await cdp.evaluate(`!!${chatRows}.find(li=>li.textContent.includes('Lunch-and-learn')).querySelector('.rl-sb-icon .rl-sb-spin')`));
  };
  for (const [width, height] of sizes) {
    await cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
    await cdp.call("Page.navigate", { url: report.fixtureUrl });
    for (let i = 0; i < 200 && !(await cdp.evaluate("document.documentElement.dataset.qaReady==='true' && !!document.querySelector('.rl-session-row')")); i++) await delay(100);
    // As a first launch finds it: Chats closed; qwallah's eight plans at
    // five; research, which only a chat names, empty; no chat in a project.
    check(`${width}: Chats is collapsed by default, its count on the header`, await cdp.evaluate(`${chatsHead}.getAttribute('aria-expanded')==='false'&&${chatRows}.length===0&&document.querySelector('.rl-sb-part[data-part=chats] .rl-sb-part-count').textContent==='10'`));
    check(`${width}: a project holds only plans, five then Show 3 more`, await cdp.evaluate("(()=>{const p=[...document.querySelectorAll('.rl-sb-section[data-kind=project]')];const q=p.find(s=>s.querySelector('.rl-sb-proj-name').textContent==='qwallah');return !document.querySelector('.rl-sb-part[data-part=projects] .rl-sb-item[data-kind=chat]')&&q.querySelectorAll('li.rl-session-row').length===5&&q.querySelector('.rl-sb-fold').textContent==='Show 3 more'})()"));
    check(`${width}: Projects then Chats, research reads No plans`, await cdp.evaluate("(()=>{const parts=[...document.querySelectorAll('.rl-sb-part')].map(p=>p.dataset.part).join();const r=[...document.querySelectorAll('.rl-sb-section[data-kind=project]')].find(s=>s.querySelector('.rl-sb-proj-name').textContent==='research');return parts==='projects,chats'&&r?.querySelector('.rl-sb-none')?.textContent==='No plans'})()"));
    // Every plan on screen: open each project's "Show N more".
    await cdp.evaluate("[...document.querySelectorAll('.rl-sb-part[data-part=projects] .rl-sb-fold[aria-expanded=false]')].filter(b=>/^Show \\d+ more$/.test(b.textContent)).forEach(b=>b.click())"); await settle();
    for (const theme of ["basic", "studio"]) {
      const tone = theme === "studio" ? "dark" : "light";
      await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(theme)})`); await settle(); await delay(120);
      const tag = `${tone} ${width}`;
      await cdp.evaluate("window.__qa.setWidth(null)"); await settle();
      const bad = await cdp.evaluate(cut);
      check(`${tag}: no state word, pill, badge or chip is truncated`, bad.length === 0, bad);
      check(`${tag}: the state word wears its state's colour`, await cdp.evaluate("(()=>{const c=t=>[...document.querySelectorAll('li.rl-session-row')].find(li=>li.querySelector('.truncate').textContent.startsWith(t)).querySelector('.rl-sb-statusword').style.color;return c('Qwallah onboarding')==='var(--color-warning)'&&c('Notification preferences')==='var(--color-success)'&&c('PTY helper daemon')==='var(--color-ink-muted)'})()"));
      check(`${tag}: the bordered pills and the filled count badge are back`, await cdp.evaluate("(()=>{const t=[...document.querySelectorAll('.rl-sb-pill')].map(p=>p.textContent);return t.includes('detached')&&t.includes('codex')&&t.includes('building')&&t.includes('landed')&&[...document.querySelectorAll('.rl-sb-status-line > .rounded-full')].some(b=>b.textContent==='12')})()"));
      check(`${tag}: ports: qwallah's and redline's headers, and the one plan whose terminal runs :3000`, await cdp.evaluate("(()=>{const h=[...document.querySelectorAll('.rl-sb-label > .rl-sb-port')].map(p=>p.textContent);const r=[...document.querySelectorAll('.rl-session-row .rl-sb-port')].map(p=>p.closest('li.rl-session-row').querySelector('.truncate').textContent);return JSON.stringify(h)==='[\":3000\",\":1420\"]'&&r.length===1&&r[0].startsWith('Qwallah onboarding')})()"));
      check(`${tag}: the caret toggles the open tree`, await cdp.evaluate("(()=>{const c=document.querySelector('[aria-label=\"Collapse revisions\"]');return !!c&&document.querySelectorAll('li.rl-revision-row').length===3})()"));
      check(`${tag}: no horizontal page overflow`, await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth"));
      await screenshot(`sidebar-${tone}-${width}x${height}`);
      // The list's end: the last project and Chats, closed, then open.
      await cdp.evaluate(toEnd); await settle();
      await screenshot(`sidebar-${tone}-${width}x${height}-chats-collapsed`);
      await setChats(true); await cdp.evaluate(toChats); await settle();
      await chatChecks(tag);
      check(`${tag}: Chats open: no horizontal page overflow`, await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth"));
      await screenshot(`sidebar-${tone}-${width}x${height}-chats-expanded`);
      await setChats(false);
      await cdp.evaluate("document.querySelector('[data-qa-sidebar] .rl-sb-scroll').scrollTop=0;scrollTo(0,0)"); await settle();
      // Hover a row: its ⋯ comes out at the far edge, and nothing moves.
      const target = "li.rl-session-row:nth-of-type(2) > button.hover-elevated";
      const before = await cdp.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(target)});return [...b.querySelectorAll('*')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width].map(Math.round).join(',')}).join(';')})()`);
      const at = await cdp.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(target)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+10}})()`);
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }); await settle();
      const after = await cdp.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(target)});return [...b.querySelectorAll('*')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width].map(Math.round).join(',')}).join(';')})()`);
      const dotsOut = await cdp.evaluate(`!!document.querySelector(${JSON.stringify(target)}).parentElement.querySelector(':scope > .rl-sb-dots')`);
      check(`${tag}: hovering shows the ⋯ and moves nothing`, before === after && dotsOut, { dotsOut, moved: before === after ? null : [before, after], at });
      await screenshot(`sidebar-${tone}-${width}x${height}-hover`);
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: width - 5, y: height - 5 }); await settle();
      for (const sidebar of [200, 260]) {
        await narrow(tag, sidebar);
        await screenshot(`sidebar-${tone}-${width}x${height}-sidebar${sidebar}`, "[data-qa-sidebar]");
        // The longest status lines, scrolled into view.
        await cdp.evaluate("[...document.querySelectorAll('li.rl-session-row')].find(li=>li.querySelector('.truncate').textContent.startsWith('Webhook'))?.scrollIntoView({block:'end'})"); await settle();
        await screenshot(`sidebar-${tone}-${width}x${height}-sidebar${sidebar}-longest`, "[data-qa-sidebar]");
        await cdp.evaluate(toEnd); await settle();
        await screenshot(`sidebar-${tone}-${width}x${height}-sidebar${sidebar}-chats-collapsed`, "[data-qa-sidebar]");
        await setChats(true); await cdp.evaluate(toChats); await settle();
        await chatChecks(`${tag}, sidebar ${sidebar}px`);
        check(`${tag}, sidebar ${sidebar}px: no chat row runs past the sidebar`, await cdp.evaluate(`(()=>{const a=document.querySelector('[data-qa-sidebar]').getBoundingClientRect();return ${chatRows}.every(li=>li.getBoundingClientRect().right<=a.right+0.5)})()`));
        await screenshot(`sidebar-${tone}-${width}x${height}-sidebar${sidebar}-chats-expanded`, "[data-qa-sidebar]");
        await setChats(false);
        await cdp.evaluate("document.querySelector('[data-qa-sidebar] .rl-sb-scroll').scrollTop=0;scrollTo(0,0)"); await settle();
      }
      await cdp.evaluate("window.__qa.setWidth(null)"); await settle();
    }
  }
  await writeFile(path.join(output, "chrome.stderr.log"), chromeLog);
} catch (error) { report.errors.push(String(error?.stack ?? error)); }
finally {
  report.finishedAt = new Date().toISOString(); report.passed = !report.errors.length && report.checks.every((item) => item.passed);
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2) + "\n");
  cdp?.close(); if (chrome) { chrome.kill("SIGTERM"); await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), delay(3000)]); if (chrome.exitCode === null) chrome.kill("SIGKILL"); }
  await server?.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failed: report.checks.filter((item) => !item.passed), errors: report.errors, screenshots: report.screenshots.length, output }, null, 2));
if (!report.passed) process.exitCode = 1;
