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
const output = path.resolve(root, process.argv[2] ?? "build-analysis/git-gui-visual-qa");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-git-gui-qa-"));
const service = path.join(root, "fixtures/git-gui-visual-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/git-gui-visual-qa", screenshots: [], checks: [], errors: [], sourceSha256: {}, limitations: ["Headless Chrome component fixture; not WKWebView/native hit-testing or live Redline.", "Real repository view components and themes. Synthetic git_gui_* responses; no live repository."] };
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
  for (const name of ["GitRepositoryView", "FileStatusView", "HistoryView", "HunkDiff", "GitSidebar", "BranchGraphView"]) {
    const file = `src/components/git/${name}.tsx`; report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
  server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), optimizeDeps: { entries: ["fixtures/git-gui-visual-qa/index.html"] }, plugins: [react(), tailwindcss()], resolve: { alias: [
    ...["@tauri-apps/api/core", "@tauri-apps/api/event"].map((find) => ({ find, replacement: service })),
  ] }, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr:false, watch:null }, clearScreen: false });
  await server.listen();
  const address = server.httpServer.address();
  report.fixtureUrl = `http://127.0.0.1:${address.port}/fixtures/git-gui-visual-qa/`;
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
  const sizes = (process.env.QA_SIZES ?? "1400x860").split(",").map((s) => s.split("x").map(Number));
  for (const [width, height] of sizes) {
    await cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
    await cdp.call("Page.navigate", { url: report.fixtureUrl });
    for (let i = 0; i < 200 && !(await cdp.evaluate("!!document.querySelector('.rl-git-line')")); i++) await delay(100);
    check(`${width}: file status renders hunks`, await cdp.evaluate("document.querySelectorAll('.rl-git-hunk').length===2"));
    for (const theme of ["studio", "basic"]) {
      await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(theme)})`);
      await cdp.evaluate("window.__qa.setView('status')"); await settle(); await delay(150);
      // select two lines to show line selection
      await cdp.evaluate("(()=>{const l=document.querySelectorAll('.rl-git-line[data-kind=add]');l[0].dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));l[2].dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,shiftKey:true}));})()");
      await settle();
      check(`${theme} ${width}: no horizontal page overflow`, await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth"));
      await screenshot(`file-status-${theme === "studio" ? "dark" : "light"}-${width}`);
      await cdp.evaluate("window.__qa.setView('history')");
      for (let i = 0; i < 50 && !(await cdp.evaluate("document.querySelectorAll('.rl-git-row').length>10 && !!document.querySelector('.rl-git-detail .rl-git-line')")); i++) await delay(100);
      check(`${theme} ${width}: history rows + detail`, await cdp.evaluate("document.querySelectorAll('.rl-git-row').length>10 && !!document.querySelector('.rl-git-detail .rl-git-line')"));
      check(`${theme} ${width}: graph draws merge curves`, await cdp.evaluate("[...document.querySelectorAll('.rl-git-graph path')].some(p=>p.getAttribute('d').includes('C'))"));
      await screenshot(`history-${theme === "studio" ? "dark" : "light"}-${width}`);
      // Branches: horizontal rails
      const tone = theme === "studio" ? "dark" : "light";
      await cdp.evaluate("window.__qa.setView('branches')");
      for (let i = 0; i < 50 && !(await cdp.evaluate("document.querySelectorAll('.rl-bg-node').length>20 && document.querySelectorAll('.rl-bg-label').length>3")); i++) await delay(100);
      await settle(); await delay(120);
      const rails = await cdp.evaluate("(()=>{const ls=[...document.querySelectorAll('.rl-bg-label')].map(e=>{const r=e.getBoundingClientRect();return {t:r.top,b:r.bottom,name:e.textContent}});return ls})()");
      check(`${tone} ${width}: branches renders rails`, rails.length >= 8, rails.map((r) => r.name));
      check(`${tone} ${width}: rail labels never overlap`, rails.every((r, i) => i === 0 || r.t >= rails[i - 1].b - 0.5), rails);
      check(`${tone} ${width}: branches opens fitted: every rail's tip on screen`, await cdp.evaluate("(()=>{const c=document.querySelector('.rl-bg-canvas').getBoundingClientRect();const xs=[...document.querySelectorAll('.rl-bg-dot')].map(d=>+d.getAttribute('cx'));return !document.querySelector('.rl-bg-label[data-away]') && Math.max(...xs) < c.width})()"));
      check(`${tone} ${width}: fitted spacing stays clickable`, await cdp.evaluate("(()=>{const xs=[...new Set([...document.querySelectorAll('.rl-bg-dot')].map(d=>Math.round(+d.getAttribute('cx')*10)/10))].sort((a,b)=>a-b);let m=1e9;for(let i=1;i<xs.length;i++)m=Math.min(m,xs[i]-xs[i-1]);return m>=7.99})()"));
      check(`${tone} ${width}: tip chips + date axis`, await cdp.evaluate("document.querySelectorAll('.rl-bg-chipset').length>=4 && document.querySelectorAll('.rl-bg-tick').length>=3"));
      check(`${tone} ${width}: no horizontal page overflow (branches)`, await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth"));
      await screenshot(`branches-${tone}-${width}`);
      // select a mid-view commit on main: ancestors light up, descendants soften, the rest dims
      const target = await cdp.evaluate("(()=>{const l=[...document.querySelectorAll('.rl-bg-label')].find(e=>e.textContent.trim()==='main');const lr=l.getBoundingClientRect();const y=lr.top+lr.height/2;const c=document.querySelector('.rl-bg-canvas').getBoundingClientRect();const nodes=[...document.querySelectorAll('.rl-bg-node')].map(n=>{const d=n.querySelector('.rl-bg-dot');return {sha:n.dataset.sha,x:c.left+(+d.getAttribute('cx')),y:c.top+(+d.getAttribute('cy'))}}).filter(n=>Math.abs(n.y-y)<2).sort((a,b)=>a.x-b.x);return nodes[Math.floor(nodes.length*0.55)]??null})()");
      check(`${tone} ${width}: found a node to select`, !!target, target);
      if (target) {
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y });
        await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: target.x, y: target.y });
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: target.x, y: target.y });
        await settle();
        for (let i = 0; i < 40 && !(await cdp.evaluate("!!document.querySelector('.rl-bg-drawer .rl-git-line')")); i++) await delay(100);
        check(`${tone} ${width}: selection highlights ancestors and dims the rest`, await cdp.evaluate("document.querySelectorAll('.rl-bg-node[data-state=anc]').length>3 && document.querySelectorAll('.rl-bg-node[data-state=dim]').length>3 && document.querySelectorAll('.rl-bg-node[data-state=desc]').length>0"));
        check(`${tone} ${width}: selection opens the detail drawer`, await cdp.evaluate("!!document.querySelector('.rl-bg-drawer .rl-git-line')"));
        await screenshot(`branches-${tone}-${width}-selected`);
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
        await click(".rl-bg-drawer-bar button");
        check(`${tone} ${width}: drawer closes, selection stays`, await cdp.evaluate("!document.querySelector('.rl-bg-drawer') && !!document.querySelector('.rl-bg-node[data-state=sel]')"));
        // hover tooltip on the HEAD node
        const headPt = await cdp.evaluate("(()=>{const n=document.querySelector('.rl-bg-node[data-head] .rl-bg-dot');if(!n)return null;const c=document.querySelector('.rl-bg-canvas').getBoundingClientRect();return {x:c.left+(+n.getAttribute('cx')),y:c.top+(+n.getAttribute('cy'))}})()");
        if (headPt) { await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: headPt.x, y: headPt.y }); await settle(); }
        check(`${tone} ${width}: hover tooltip`, await cdp.evaluate("!!document.querySelector('.rl-bg-tip')"));
        await screenshot(`branches-${tone}-${width}-selected-full`);
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
        await key("Escape", "Escape", 27);
        check(`${tone} ${width}: Esc clears the selection`, await cdp.evaluate("!document.querySelector('.rl-bg-node[data-state]')"));
        await click('button[aria-label="Fit"]');
        check(`${tone} ${width}: Fit restores the fitted branches view`, await cdp.evaluate("!document.querySelector('.rl-bg-label[data-away]') && document.querySelectorAll('.rl-bg-node').length>=90"));
        await screenshot(`branches-${tone}-${width}-fit`);
      }
    }
  }
  // context menu + dialog
  await cdp.evaluate("window.__qa.setView('history')");
  for (let i = 0; i < 50 && !(await cdp.evaluate("document.querySelectorAll('.rl-git-row').length>10")); i++) await delay(100);
  await cdp.evaluate("(()=>{const r=document.querySelectorAll('.rl-git-row')[3];const b=r.getBoundingClientRect();r.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:b.x+300,clientY:b.y+12}));})()"); await settle();
  check("commit menu opens", await cdp.evaluate("!!document.querySelector('[role=menu]')"));
  await screenshot("history-menu-light");
  await key("Escape", "Escape", 27);
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
