#!/usr/bin/env node
// The dictation strip over real composers in headless Chrome: hold Right
// Option in each, speak (a scripted mic: fixtures/dictation-visual-qa/
// services.ts), and measure that nothing in the composer moved by even a
// pixel while the strip showed, in four themes; then let go and check the
// words landed. Usage: node scripts/dictation-visual-qa.mjs [output-dir]
// (screenshots and results.json; a temp folder by default).
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, process.argv[2] ?? path.join(tmpdir(), "redline-dictation-visual-qa"));
const temporary = await mkdtemp(path.join(tmpdir(), "redline-dictation-qa-"));
const service = path.join(root, "fixtures/dictation-visual-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/dictation-visual-qa", screenshots: [], checks: [], errors: [], limitations: ["Headless Chrome component fixture; not WKWebView, the native mic or the native key path.", "Real FrontDoor, page-chat composer, dictation host, strip and themes; a scripted mic answers the capture commands and its events are emitted by the harness."] };
const THEMES = ["basic", "studio", "aurora", "silveraerogel"];
const COMPOSERS = [
  { name: "door", field: "[data-qa=door] textarea[aria-label='Message Redline']" },
  { name: "page-chat", field: "[data-qa=page-chat] textarea" },
];
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
async function settle() { await cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"); await delay(60); }
async function screenshot(name) { const shot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); const file = `${name}.png`; await writeFile(path.join(output, file), Buffer.from(shot.data, "base64")); report.screenshots.push(file); }
const emit = (event, payload) => cdp.evaluate(`window.__qaEmit(${JSON.stringify(event)}, ${JSON.stringify(payload)})`);
/** Every box in the composer around `field`, and the page's scroll size. */
const layout = (field) => cdp.evaluate(`(() => {
  const f = document.querySelector(${JSON.stringify(field)});
  const anchor = f.closest('[data-dictation-anchor]');
  const boxes = [anchor, ...anchor.querySelectorAll('*')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100).join(','); });
  const s = document.scrollingElement;
  return { boxes, scroll: [s.scrollWidth, s.scrollHeight].join(',') };
})()`);
const rect = (selector) => cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; })()`);
const key = (type) => cdp.call("Input.dispatchKeyEvent", { type, key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18, location: 2, modifiers: type === "keyUp" ? 0 : 1 });

try {
  await mkdir(output, { recursive: true });
  server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), optimizeDeps: { entries: ["fixtures/dictation-visual-qa/index.html"] }, plugins: [react(), tailwindcss()], resolve: { alias: ["@tauri-apps/api/core", "@tauri-apps/api/event"].map((find) => ({ find, replacement: service })) }, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null }, clearScreen: false });
  await server.listen();
  report.fixtureUrl = `http://127.0.0.1:${server.httpServer.address().port}/fixtures/dictation-visual-qa/`;
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--user-data-dir=${path.join(temporary, "chrome-profile")}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-extensions", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeLog = ""; chrome.stderr.on("data", (data) => { chromeLog += data; });
  let port;
  for (let i = 0; i < 150; i++) { try { port = (await readFile(path.join(temporary, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch {} await delay(100); }
  if (!port) throw new Error(`Chrome failed to start: ${chromeLog.slice(-3000)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new CDP(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Log.enable");
  // A focused page from the start: a headless page otherwise takes focus at
  // the first key, and the door's lift on focus would read as a shift.
  await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true });
  report.browserVersion = (await cdp.call("Browser.getVersion")).product;
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: report.fixtureUrl });
  for (let i = 0; i < 200 && !(await cdp.evaluate("document.documentElement.dataset.qaReady === 'true'")); i++) await delay(100);
  // The host loads with the fixture; give its strip root a beat to mount.
  await delay(300);

  for (const theme of THEMES) {
    await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(theme)})`); await settle();
    for (const composer of COMPOSERS) {
      const label = `${theme}/${composer.name}`;
      await cdp.evaluate(`(() => { const f = document.querySelector(${JSON.stringify(composer.field)}); f.focus(); })()`);
      // Measured at rest: fonts in, the theme's and the door's own
      // transitions done.
      await cdp.evaluate("document.fonts.ready.then(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))");
      await settle();
      const before = await layout(composer.field);
      await key("rawKeyDown");
      await delay(320); await settle();
      await emit("dictation-partial", { owner: "dictation", text: "rename the voice panel to talk panel and keep every test green while it moves" });
      for (let i = 0; i < 12; i++) await emit("dictation-level", { owner: "dictation", rms: -40 + (i % 5) * 7, peak: -12, ms: 50 * (i + 1) });
      await settle();
      const during = await layout(composer.field);
      const strip = await rect(".rl-dictation-strip");
      const field = await rect(composer.field);
      const anchor = await cdp.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(composer.field)}).closest('[data-dictation-anchor]').getBoundingClientRect(); return { x: r.x, y: r.y, bottom: r.bottom, right: r.right }; })()`);
      check(`${label}: the strip shows while the key is held`, !!strip && strip.height > 0, strip);
      const moved = before.boxes.map((box, i) => (box === during.boxes[i] ? null : { i, before: box, during: during.boxes[i] })).filter(Boolean);
      check(`${label}: nothing in the composer moves (0 px)`, moved.length === 0 && before.boxes.length === during.boxes.length && before.scroll === during.scroll, { moved: moved.slice(0, 5), boxes: before.boxes.length, scroll: [before.scroll, during.scroll] });
      // Within the composer's width (give or take the window's 8 px margin).
      check(`${label}: the strip sits on the composer, clear of the text box`, !!strip && strip.bottom <= field.y + 0.5 && Math.abs(strip.bottom - anchor.y) <= 40 && strip.x >= anchor.x - 8 && strip.right <= anchor.right + 1, { strip, anchor, field });
      // A long transcript keeps its newest words in view.
      const tailShown = await cdp.evaluate(`(() => {
        const box = document.querySelector('.rl-dictation-text'); const text = box.querySelector('span').firstChild;
        const r = document.createRange(); r.setStart(text, text.length - 5); r.setEnd(text, text.length);
        const end = r.getBoundingClientRect(), clip = box.getBoundingClientRect();
        return end.left >= clip.left - 0.5 && end.right <= clip.right + 0.5;
      })()`);
      check(`${label}: the strip shows the newest words`, tailShown);
      check(`${label}: the field is untouched until release`, (await cdp.evaluate(`document.querySelector(${JSON.stringify(composer.field)}).value`)) === "");
      check(`${label}: the caret stays in the field`, await cdp.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(composer.field)})`));
      await screenshot(`${theme}-${composer.name}-listening`);
      await cdp.evaluate("window.__qaDictated = 'rename the voice panel to talk panel'");
      await key("keyUp");
      await delay(200); await settle();
      const value = await cdp.evaluate(`document.querySelector(${JSON.stringify(composer.field)}).value`);
      check(`${label}: the words land on release`, value === "Rename the voice panel to talk panel", value);
      check(`${label}: the strip goes`, !(await rect(".rl-dictation-strip")));
      // Clear the box for the next run, as typing would.
      await cdp.evaluate(`(() => { const f = document.querySelector(${JSON.stringify(composer.field)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(f, ''); f.dispatchEvent(new Event('input', { bubbles: true })); f.blur(); })()`);
      await settle();
    }
  }
  check("No console errors", report.errors.length === 0, report.errors.slice(0, 5));
} catch (error) {
  report.errors.push(String(error?.stack ?? error));
  check("Harness completed", false, String(error));
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.every((c) => c.passed);
  await writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2)).catch(() => {});
  cdp?.close(); chrome?.kill(); await server?.close();
  await rm(temporary, { recursive: true, force: true }).catch(() => {});
  console.log(`${report.checks.filter((c) => c.passed).length}/${report.checks.length} checks passed → ${output}`);
  process.exit(report.passed ? 0 : 1);
}
