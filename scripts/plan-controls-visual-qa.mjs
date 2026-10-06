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
const output = path.resolve(root, process.argv[2] ?? "docs/plan-controls-visual-qa-2026-09-24");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-plan-controls-qa-"));
const service = path.join(root, "fixtures/plan-controls-visual-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/plan-controls-visual-qa", screenshots: [], checks: [], errors: [], sourceSha256: {}, limitations: ["Headless Chrome component fixture; not WKWebView/native hit-testing or live Redline.", "Real sidecar, menus, Mermaid renderer and themes. Synthetic agent and Tauri responses; no live agent, database or user state."] };
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
  for (const name of ["CommentThread", "PlanStateMenu", "MarkdownView", "ServersPane", "SidebarTabStrip"]) {
    const file = `src/components/${name}.tsx`; report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
  server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), optimizeDeps: { entries: ["fixtures/plan-controls-visual-qa/index.html"] }, plugins: [react(), tailwindcss()], resolve: { alias: [
    { find: /^.*\/hooks\/useAgentTurn$/, replacement: service }, { find: /^.*\/audio\/useReadAloud$/, replacement: service }, { find: /^.*\/lib\/useDictation$/, replacement: service },
    ...["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/webview", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener"].map((find) => ({ find, replacement: service })),
  ] }, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr:false, watch:null }, clearScreen: false });
  await server.listen();
  const address = server.httpServer.address();
  report.fixtureUrl = `http://127.0.0.1:${address.port}/fixtures/plan-controls-visual-qa/`;
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

  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1050, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", {url:report.fixtureUrl});
  for(let i=0;i<200 && !(await cdp.evaluate("document.querySelectorAll('.rl-mermaid--ready').length===2"));i++) await delay(100);
  check("Both real Mermaid diagrams render",await cdp.evaluate("document.querySelectorAll('.rl-mermaid--ready').length===2"));
  for(const theme of ["studio","basic","ocean"]){
    await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(theme)})`);await settle();
    await screenshot(`sidecar-${theme}`);
    const ink=await cdp.evaluate("(()=>{const e=document.querySelector('.rl-mermaid--ink');return {bg:getComputedStyle(e).backgroundColor,emphasis:!!e.querySelector('.rl-emph'),width:e.scrollWidth,client:e.clientWidth};})()");
    check(`${theme}: ink figure is transparent with one emphasized outcome`,ink.bg==='rgba(0, 0, 0, 0)'&&ink.emphasis,ink);
  }
  check("Reply initially collapsed", !(await bounds('textarea')));
  await click('.rl-reply-pill');
  check("Reply focuses composer",await cdp.evaluate("document.activeElement?.tagName==='TEXTAREA'"));
  await key('Escape','Escape',27);
  check("Escape collapses empty reply",!(await bounds('textarea')));
  await click('.rl-discuss-mode button:first-child');
  check("Report switch offers explicit write-up",!!(await bounds('.rl-write-report')));
  await screenshot('sidecar-report-switch');
  await click('[aria-label="Change plan state"]');
  check("Plan state menu is within viewport",(await bounds('[aria-label="Plan state"]'))?.within);
  await screenshot('plan-state-menu');
  await key('Escape','Escape',27);
  await cdp.evaluate('window.__qa.setMove(true)');await settle();
  check("Move dialog bounded",(await bounds('[role="dialog"]'))?.within);
  await screenshot('move-repo-dialog');
  await key('Escape','Escape',27);
  await cdp.evaluate("window.__qa.setSurface('sidebar')");await settle();
  await click('[aria-haspopup="menu"]');
  check("Sidebar picker contains Sessions and both code projects",await cdp.evaluate("document.querySelector('[aria-label=\"Sidebar view\"]').textContent.includes('Sessions') && [...document.querySelectorAll('[role=menuitem]')].length===3"));
  await screenshot('sidebar-project-dropdown');
  await click('[role="menuitem"][title="/code/another-project"]');
  check("Picking a project closes the menu and focuses trigger",await cdp.evaluate("window.__qa.getState().sidebarTab.id==='two' && !document.querySelector('[role=menu]') && document.activeElement?.getAttribute('aria-haspopup')==='menu'"));
  await click('button[aria-pressed]');
  check("Sidebar linked navigation toggles independently",await cdp.evaluate("!window.__qa.getState().linked && window.__qa.getState().sidebarTab.id==='two'"));
  await click('[aria-haspopup="menu"]');await click('[aria-label="Close redline"]');
  check("Closing another repo leaves current repo and menu intact",await cdp.evaluate("window.__qa.getState().folders.length===1 && window.__qa.getState().sidebarTab.id==='two' && !!document.querySelector('[role=menu]')"));
  await click('[role="menuitem"]');
  check("Sessions returns through the same dropdown",await cdp.evaluate("window.__qa.getState().sidebarTab.kind==='sessions'"));
  await click('[aria-haspopup="menu"]');await click('[aria-label="Close another-project"]');
  check("Last repo close removes the strip",await cdp.evaluate("!document.querySelector('[aria-haspopup=menu]') && !document.querySelector('[role=menu]')"));
  for(const [width,height] of [[1100,780],[440,720]])for(const theme of ['basic','aurora']){
    await cdp.call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
    await cdp.evaluate(`window.__qa.setSurface('servers');window.__qa.setTheme(${JSON.stringify(theme)})`);await settle();
    check(`${theme} ${width}: running and recent lists render`,await cdp.evaluate("document.querySelectorAll('.rl-server-row').length===3 && [...document.querySelectorAll('.rl-servers-label')].map(node=>node.textContent).join(',')==='Running,Recently run'"));
    check(`${theme} ${width}: localhost surface stays inside viewport`,await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('.rl-server-row')].every(node=>{const rect=node.getBoundingClientRect();return rect.x>=0&&rect.right<=innerWidth;})"));
    check(`${theme} ${width}: framework column adapts to available width`,await cdp.evaluate(`getComputedStyle(document.querySelector('.rl-server-stack')).display===${JSON.stringify(width<520?'none':'block')}`));
    check(`${theme} ${width}: status rows contain no thumbnails`,await cdp.evaluate("!document.querySelector('.rl-servers-pane img')"));
    await screenshot(`localhost-${theme}-${width}`);
  }
  await click('.rl-server-url');check("Localhost URL opens through browser callback",await cdp.evaluate("window.__qaOpen==='http://localhost:5173'"));
  await click('.rl-server-btn--go');check("Recent server Run retains repo and command",await cdp.evaluate("window.__qaRun.path==='/code/research' && window.__qaRun.command==='npm run dev'"));
  await click('.rl-server-btn--ghost');check("Stop requires its in-place confirmation",await cdp.evaluate("document.querySelector('.rl-server-btn--ghost').textContent==='Really stop?' && !window.__qaStopped"));
  await click('.rl-server-btn--ghost');check("Confirmed Stop invokes server callback",await cdp.evaluate("window.__qaStopped===true"));
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
