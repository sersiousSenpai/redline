#!/usr/bin/env node
// The dictation strip over every composer that registers for dictation, in
// headless Chrome: hold Right Option in each (fixtures/dictation-visual-qa,
// one scene per composer), speak through a scripted mic, and measure that
// nothing in the composer moved by even a pixel while the strip showed and
// nothing was written before the release, in four themes; then let go and
// check the words landed. The compact card also has to stay a card, and keep
// what was said in the shared draft when a tap outside closes it.
// Usage: node scripts/dictation-visual-qa.mjs [output-dir] (screenshots and
// results.json; a temp folder by default).
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
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/dictation-visual-qa", screenshots: [], checks: [], errors: [], limitations: ["Headless Chrome component fixture; not WKWebView, the native mic or the native key path.", "Real composers, dictation host, strip and themes; a scripted mic answers the capture commands and its events are emitted by the harness.", "The plan editor (TipTap with track changes) is not mounted here: its insertion is covered by the unit tests."] };
const THEMES = ["basic", "studio", "aurora", "silveraerogel"];
const SAID = "rename the voice panel to talk panel";
const SCENES = [
  { name: "door", field: "textarea[aria-label='Message Redline']", landed: "Rename the voice panel to talk panel" },
  { name: "card", field: "#rl-monochat-card textarea", landed: "Rename the voice panel to talk panel" },
  { name: "chat", field: "[data-chat-composer] textarea", landed: "Rename the voice panel to talk panel" },
  { name: "page-chat", field: "[data-browser-chat-composer] textarea", landed: "Rename the voice panel to talk panel" },
  { name: "comment", field: "textarea[placeholder=\"What's the feedback?\"]", landed: "Rename the voice panel to talk panel" },
  { name: "reply", field: ".qa-panel textarea", landed: "Rename the voice panel to talk panel" },
  // A turn: the panel's own push-to-talk, sent on release, never written.
  { name: "voice", field: "input[aria-label='Type a message to the voice agent']", owner: "voice", turn: true },
  { name: "drafter", field: ".rl-page .ProseMirror", rich: true, landed: "Plan the queue tray. Rename the voice panel to talk panel" },
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
/** Every box in the composer's frame (marked once the caret is in it), and
 *  the page's scroll size. A button's insides are left out: a mic button's
 *  face changes while it listens, inside a button that stays put. */
const layout = () => cdp.evaluate(`(() => {
  const frame = document.querySelector('[data-qa-frame]');
  const boxes = [frame, ...frame.querySelectorAll('*:not(button *)')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100).join(','); });
  const s = document.scrollingElement;
  return { boxes, scroll: [s.scrollWidth, s.scrollHeight].join(',') };
})()`);
const rect = (selector) => cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; })()`);
const key = (type) => cdp.call("Input.dispatchKeyEvent", { type, key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18, location: 2, modifiers: type === "keyUp" ? 0 : 1 });
/** What the scene's composer holds: a box's value, or the editor's text. */
const content = (scene) => cdp.evaluate(scene.rich
  ? `document.querySelector(${JSON.stringify(scene.field)}).innerText.trim()`
  : `document.querySelector(${JSON.stringify(scene.field)}).value`);
const sent = () => cdp.evaluate("window.__qaCalls.filter(([c]) => c === 'voice_send').map(([, a]) => a.text)");

async function open(scene, theme) {
  await cdp.call("Page.navigate", { url: `${report.fixtureUrl}?scene=${scene.name}` });
  for (let i = 0; i < 200 && !(await cdp.evaluate(`document.documentElement.dataset.qaReady === 'true' && !!document.querySelector(${JSON.stringify(scene.field)})`)); i++) await delay(100);
  await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(theme)})`);
  // Its caret where a user's would be: at the end of what is there. What is
  // measured is the registered composer — for the voice panel, which is all
  // of it, the input row the strip sits over.
  await cdp.evaluate(`(() => {
    const f = document.querySelector(${JSON.stringify(scene.field)});
    if (!f) throw new Error('No field ' + ${JSON.stringify(JSON.stringify(scene.field))} + ' in: ' + document.body.innerText.slice(0, 600));
    f.focus();
    if (f.isContentEditable) { const r = document.createRange(); r.selectNodeContents(f); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    (${scene.turn ? "f.form" : "window.__qa.frame()"}).setAttribute('data-qa-frame', '');
  })()`);
  // Measured at rest: fonts in, the theme's, the card's and the door's own
  // transitions done.
  await cdp.evaluate("document.fonts.ready.then(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))");
  await delay(150);
  await settle();
}

