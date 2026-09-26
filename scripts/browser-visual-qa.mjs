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
const output = path.resolve(root, process.argv[2] ?? "docs/browser-refresh-visual-qa-2026-09-13");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-browser-visual-qa-"));
const service = path.join(root, "fixtures/browser-visual-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/browser-visual-qa", screenshots: [], checks: [], errors: [], sourceSha256: {}, limitations: ["Headless Chrome component fixture; not WKWebView/native hit-testing or live Redline.", "Agent, dictation, audio and Tauri service interfaces are synthetic; no capture, database, user profile or agent launch.", "Page tiles use synthetic local SVG images. Production component source and theme CSS are imported intact."] };
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
async function measureLayout(label, browserChat = false) {
  const composer = await bounds(browserChat ? "[data-browser-chat-composer]" : "[data-chat-composer]");
  const messages = await bounds(browserChat ? "[data-browser-chat-messages]" : "[data-chat-messages]");
  const outer = await cdp.evaluate("({height:innerHeight,width:innerWidth,scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth})");
  check(`${label}: composer visible`, composer?.visible && composer.within, composer);
  check(`${label}: long messages scroll inside`, messages?.visible && messages.within && messages.scrollHeight > messages.clientHeight * 2, messages);
  check(`${label}: viewport contains shell`, outer.scrollHeight <= outer.height + 1 && outer.scrollWidth <= outer.width + 1, outer);
}
try {
  await mkdir(output, { recursive: true });
  for (const name of ["BrowserChrome", "BrowserSurfaces", "BrowserPagePanels", "BrowserTileStage", "MosaicDialogs", "PersistentPortalSlot", "ChatRoom", "BrowserChat"]) {
    const file = `src/components/${name}.tsx`; report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
  for (const file of ["src/lib/browserTabDrag.ts", "src/components/BrowserWorkspace.css"]) {
    report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
  server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), optimizeDeps: { entries: ["fixtures/browser-visual-qa/index.html"] }, plugins: [react(), tailwindcss()], resolve: { alias: [
    { find: /^.*\/hooks\/useAgentTurn$/, replacement: service }, { find: /^.*\/audio\/useReadAloud$/, replacement: service }, { find: /^.*\/lib\/useDictation$/, replacement: service },
    ...["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener"].map((find) => ({ find, replacement: service })),
  ] }, server: { host: "127.0.0.1", port: 0, strictPort: false, watch: { ignored: ["**/src-tauri/**", "**/docs/**"] } }, clearScreen: false });
  await server.listen();
  const address = server.httpServer.address();
  report.fixtureUrl = `http://127.0.0.1:${address.port}/fixtures/browser-visual-qa/`;
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
  for (const [width, height] of [[1200, 800], [900, 640], [1600, 900]]) {
    const size = `${width}x${height}`;
    await cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp.call("Page.navigate", { url: report.fixtureUrl });
    let ready = false;
    for (let i = 0; i < 200; i++) { if (await cdp.evaluate("document.documentElement.dataset.qaReady === 'true'")) { ready = true; break; } await delay(100); }
    if (!ready) throw new Error(`Fixture did not render. ${report.errors.join("\n")}`);
    await settle();
    await click("[data-chat-composer] textarea"); await cdp.call("Input.insertText", { text: "Keep this unsent draft when I change surfaces.\n".repeat(12) }); await settle();
    await measureLayout(`${size} carried chat`); await screenshot(`${size}-workspace-chat`);
    const textarea = await bounds("[data-chat-composer] textarea"); check(`${size}: textarea capped at 160px`, textarea?.height <= 161, textarea);
    await click('[aria-label="Page menu"]'); const menu = await bounds('[role="menu"]'); check(`${size}: page menu bounded`, menu?.within, menu); await screenshot(`${size}-page-menu`);
    await key("End", "End", 35); await key("Tab", "Tab", 9); check(`${size}: menu Tab wraps`, await cdp.evaluate("document.activeElement === document.querySelector('[role=menu] button')"));
    await key("Escape", "Escape", 27); check(`${size}: menu Escape restores trigger`, await cdp.evaluate("document.activeElement?.getAttribute('aria-label') === 'Page menu'"));
    await cdp.evaluate("window.__qa.setDialog('layout')"); await settle(); const arrangement = await bounds('[role="dialog"]'); check(`${size}: layout dialog bounded`, arrangement?.within, arrangement); await screenshot(`${size}-arrange-pages`);
    await cdp.evaluate("const qaButtons=[...document.querySelectorAll('[role=dialog] button')]; qaButtons.at(-1).focus()"); await key("Tab", "Tab", 9);
    check(`${size}: dialog Tab wraps`, await cdp.evaluate("document.activeElement===document.querySelector('[role=dialog] button')"));
    await key("Tab", "Tab", 9, 8); check(`${size}: dialog Shift-Tab wraps`, await cdp.evaluate("document.activeElement===[...document.querySelectorAll('[role=dialog] button')].at(-1)"));
    await key("Escape", "Escape", 27);
    for (const dialog of ["bookmarks", "long"]) {
      await cdp.evaluate(`window.__qa.setDialog(${JSON.stringify(dialog)})`); await settle(); const box = await bounds('[role="dialog"]'), body = await bounds(".rb-dialog-body"), footer = await bounds(".rb-dialog-footer");
      check(`${size}: ${dialog} dialog body scrolls and footer visible`, box?.within && footer?.within && body?.scrollHeight > body?.clientHeight, { box, body, footer });
      await screenshot(`${size}-${dialog}-dialog`); await key("Escape", "Escape", 27);
    }
    await cdp.evaluate("window.__qaDraft = document.querySelector('[data-chat-composer] textarea'); window.__qaDraftValue = window.__qaDraft.value; window.__qa.setSurface('other')"); await settle();
    check(`${size}: portal detaches on surface exit`, await cdp.evaluate("!window.__qa.host.isConnected && !window.__qaDraft.isConnected && !document.querySelector('[data-chat-room]')"));
    await cdp.evaluate("window.__qa.setSurface('room')"); await settle();
    check(`${size}: portal preserves room identity and draft`, await cdp.evaluate("window.__qaDraft === document.querySelector('[data-chat-composer] textarea') && window.__qaDraft.value === window.__qaDraftValue && window.__qa.host.parentElement.dataset.surfaceSlot === 'chat-room'"));
    await measureLayout(`${size} full chat room`); if (width === 900) await screenshot(`${size}-chat-room`);
    await cdp.evaluate("window.__qa.setSurface('browser')"); await settle();
    check(`${size}: portal reattaches without remount`, await cdp.evaluate("window.__qaDraft === document.querySelector('[data-chat-composer] textarea') && window.__qaDraft.value === window.__qaDraftValue && window.__qa.host.parentElement.dataset.surfaceSlot === 'browser-chat'"));
    await cdp.evaluate("window.__qa.setChatKind('browser')"); await settle();
    await click("[data-browser-chat-composer] textarea"); await cdp.call("Input.insertText", { text: "A browser conversation draft with several lines.\n".repeat(12) }); await settle();
    await measureLayout(`${size} page conversation`, true); await screenshot(`${size}-page-conversation`);
    check(`${size}: linked is a pressed header toggle`, await cdp.evaluate("document.querySelector('[aria-label=Linked]').getAttribute('aria-pressed')==='true'"));
    await click('[aria-label="Conversation actions"]'); check(`${size}: conversation menu bounded`, (await bounds('[role="menu"]'))?.within);
    const actions = await cdp.evaluate("[...document.querySelector('[role=menu]').children].map(e=>e.textContent.trim())");
    check(`${size}: exactly three conversation menu rows`, JSON.stringify(actions) === JSON.stringify(["Start a research mission", "Text sizeA−A+", "Clear history"]), actions);
    await screenshot(`${size}-conversation-actions`); await key("Escape", "Escape", 27);
    check(`${size}: new tab immediately follows the last tab`, await cdp.evaluate("document.querySelector('.rb-tabs [data-tab-id]:last-of-type').nextElementSibling?.getAttribute('aria-label')==='New tab'"));
    const savedSpacingTabs = await cdp.evaluate("window.__qa.getState().tabs");
    for (const count of [1, 2, 4]) for (const longTitle of [false, true]) {
      await cdp.evaluate(`window.__qa.setTabs(${JSON.stringify(savedSpacingTabs.slice(0, count).map((tab, i) => ({ ...tab, title: longTitle ? 'A long page title that should keep the new-tab button nearby ' + i : 'Page ' + i })))})`); await settle();
      const gap = await cdp.evaluate("document.querySelector('.rb-new-tab').getBoundingClientRect().left - document.querySelector('.rb-tabs [data-tab-id]:last-of-type').getBoundingClientRect().right");
      check(`${size}: + stays beside ${count} ${longTitle ? 'long' : 'short'} tabs`, gap >= 0 && gap <= 4, {gap});
    }
    if (width === 1600) await screenshot(`${size}-new-tab-spacing`);
    await cdp.evaluate(`window.__qa.setTabs(${JSON.stringify(savedSpacingTabs)})`); await settle();
    if (width === 1600) {
      await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
      await click('[aria-label="Assign tab to page 1"]');
      check("tile picker themed and identifies assignments", await cdp.evaluate("document.querySelector('[role=menu]').textContent.includes('Tile 2') && !document.querySelector('select')"));
      await screenshot(`${size}-tile-picker`); await key("Escape", "Escape", 27);
      const originalLayout = await cdp.evaluate("window.__qa.getState().layout");
      const tabOrder = () => cdp.evaluate("[...document.querySelectorAll('[data-tab-id]')].map(e=>e.dataset.tabId)");
      const order = await tabOrder(), first = await bounds(`[data-tab-id="${order[0]}"]`), second = await bounds(`[data-tab-id="${order[1]}"]`);
      const start = { x: first.x + first.width / 2, y: first.y + first.height / 2 }, end = { x: second.right - 12, y: start.y };
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...start }); await settle();
      check("hovering tab highlights its tile header", await cdp.evaluate("!!document.querySelector('[data-tile-index=\"0\"] .rb-tile-header[data-tile-hover]')"));
      check("tabs use the normal arrow cursor on hover", await cdp.evaluate("getComputedStyle(document.querySelector('[data-tab-id]')).cursor==='default'"));
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...start });
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...end }); await settle();
      check("tab drag follows pointer and shifts siblings before committing", JSON.stringify(await tabOrder()) === JSON.stringify(order) && await cdp.evaluate("document.querySelector('[data-dragging]').style.getPropertyValue('--tab-drag-x') !== '0px' && [...document.querySelectorAll('[data-tab-id]:not([data-dragging])')].some(e=>parseFloat(e.style.getPropertyValue('--tab-drag-x'))!==0 && e.style.getPropertyValue('--tab-drag-x'))"));
      check("tab drag prevents selection", await cdp.evaluate("getComputedStyle(document.querySelector('.rb-tabs')).userSelect === 'none' && !window.getSelection().toString()"));
      check("tab dragging keeps the normal arrow cursor", await cdp.evaluate("getComputedStyle(document.querySelector('[data-dragging]')).cursor==='default'"));
      await screenshot(`${size}-tab-drag`);
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...end }); await settle();
      check("tab order commits on release and drag styles clear", JSON.stringify(await tabOrder()) === JSON.stringify([order[1], order[0], ...order.slice(2)]) && await cdp.evaluate("!document.querySelector('[data-dragging], .rb-tabs-dragging')"));
      await delay(180);
      const edgeGrab = await bounds(`[data-tab-id="${order[1]}"]`);
      const shortStart = { x: edgeGrab.x + 8, y: edgeGrab.y + edgeGrab.height / 2 };
      const shortEnd = { x: shortStart.x + edgeGrab.width * .58, y: edgeGrab.bottom + 25 };
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...shortStart });
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...shortEnd }); await settle(); await delay(160);
      await cdp.evaluate(`window.__qaBeforeRelease = document.querySelector('[data-tab-id="${order[1]}"]').getBoundingClientRect().left; window.addEventListener('pointerup', () => { window.__qaAfterRelease = document.querySelector('[data-tab-id="${order[1]}"]').getBoundingClientRect().left; }, {once:true})`);
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...shortEnd }); await settle();
      check("short edge-grab drag swaps with a loose diagonal release", JSON.stringify(await tabOrder()) === JSON.stringify(order), await tabOrder());
      check("release preserves the dragged tab's screen position before settling", await cdp.evaluate("Math.abs(window.__qaAfterRelease-window.__qaBeforeRelease)<2"), await cdp.evaluate("({before:window.__qaBeforeRelease,after:window.__qaAfterRelease})"));
      await delay(180);
      const savedTabs = await cdp.evaluate("window.__qa.getState().tabs");
      await cdp.evaluate("window.__qa.setTabs([...window.__qa.getState().tabs, ...Array.from({length:20}, (_,i)=>({id:'overflow-'+i,browseId:'overflow-'+i,title:'Overflow page '+i,url:'https://example.test/overflow/'+i}))])"); await settle();
      const overflowStrip = await bounds('.rb-tabs'), overflowTab = await bounds(`[data-tab-id="${order[0]}"]`);
      const overflowPlus = await bounds('.rb-new-tab');
      check("new-tab button remains visible when tabs overflow", overflowPlus?.within && Math.abs(overflowPlus.right - overflowStrip.right) < 2, overflowPlus);
      const overflowEnd = { x: overflowStrip.right - 3, y: overflowTab.y + overflowTab.height / 2 };
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: overflowTab.x + 12, y: overflowEnd.y });
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...overflowEnd }); await settle();
      const scrollBefore = await cdp.evaluate("document.querySelector('.rb-tabs').scrollLeft"); await delay(350);
      const scrollAfter = await cdp.evaluate("document.querySelector('.rb-tabs').scrollLeft");
      check("overflow keeps scrolling while the pointer rests at the edge", scrollAfter > scrollBefore + 80, {scrollBefore, scrollAfter});
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...overflowEnd }); await settle(); await delay(180);
      await cdp.evaluate(`window.__qa.setTabs(${JSON.stringify(savedTabs)})`); await settle();
      await cdp.call("Browser.grantPermissions", { origin: new URL(report.fixtureUrl).origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
      const clipboardBefore = await cdp.evaluate("navigator.clipboard.readText()");
      try {
        await cdp.evaluate("navigator.clipboard.writeText('qa-copy-sentinel')");
        await click('[aria-label="Address or search"]'); await key("c", "KeyC", 67, 4);
        const copiedAddress = await cdp.evaluate("navigator.clipboard.readText()");
        check("Cmd+C copies the address to the real browser clipboard", copiedAddress === await cdp.evaluate("document.querySelector('[aria-label=\"Address or search\"]').value"), {copiedAddress});
        await cdp.evaluate("document.querySelector('[aria-label=\"Address or search\"]').setSelectionRange(8,20)"); await key("c", "KeyC", 67, 4);
        check("Cmd+C respects a partial address selection", await cdp.evaluate("navigator.clipboard.readText().then(text=>text===document.querySelector('[aria-label=\"Address or search\"]').value.slice(8,20))"));
      } finally { await cdp.evaluate(`navigator.clipboard.writeText(${JSON.stringify(clipboardBefore)})`); }
      await click(`[data-tab-id="${order[1]}"]`);
      check("clicking a tab selects it and removes address focus", await cdp.evaluate(`document.activeElement?.dataset.tabId===${JSON.stringify(order[1])} && document.activeElement.getAttribute('aria-selected')==='true' && !document.querySelector('.rb-address input:focus')`));
      await screenshot(`${size}-tab-selected`);
      await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      const fromTile = await bounds('[data-tile-index="0"] .rb-tile-header'), toTile = await bounds('[data-tile-index="2"] .rb-tile-header');
      const fromPoint = { x: fromTile.x + 4, y: fromTile.y + fromTile.height / 2 }, toPoint = { x: toTile.x + 4, y: toTile.y + toTile.height / 2 };
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...fromPoint });
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...toPoint }); await settle();
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...toPoint }); await settle();
      const swapped = await cdp.evaluate("window.__qa.getState().layout.tiles");
      check("dragging tile header 1 onto 3 swaps assignments", swapped[0] === originalLayout.tiles[2] && swapped[2] === originalLayout.tiles[0], swapped);
      const draggedTab = await bounds(`[data-tab-id="${order[0]}"]`), targetTile = await bounds('[data-tile-index="1"] .rb-tile-header');
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: draggedTab.x + draggedTab.width / 2, y: draggedTab.y + draggedTab.height / 2 });
      const drop = { x: targetTile.x + targetTile.width / 2, y: targetTile.y + targetTile.height / 2 };
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...drop }); await settle();
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...drop }); await settle();
      check("dragging tab onto tile assigns that page", await cdp.evaluate(`window.__qa.getState().layout.tiles[1] === ${JSON.stringify(originalLayout.tiles[0])}`));
      await cdp.evaluate(`window.__qa.setLayout(${JSON.stringify(originalLayout)})`); await settle();
    }
    const separator = await bounds('[aria-label="Resize page columns"]');
    if (separator) {
      const stage = await cdp.evaluate("(() => {const r=document.querySelector('[aria-label=\"Resize page columns\"]').parentElement.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()");
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: separator.x + 3, y: separator.y + 100, button: "left", clickCount: 1 });
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: stage.x + stage.width * .65, y: separator.y + 100, button: "left", buttons: 1 });
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: stage.x + stage.width * .65, y: separator.y + 100, button: "left", clickCount: 1 }); await settle();
      const state = await cdp.evaluate("window.__qa.getState()"); check(`${size}: divider pointer drag updates ratio`, Math.abs(state.layout.horizontal - .65) < .01, state.layout);
      await measureLayout(`${size} divider resized`, true); await screenshot(`${size}-resized-pages`);
    }
    if (width === 1600) {
      const savedLayout = await cdp.evaluate("JSON.stringify(window.__qa.getState().layout)");
      check("1600px: four pages rendered", await cdp.evaluate("document.querySelectorAll('section[aria-label^=Page]').length===4"));
      await click('[aria-label="Page menu"]');
      await cdp.call("Emulation.setDeviceMetricsOverride", { width: 900, height: 640, deviceScaleFactor: 1, mobile: false }); await settle();
      check("live resize: page menu remains bounded", (await bounds('[role="menu"]'))?.within);
      check("live resize: narrow projection shows one page without changing saved layout", await cdp.evaluate(`document.querySelectorAll('section[aria-label^=Page]').length===1 && JSON.stringify(window.__qa.getState().layout)===${JSON.stringify(savedLayout)}`));
      await screenshot("900x640-live-resize-menu"); await key("Escape", "Escape", 27); await measureLayout("live resize narrow page conversation", true);
      await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false }); await settle();
      check("live resize: four-page arrangement restored", await cdp.evaluate(`document.querySelectorAll('section[aria-label^=Page]').length===4 && JSON.stringify(window.__qa.getState().layout)===${JSON.stringify(savedLayout)}`));
      await cdp.evaluate("window.__qa.setTheme('basic')"); await settle(); await screenshot("1600x900-light-theme");
    }
  }
  // Mosaics: a saved uniform grid of live pages.
  const sections = () => cdp.evaluate("[...document.querySelectorAll('section[aria-label]')].map(e => {const r=e.getBoundingClientRect();return {label:e.getAttribute('aria-label'),x:r.x,y:r.y,width:r.width,height:r.height};})");
  const tiling = (rects, stage) => {
    let overlap = 0;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      overlap = Math.max(overlap, Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)));
    }
    const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
    return { overlap, coverage: area / (stage.width * stage.height) };
  };
  // The stage drops data-grid while a page is maximized, so measure the sections' container.
  const stageBox = () => cdp.evaluate("(() => {const r=document.querySelector('section[aria-label]').parentElement.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()");
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: report.fixtureUrl });
  for (let i = 0; i < 200 && !(await cdp.evaluate("document.documentElement.dataset.qaReady === 'true'")); i++) await delay(100);
  await cdp.evaluate("window.__qa.setChatOpen(false); window.__qa.openMosaic()"); await settle(); await delay(150);
  const grid = await sections(), stage = await stageBox(), fit = tiling(grid, stage);
  check("mosaic 3×3: nine cells, seven pages and two empty spaces", grid.length === 9 && grid.filter((s) => s.label.startsWith("Page ")).length === 7 && grid.filter((s) => s.label.startsWith("Empty space")).length === 2, grid.map((s) => s.label));
  check("mosaic 3×3: tiles cover the stage without gaps or overlap", fit.overlap < 1 && Math.abs(fit.coverage - 1) < .005, fit);
  check("mosaic 3×3: no draggable dividers", !(await cdp.evaluate("!!document.querySelector('[role=separator]')")));
  check("mosaic chip names the open mosaic", await cdp.evaluate("!!document.querySelector('[aria-label=\"Close Stock News\"]')"));
  await screenshot("1600x900-mosaic-3x3");
  const header = await bounds('section[aria-label="Page 5: Barron\'s"] > div');
  const strip = { x: header.x + 3, y: header.y + header.height / 2 };
  for (const clickCount of [1, 2]) { await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount, ...strip }); await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount, ...strip }); }
  await settle();
  const maximized = await sections();
  check("mosaic: double-clicking a header strip maximizes that page", maximized.length === 1 && maximized[0].label === "Page 1: Barron's" && tiling(maximized, await stageBox()).coverage > .995, maximized);
  await screenshot("1600x900-mosaic-maximized");
  await click('[aria-label="Restore tiled layout"]');
  check("mosaic: restore returns every cell", (await sections()).length === 9 && await cdp.evaluate("window.__qa.getState().layout.maximized === null"));
  const savedGrid = await cdp.evaluate("JSON.stringify(window.__qa.getState().layout)");
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false }); await settle(); await delay(150);
  const narrow = await sections(), narrowFit = tiling(narrow, await stageBox());
  check("mosaic at 600px: projects to fewer columns without changing the saved grid", narrow.length === 3 && narrow.every((s) => s.label.startsWith("Page ")) && narrowFit.overlap < 1 && Math.abs(narrowFit.coverage - 1) < .005
    && await cdp.evaluate(`JSON.stringify(window.__qa.getState().layout) === ${JSON.stringify(savedGrid)}`), { narrow, narrowFit });
  const pageScroll = await cdp.evaluate("({scrollWidth:document.documentElement.scrollWidth,width:innerWidth})");
  check("mosaic at 600px: no horizontal page scroll", pageScroll.scrollWidth <= pageScroll.width + 1, pageScroll);
  await screenshot("600x800-mosaic-narrow");
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false }); await settle(); await delay(150);
  check("mosaic: widening restores the saved 3×3", (await sections()).length === 9);
  for (const [dialog, title, width] of [["mosaics", "Mosaics", 1600], ["mosaic-edit", "New mosaic", 1600], ["mosaic-edit", "New mosaic", 600]]) {
    await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: width === 600 ? 800 : 900, deviceScaleFactor: 1, mobile: false });
    await cdp.evaluate(`window.__qa.setDialog(${JSON.stringify(dialog)})`); await settle();
    const box = await bounds('[role="dialog"]'), footer = await bounds(".rb-dialog-footer");
    check(`${width}px ${title} dialog: bounded with footer visible`, box?.within && footer?.within, { box, footer });
    await cdp.evaluate("[...document.querySelectorAll('[role=dialog] button')].at(-1).focus()"); await key("Tab", "Tab", 9);
    check(`${width}px ${title} dialog: Tab wraps inside`, await cdp.evaluate("!!document.activeElement.closest('[role=dialog]') && document.activeElement === [...document.querySelectorAll('[role=dialog] button, [role=dialog] input')].find(e => e.getClientRects().length)"));
    await key("Tab", "Tab", 9, 8); check(`${width}px ${title} dialog: Shift-Tab wraps inside`, await cdp.evaluate("document.activeElement === [...document.querySelectorAll('[role=dialog] button')].at(-1)"));
    await screenshot(`${width}px-${dialog}-dialog`);
    await key("Escape", "Escape", 27);
    check(`${width}px ${title} dialog: Escape closes`, await cdp.evaluate("!document.querySelector('[role=dialog]')"));
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
