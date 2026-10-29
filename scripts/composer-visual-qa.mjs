#!/usr/bin/env node
// The composers: the chat pane's (ChatRoom with the door's composer, D27)
// with the "skills out of date" notice on it and its mode menu open, and the
// Home door's, in headless Chrome at 1440×900 and 900×640, light and dark.
// `node scripts/composer-visual-qa.mjs <out dir>`; screenshots belong
// outside the repo.
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
const output = path.resolve(root, process.argv[2] ?? "build-analysis/composer-visual-qa");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-composer-qa-"));
const service = path.join(root, "fixtures/chat-stream-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/composer-visual-qa", screenshots: [], checks: [], errors: [], sourceSha256: {}, limitations: ["Headless Chrome component fixture; not WKWebView, no native browser pane.", "The real ChatRoom, FrontDoor and themes over the chat-stream fixture's synthetic services; the door is FrontDoor in a stand-in for MonochatIsland's room."] };
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
const menu = "document.querySelector('body > [role=menu]')";
/** Every open composer menu: portalled to the body, wholly on screen, with
 *  no Done button, its current row checked. */
async function menuChecks(tag, chip) {
  const m = await cdp.evaluate(`(() => { const m = ${menu}; if (!m) return null; const r = m.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, inView: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth, scrollFits: [...m.querySelectorAll('.rl-composer-menu-scroll, .rl-thin-scroll-y')].every(s => s.getBoundingClientRect().bottom <= r.bottom + 1), done: [...m.querySelectorAll('button')].some(b => b.textContent.trim() === 'Done'), checked: m.querySelectorAll('[aria-checked=true]').length, radios: m.querySelectorAll('[role=menuitemradio]').length, focusInside: m.contains(document.activeElement) }; })()`);
  check(`${tag}: ${chip} opens as a popover portalled to the body`, !!m, m);
  if (!m) return;
  check(`${tag}: ${chip}'s menu is wholly on screen, never clipped`, m.inView && m.scrollFits, m);
  check(`${tag}: ${chip}'s menu has no Done button`, !m.done, m);
  check(`${tag}: ${chip}'s menu checks its current row and takes the focus`, m.checked >= 1 && m.radios >= 1 && m.focusInside, m);
}
try {
  await mkdir(output, { recursive: true });
  for (const file of ["src/components/ComposerLook.css", "src/components/CompactComposer.css", "src/components/ComposerMenu.tsx", "src/components/ChatModePicker.tsx", "src/components/plan/ComposerNotices.tsx", "src/components/FrontDoor.tsx", "src/components/plan/NoticeStrip.tsx"]) {
    report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
  server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), optimizeDeps: { entries: ["fixtures/composer-visual-qa/index.html"], include: ["@tauri-apps/plugin-deep-link", "@tauri-apps/api/dpi"] }, plugins: [react(), tailwindcss()], resolve: { alias: [
    { find: /^.*\/hooks\/useAgentTurn$/, replacement: service }, { find: /^.*\/audio\/useReadAloud$/, replacement: service },
    ...["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/window", "@tauri-apps/api/webview", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener"].map((find) => ({ find, replacement: service })),
  ] }, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null }, clearScreen: false });
  await server.listen();
  const address = server.httpServer.address();
  report.fixtureUrl = `http://127.0.0.1:${address.port}/fixtures/composer-visual-qa/`;
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--user-data-dir=${path.join(temporary, "chrome-profile")}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-extensions", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeLog = ""; chrome.stderr.on("data", (data) => { chromeLog += data; });
  let port;
  for (let i = 0; i < 150; i++) { try { port = (await readFile(path.join(temporary, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch {} await delay(100); }
  if (!port) throw new Error(`Chrome failed to start: ${chromeLog.slice(-3000)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new CDP(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Log.enable");
  await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const sizes = (process.env.QA_SIZES ?? "1440x900,900x640").split(",").map((s) => s.split("x").map(Number));
  const card = (host) => `${host} .rl-fd-island`;
  for (const [width, height] of sizes) {
    await cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
    for (const scene of ["chat", "door"]) {
      await cdp.call("Page.navigate", { url: `${report.fixtureUrl}?scene=${scene}` });
      for (let i = 0; i < 200 && !(await cdp.evaluate("document.documentElement.dataset.qaReady==='true' && !!document.querySelector('.rl-fd-island')")); i++) await delay(100);
      await delay(400);
      for (const theme of ["basic", "studio"]) {
        const tone = theme === "studio" ? "dark" : "light";
        await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(theme)})`); await settle(); await delay(150);
        const tag = `${scene} ${tone} ${width}x${height}`;
        const box = await bounds(card("[data-qa-scene]"));
        const radius = await cdp.evaluate(`(() => { const s = getComputedStyle(document.querySelector('[data-qa-scene] .rl-fd-island')); return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius]; })()`);
        check(`${tag}: the card's corners are one radius, 24px all round`, radius.every((r) => r === "24px"), radius);
        check(`${tag}: no horizontal page overflow`, await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth"));
        if (scene === "chat") {
          const notice = await bounds("[data-qa-scene] .rl-composer-notices");
          const strip = await bounds("[data-qa-scene] .rl-composer-notices .rl-plan-notice");
          check(`${tag}: the skills notice is one strip above the card, its width`, !!notice && !!strip && Math.abs(notice.width - box.width) < 1 && Math.abs(notice.x - box.x) < 1 && strip.bottom <= box.y + 0.5 && strip.height === 28, { notice, strip, box });
          check(`${tag}: the strip joins the card: its tuck runs under the card's top`, !!notice && Math.abs(notice.bottom - (box.y + 24)) < 1, { notice, box });
          check(`${tag}: nothing but the box's own rows is inside the card`, await cdp.evaluate("!document.querySelector('[data-qa-scene] .rl-fd-island .rl-fd-strip, [data-qa-scene] .rl-fd-island .rl-plan-notice')"));
          check(`${tag}: the notice reads short, with Install and ×, the explanation its tooltip`, await cdp.evaluate(`(() => { const n = document.querySelector('[data-qa-scene] .rl-plan-notice'); return n.querySelector('.rl-plan-notice-text').textContent === 'Redline skills are out of date' && n.querySelector('.rl-plan-notice-btn').textContent === 'Install' && !!n.querySelector('.rl-plan-notice-x') && n.title.startsWith('They teach Claude'); })()`));
          check(`${tag}: the composer is centred in the pane and pinned to its bottom`, await cdp.evaluate(`(() => { const p = document.querySelector('[data-qa-scene]').getBoundingClientRect(); const c = document.querySelector('[data-qa-scene] .rl-fd-island').getBoundingClientRect(); return Math.abs((c.left + c.right) / 2 - (p.left + p.right) / 2) < 1.5 && p.bottom - c.bottom <= 17; })()`));
          check(`${tag}: the mic is in view`, (await bounds("[data-qa-scene] .rl-fd-tool[title=Dictate]"))?.within);
          await screenshot(`chat-${tone}-${width}x${height}`);
          await click("[data-qa-scene] .rl-chat-mode-chip");
          check(`${tag}: the mode chip says it is expanded`, await cdp.evaluate("document.querySelector('.rl-chat-mode-chip').getAttribute('aria-expanded') === 'true'"));
          await menuChecks(tag, "the mode chip");
          await screenshot(`chat-${tone}-${width}x${height}-mode-menu`);
          // Arrow keys walk it; a pick applies and closes, focus back on the chip.
          await key("ArrowDown", "ArrowDown", 40);
          check(`${tag}: ↓ moves to the next row`, await cdp.evaluate(`document.activeElement?.textContent.startsWith('Plan')`));
          await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }); await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); await settle();
          check(`${tag}: picking Plan applies it and closes, the focus back on the chip`, await cdp.evaluate(`!${menu} && document.querySelector('.rl-chat-mode-chip').textContent.startsWith('Plan') && document.activeElement === document.querySelector('.rl-chat-mode-chip')`));
          check(`${tag}: in Plan the harness chip joins the row`, await cdp.evaluate("[...document.querySelectorAll('[data-qa-scene] .rl-composer-chip')].some(c => /Claude/.test(c.textContent))"));
          await screenshot(`chat-${tone}-${width}x${height}-plan`);
          await click("[data-qa-scene] .rl-chat-mode-chip");
          await key("Escape", "Escape", 27);
          check(`${tag}: Esc closes the mode menu, the focus back on the chip`, await cdp.evaluate(`!${menu} && document.activeElement === document.querySelector('.rl-chat-mode-chip')`));
          // Back to Chat for the next pass.
          await click("[data-qa-scene] .rl-chat-mode-chip");
          await cdp.evaluate(`[...${menu}.querySelectorAll('[role=menuitemradio]')].find(b => b.textContent.startsWith('Chat')).click()`); await settle();
          for (const [name, selector] of [["the project chip", "[data-qa-scene] .rl-composer-chip[data-chip=project]"], ["History", "[data-qa-scene] .rl-composer-chip[aria-label='Conversation history']"]]) {
            if (!(await bounds(selector))) { check(`${tag}: ${name} is in the row`, false); continue; }
            await click(selector); await menuChecks(tag, name);
            await key("Escape", "Escape", 27);
          }
          await click("[data-qa-scene] .rl-composer-chip[aria-label='Conversation actions']");
          check(`${tag}: More opens portalled and on screen`, await cdp.evaluate(`(() => { const m = ${menu}; if (!m) return false; const r = m.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`));
          await key("Escape", "Escape", 27);
        } else {
          check(`${tag}: the door keeps its fix-it chip in the row and no strip`, await cdp.evaluate("!!document.querySelector('[data-qa-scene] .rl-fd-setup') && !document.querySelector('[data-qa-scene] .rl-composer-notices')"));
          await screenshot(`door-${tone}-${width}x${height}`);
          await click("[data-qa-scene] .rl-composer-chip[data-chip=project]");
          await menuChecks(tag, "the project chip");
          await screenshot(`door-${tone}-${width}x${height}-project-menu`);
          await key("Escape", "Escape", 27);
        }
      }
    }
  }
  // One look: the chat's card and the door's card compute the same chrome.
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const look = async (scene) => {
    await cdp.call("Page.navigate", { url: `${report.fixtureUrl}?scene=${scene}` });
    for (let i = 0; i < 200 && !(await cdp.evaluate("document.documentElement.dataset.qaReady==='true' && !!document.querySelector('.rl-fd-island')")); i++) await delay(100);
    await delay(300);
    return cdp.evaluate(`(() => { const p = (sel, keys) => { const e = document.querySelector(sel); if (!e) return null; const s = getComputedStyle(e); return Object.fromEntries(keys.map(k => [k, s[k]])); };
      return { card: p('.rl-fd-island', ['borderRadius', 'paddingTop', 'paddingLeft', 'paddingBottom', 'backgroundColor', 'boxShadow']),
        input: p('.rl-fd-input', ['fontSize', 'lineHeight', 'paddingTop', 'paddingLeft', 'minHeight']),
        chip: p('.rl-composer-chip[data-chip=project]', ['height', 'borderRadius', 'fontSize', 'backgroundColor', 'paddingLeft']),
        tool: p('.rl-fd-tool', ['width', 'height', 'borderRadius', 'backgroundColor']),
        go: p('.rl-fd-go', ['width', 'height', 'borderRadius']),
        gap: p('.rl-fd-tools', ['columnGap']) }; })()`);
  };
  const chatLook = await look("chat"), doorLook = await look("door");
  check("one look: the chat's composer computes the door's card, field, chips, + and mic, and send", JSON.stringify(chatLook) === JSON.stringify(doorLook), { chat: chatLook, door: doorLook });
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