async function run(scene, theme) {
  const label = `${theme}/${scene.name}`;
  const owner = scene.owner ?? "dictation";
  await open(scene, theme);
  const before = await layout();
  const was = await content(scene);
  await cdp.evaluate("window.__qaCalls.length = 0");
  await key("rawKeyDown");
  await delay(320); await settle();
  await emit("dictation-partial", { owner, text: `${SAID} and keep every test green while it moves` });
  for (let i = 0; i < 12; i++) await emit("dictation-level", { owner, rms: -40 + (i % 5) * 7, peak: -12, ms: 50 * (i + 1) });
  await settle();
  const during = await layout();
  const strip = await rect(".rl-dictation-strip");
  check(`${label}: the strip shows while the key is held`, !!strip && strip.height > 0, strip);
  const moved = before.boxes.map((box, i) => (box === during.boxes[i] ? null : { i, before: box, during: during.boxes[i] })).filter(Boolean);
  check(`${label}: nothing in the composer moves (0 px)`, moved.length === 0 && before.boxes.length === during.boxes.length && before.scroll === during.scroll, { moved: moved.slice(0, 5), boxes: [before.boxes.length, during.boxes.length], scroll: [before.scroll, during.scroll] });
  // Where it sits: just above the text it will write into — the box, the
  // caret's line in a document, the voice panel's input row.
  const target = scene.rich
    ? await cdp.evaluate("(() => { const r = getSelection().getRangeAt(0).getClientRects()[0] ?? document.querySelector('.rl-page .ProseMirror p:last-child').getBoundingClientRect(); return { y: r.y, bottom: r.bottom }; })()")
    : scene.turn ? await rect("[data-qa-frame]")
    : await rect(scene.field);
  const frame = await rect("[data-qa-frame]");
  check(`${label}: the strip sits just above where the words go, within the composer's width`, !!strip && strip.bottom <= target.y + 0.5 && target.y - strip.bottom <= (scene.turn || scene.rich ? 12 : 120) && strip.x >= frame.x - 8 && strip.right <= Math.max(frame.right, strip.x + 420) + 1, { strip, target, frame });
  const tailShown = await cdp.evaluate(`(() => {
    const box = document.querySelector('.rl-dictation-text'); const text = box.querySelector('span').firstChild;
    const r = document.createRange(); r.setStart(text, text.length - 5); r.setEnd(text, text.length);
    const end = r.getBoundingClientRect(), clip = box.getBoundingClientRect();
    return end.left >= clip.left - 0.5 && end.right <= clip.right + 0.5;
  })()`);
  check(`${label}: the strip shows the newest words`, tailShown);
  check(`${label}: nothing is written until release`, (await content(scene)) === was && (await sent()).length === 0);
  check(`${label}: the caret stays where it was`, await cdp.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(scene.field)})`));
  await screenshot(`${theme}-${scene.name}-listening`);
  await cdp.evaluate(`window.__qaDictated = ${JSON.stringify(SAID)}`);
  await key("keyUp");
  // The voice panel waits a beat for the recognizer's last word.
  await delay(scene.turn ? 600 : 200); await settle();
  if (scene.turn) check(`${label}: what was said is sent as a turn on release, and never typed`, JSON.stringify(await sent()) === JSON.stringify([SAID]) && (await content(scene)) === "", await sent());
  else check(`${label}: the words land on release`, (await content(scene)) === scene.landed, await content(scene));
  check(`${label}: the strip goes`, !(await rect(".rl-dictation-strip")));
  if (scene.name === "card") await card(label);
}

/** The compact card: dictating keeps it a card, and a tap outside while the
 *  mic is locked open closes it with the words kept in the draft. */
async function card(label) {
  check(`${label}: dictating never grows the card into the door`, (await cdp.evaluate("window.__qa.cardOpen() && !window.__qa.doorOpen()")));
  await cdp.evaluate("window.__qa.clearDraft()"); await settle();
  // Double tap: the mic stays open.
  await key("rawKeyDown"); await key("keyUp"); await delay(80);
  await key("rawKeyDown"); await key("keyUp"); await settle();
  await emit("dictation-partial", { owner: "dictation", text: "and the scroll pin" });
  await cdp.evaluate("window.__qaDictated = 'and the scroll pin'");
  const plate = await rect(".qa-plate");
  const at = { x: plate.x + 40, y: plate.y + 40 };
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...at });
  await delay(500); await settle();
  check(`${label}: a tap outside closes the card`, !(await cdp.evaluate("window.__qa.cardOpen()")) && !(await cdp.evaluate("window.__qa.doorOpen()")));
  check(`${label}: …and keeps what was said in the draft`, (await cdp.evaluate("window.__qa.draft()")) === "And the scroll pin", await cdp.evaluate("window.__qa.draft()"));
  check(`${label}: …saying so on the strip`, (await cdp.evaluate("document.querySelector('.rl-dictation-text')?.textContent")) === "Kept in the draft");
}

try {
  await mkdir(output, { recursive: true });
  server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), optimizeDeps: { entries: ["fixtures/dictation-visual-qa/index.html"], include: ["@tauri-apps/plugin-deep-link", "@tauri-apps/api/dpi"] }, plugins: [react(), tailwindcss()], resolve: { alias: [
    { find: /^.*\/hooks\/useAgentTurn$/, replacement: service }, { find: /^.*\/audio\/useReadAloud$/, replacement: service },
    ...["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/window", "@tauri-apps/api/webview", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener"].map((find) => ({ find, replacement: service })),
  ] }, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null }, clearScreen: false });
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
  // the first key, and a composer's lift on focus would read as a shift.
  await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true });
  report.browserVersion = (await cdp.call("Browser.getVersion")).product;
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const only = process.env.QA_SCENES?.split(",");
  for (const theme of THEMES) {
    for (const scene of SCENES) {
      if (only && !only.includes(scene.name)) continue;
      try { await run(scene, theme); } catch (error) { report.errors.push(`${theme}/${scene.name}: ${error.stack ?? error}`); check(`${theme}/${scene.name}: ran`, false, String(error)); }
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
