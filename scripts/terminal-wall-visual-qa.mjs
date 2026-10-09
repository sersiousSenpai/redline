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
const output = path.resolve(root, process.argv[2] ?? "build-analysis/terminal-wall-visual-qa");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-terminal-wall-qa-"));
const service = path.join(root, "fixtures/terminal-wall-visual-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/terminal-wall-visual-qa", screenshots: [], checks: [], errors: [], sourceSha256: {}, limitations: ["Headless Chrome component fixture; not WKWebView, no PTYs, no hooks.", "Real tile header, shelf and footer components and themes; the states are fixture data."] };
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
  for (const file of ["src/components/TerminalTileHeader.tsx", "src/components/TerminalShelf.tsx", "src/components/TermStateBadge.tsx", "src/components/Footer.tsx"]) {
    report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
  server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), optimizeDeps: { entries: ["fixtures/terminal-wall-visual-qa/index.html"] }, plugins: [react(), tailwindcss()], resolve: { alias: [
    ...["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/window", "@tauri-apps/api/webview", "@tauri-apps/api/webviewWindow"].map((find) => ({ find, replacement: service })),
  ] }, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null }, clearScreen: false });
  await server.listen();
  const address = server.httpServer.address();
  report.fixtureUrl = `http://127.0.0.1:${address.port}/fixtures/terminal-wall-visual-qa/`;
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--user-data-dir=${path.join(temporary, "chrome-profile")}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-extensions", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeLog = ""; chrome.stderr.on("data", (data) => { chromeLog += data; });
  let port;
  for (let i = 0; i < 150; i++) { try { port = (await readFile(path.join(temporary, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch {} await delay(100); }
  if (!port) throw new Error(`Chrome failed to start: ${chromeLog.slice(-3000)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new CDP(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Log.enable");
  report.browserVersion = await cdp.call("Browser.getVersion");
  // Reduced motion: the pulse and the spinner hold still, so the frames are
  // comparable run to run (styles.css drops both animations under it).
  await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const sizes = (process.env.QA_SIZES ?? "1400x640").split(",").map((s) => s.split("x").map(Number));
  for (const [width, height] of sizes) {
    await cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
    await cdp.call("Page.navigate", { url: report.fixtureUrl });
    for (let i = 0; i < 200 && !(await cdp.evaluate("document.documentElement.dataset.qaReady==='true' && !!document.querySelector('.rl-tile-head')")); i++) await delay(100);
    for (const theme of ["basic", "studio"]) {
      const tone = theme === "studio" ? "dark" : "light";
      await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(theme)})`); await settle(); await delay(120);
      const shelf = await bounds("[role='toolbar']");
      check(`${tone} ${width}: the shelf is a 24px row`, shelf && Math.round(shelf.height) === 24, shelf);
      check(`${tone} ${width}: one chip per untiled terminal, none clipped vertically`, await cdp.evaluate("(()=>{const s=document.querySelector('[role=toolbar]').getBoundingClientRect();const c=[...document.querySelectorAll('.rl-shelf-chip')];return c.length===5&&c.every(x=>{const r=x.getBoundingClientRect();return r.top>=s.top&&r.bottom<=s.bottom})})()"));
      check(`${tone} ${width}: a blocked agent's tile is framed`, await cdp.evaluate("getComputedStyle(document.querySelector('[data-qa-tile=a]'),'::before').boxShadow!=='none'"));
      check(`${tone} ${width}: only the blocked tile is framed`, await cdp.evaluate("getComputedStyle(document.querySelector('[data-qa-tile=b]'),'::before').content==='none'"));
      check(`${tone} ${width}: every header stays one strip tall`, await cdp.evaluate("[...document.querySelectorAll('.rl-tile-head')].every(h=>Math.round(h.getBoundingClientRect().height)===26)"));
      check(`${tone} ${width}: badges differ by state`, await cdp.evaluate("(()=>{const c=s=>{const b=document.querySelector(`[data-qa-tile=${s}] .rl-term-badge`);const st=getComputedStyle(b);return st.backgroundColor+'|'+st.borderTopColor};return new Set(['a','b','c','d','e'].map(c)).size===5})()"));
      check(`${tone} ${width}: a server shows its port`, await cdp.evaluate("document.querySelector('[data-qa-tile=d] .rl-tile-head').textContent.includes(':5173')"));
      check(`${tone} ${width}: the footer chip counts what needs you`, await cdp.evaluate("[...document.querySelectorAll('footer button')].some(b=>b.textContent==='2 need you')"));
      check(`${tone} ${width}: no horizontal page overflow`, await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth"));
      await screenshot(`wall-${tone}-${width}`);
      // The pinned tile's cluster, revealed the way hover reveals it.
      const pin = await cdp.evaluate("(()=>{const r=document.querySelector('[data-qa-tile=f] .rl-tile-head').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: pin.x, y: pin.y }); await settle();
      check(`${tone} ${width}: hovering a header shows its pin, pressed`, await cdp.evaluate("(()=>{const b=document.querySelector('[data-qa-tile=f] button[aria-pressed=true]');return !!b&&getComputedStyle(b.closest('.rl-tile-actions')).opacity==='1'})()"));
      await screenshot(`wall-${tone}-${width}-hover-pinned`);
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 600 });
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
