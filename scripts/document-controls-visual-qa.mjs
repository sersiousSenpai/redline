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
const output = path.resolve(root, process.argv[2] ?? "docs/document-controls-visual-qa-2026-09-24");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-document-controls-qa-"));
const service = path.join(root, "fixtures/browser-visual-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/document-controls-visual-qa", screenshots: [], checks: [], errors: [], sourceSha256: {}, limitations: ["Headless Chrome component fixture; not WKWebView/native hit-testing or live Redline.", "Actual Tiptap editor, toolbar, width gesture component, and theme CSS. Host callbacks record commits and overlay registrations; no daemon, database, or user state."] };
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
  for (const name of ["DrafterToolbar", "DocWidthToggle"]) {
    const file = `src/components/${name}.tsx`; report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
  server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), optimizeDeps: { entries: ["fixtures/document-controls-visual-qa/index.html"] }, plugins: [react(), tailwindcss()], resolve: { alias: [
    { find: /^.*\/hooks\/useAgentTurn$/, replacement: service }, { find: /^.*\/audio\/useReadAloud$/, replacement: service }, { find: /^.*\/lib\/useDictation$/, replacement: service },
    ...["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener"].map((find) => ({ find, replacement: service })),
  ] }, server: { host: "127.0.0.1", port: 0, strictPort: false, watch: { ignored: ["**/src-tauri/**", "**/docs/**", "**/fixtures/memory-cosmos/**", "**/fixtures/browser-visual-qa/**"] } }, clearScreen: false });
  await server.listen();
  const address = server.httpServer.address();
  report.fixtureUrl = `http://127.0.0.1:${address.port}/fixtures/document-controls-visual-qa/`;
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

  const expectedWidths = { "Paragraph style": 168, "Font": 220, "Font size": 120, "Text color": 188, "Highlight color": 180, "Bulleted list": 160, "Numbered list": 184, "Line spacing": 140, "Table": 205, "Editing mode — whether your edits are tracked": 240 };
  for (const [width, height] of [[1600, 900], [900, 720], [520, 800]]) {
    await cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp.call("Page.navigate", { url: report.fixtureUrl });
    let ready = false;
    for (let i = 0; i < 200; i++) { if (await cdp.evaluate("document.documentElement.dataset.qaReady === 'true'")) { ready = true; break; } await delay(100); }
    if (!ready) throw new Error(`Fixture did not render: ${report.errors.join("\n")}`);
    await settle();
    const overflow = await bounds('[aria-label="Show the rest of the ribbon"]');
    if (overflow?.visible) await click('[aria-label="Show the rest of the ribbon"]');
    await cdp.evaluate("window.__qa.editor.commands.setTextSelection({from:2,to:12})"); await settle();
    const selection = await cdp.evaluate("window.__qa.getState().selection");
    const names = await cdp.evaluate("[...document.querySelectorAll('button[aria-haspopup=menu]')].map(e=>e.getAttribute('aria-label'))");
    check(`${width}px: all ten dropdown triggers`, names.length === 10, names);
    for (const name of names) {
      const selector = `button[aria-label=${JSON.stringify(name)}]`;
      await click(selector);
      const panelSelector = `[role=menu][aria-label=${JSON.stringify(name)}]`;
      const panel = await bounds(panelSelector);
      const gutter = await cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(panelSelector)}).querySelector('.rl-ribbon-pop');return e.offsetWidth-e.clientWidth-2;})()`);
      check(`${width}px ${name}: content width and viewport bounds`, panel?.within && Math.abs(panel.width - expectedWidths[name] - gutter) < 1, { panel, contentAndChrome: expectedWidths[name], scrollbar: gutter });
      check(`${width}px ${name}: native overlay registered`, await cdp.evaluate("window.__qa.getState().overlays===1"));
      check(`${width}px ${name}: editor selection preserved`, JSON.stringify(await cdp.evaluate("window.__qa.getState().selection")) === JSON.stringify(selection));
      if (name === "Table") {
        const grid = await cdp.evaluate(`(() => {const p=document.querySelector(${JSON.stringify(panelSelector)}), b=p.getBoundingClientRect(),clip=p.querySelector('.rl-ribbon-pop'),clipBox=clip.getBoundingClientRect(),clipRight=clipBox.x+clip.clientLeft+clip.clientWidth,g=[...p.querySelectorAll('div')].find(e=>getComputedStyle(e).display==='grid'),cells=[...g.children].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width};});return {count:cells.length,columns:new Set(cells.map(c=>c.x)).size,rows:new Set(cells.map(c=>c.y)).size,clipRight,lastCellRight:Math.max(...cells.map(c=>c.right)),contained:cells.every(c=>c.x>=b.x&&c.right<=clipRight&&c.y>=b.y&&c.bottom<=b.bottom)};})()`);
        check(`${width}px Table: all 10×8 cells visible and unclipped`, grid.count===80 && grid.columns===10 && grid.rows===8 && grid.contained, grid);
      }
      if (name.includes("color")) {
        const colors = await cdp.evaluate(`(() => {const p=document.querySelector(${JSON.stringify(panelSelector)}),g=[...p.querySelectorAll('div')].find(e=>getComputedStyle(e).display==='grid'),b=p.getBoundingClientRect();return {columns:new Set([...g.children].map(e=>e.getBoundingClientRect().x)).size,contained:[...g.children].every(e=>e.getBoundingClientRect().right<=b.right)};})()`);
        check(`${width}px ${name}: seven swatch columns fit`, colors.columns === 7 && colors.contained, colors);
      }
      if (width===1600 || ["Table", "Font", "Font family", "Numbered list"].includes(name) || name.startsWith("Editing mode")) await screenshot(`${width}px-${name.split(" — ")[0].toLowerCase().replaceAll(" ", "-")}`);
      await key("Escape", "Escape", 27);
      check(`${width}px ${name}: Escape closes and clears native overlay`, !(await bounds(panelSelector)) && await cdp.evaluate("window.__qa.getState().overlays===0"));
    }
  }
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: report.fixtureUrl });
  for (let i=0;i<200 && !(await cdp.evaluate("document.documentElement.dataset.qaReady === 'true'"));i++) await delay(100);
  await settle();
  const state = () => cdp.evaluate("window.__qa.getState()");
  const articleWidth = () => cdp.evaluate("document.querySelector('article').getBoundingClientRect().width");
  const down = async () => { const b=await bounds('.qa-width-control button'); const p={x:b.x+b.width/2,y:b.y+b.height/2}; await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p}); return p; };
  const move = async (p,dy) => { await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:p.x,y:p.y+dy});await settle(); };
  const up = async (p,dy=0) => { await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:p.x,y:p.y+dy});await settle(); };
  await screenshot('width-initial-saved-measure');
  await click('.qa-width-control button'); check('width tap: expands without overwriting saved measure', (await state()).wide && (await state()).measure===1000 && (await state()).commits.length===0);
  await screenshot('width-tap-full');
  await click('.qa-width-control button'); check('width tap: returns to saved 1000px measure', !(await state()).wide && await articleWidth()===1000);
  await cdp.evaluate('window.__qa.reset()'); await settle();
  let p=await down(); await delay(300); await move(p,-64);
  const live=await articleWidth();
  check('width drag: live geometry changes with no persisted commit', live>1000 && (await state()).commits.length===0 && (await state()).resizing, {live,state:await state()});
  await screenshot('width-live-drag');
  await up(p,-64); const committed=await state();
  check('width drag: exactly one commit, no click toggle, no layout jump', committed.commits.length===1 && committed.toggles===0 && !committed.resizing && Math.abs(await articleWidth()-live)<1,{state:committed,live,after:await articleWidth()});
  await screenshot('width-committed-measure');
  p=await down(); await move(p,55); check('width Escape: has live preview', Math.abs(await articleWidth()-live)>20);
  await key('Escape','Escape',27); await up(p,55);
  check('width Escape: restores committed article and cursor without another write', Math.abs(await articleWidth()-live)<1 && (await state()).commits.length===1 && !(await state()).resizing && await cdp.evaluate("document.documentElement.style.cursor===''"),{width:await articleWidth(),state:await state()});
  await screenshot('width-escape-restored');
  await cdp.evaluate('window.__qa.reset()'); await settle(); p=await down();await delay(320);await up(p);
  check('width long hold without motion: no toggle or commit', (await state()).commits.length===0 && (await state()).toggles===0 && !(await state()).resizing);
  p=await down();await move(p,-200);await up(p,-200);
  check('width upper endpoint: full width preserves saved measure', (await state()).wide && (await state()).measure===1000 && (await state()).commits.length===1);
  await screenshot('width-full-endpoint');
  await cdp.evaluate('window.__qa.reset();window.__qa.setPaneWidth(680)');await settle();p=await down();await move(p,-80);await up(p,-80);
  check('width narrow pane: drag safely disabled', (await state()).commits.length===0 && (await state()).toggles===0 && !(await state()).resizing);
  await click('.qa-width-control button');check('width narrow pane: ordinary tap still works',(await state()).toggles===1);
  await screenshot('width-narrow-pane');

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
