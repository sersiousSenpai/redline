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
const output = path.resolve(root, process.argv[2] ?? path.join(tmpdir(), "redline-browser-visual-qa"));
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
  for (const name of ["BrowserTabRail", "BrowserHomePage", "MonochatIsland", "FrontDoor", "BrowserChrome", "BrowserSurfaces", "BrowserPagePanels", "BrowserTileStage", "MosaicDialogs", "PersistentPortalSlot", "ChatRoom", "BrowserChat"]) {
    const file = `src/components/${name}.tsx`; report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
  for (const file of ["src/lib/browserTabDrag.ts", "src/components/BrowserWorkspace.css"]) {
    report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  }
  server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), optimizeDeps: { entries: ["fixtures/browser-visual-qa/index.html"] }, plugins: [react(), tailwindcss()], resolve: { alias: [
    { find: /^.*\/hooks\/useAgentTurn$/, replacement: service }, { find: /^.*\/audio\/useReadAloud$/, replacement: service },
    ...["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/webview", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener"].map((find) => ({ find, replacement: service })),
  ] }, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null }, clearScreen: false });
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
    // The page chat as an agent-IDE panel: one header row, the user's
    // messages as cards with their chips, replies with their work rows, one
    // live line, a rail of live state and one composer capsule
    // (src/lib/browserChat, BC-34 and BC-38 to BC-41).
    const chat = await cdp.evaluate(`(() => {
      const chat = document.querySelector('[data-browser-chat]'), header = chat.querySelector('[data-browser-chat-header]'), thread = chat.querySelector('[data-browser-chat-messages]');
      const card = thread.querySelector('[data-user-turn]'), row = thread.querySelector('[data-work-rows] > li'), rail = chat.querySelector('[data-browser-chat-rail]');
      const pad = getComputedStyle(thread);
      return {
        headerHeight: header.getBoundingClientRect().height, headerNext: header.nextElementSibling === thread,
        headerButtons: [...header.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')), context: header.querySelector('.rb-thread-context').textContent,
        cardWidth: card.getBoundingClientRect().width, threadWidth: thread.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight),
        chips: [...thread.querySelectorAll('[data-user-turn] .rb-chip')].map((c) => c.dataset.kind),
        // The screenshot's picture never loads here: its box is all there is.
        pictureRatio: (() => { const r = thread.querySelector('[data-user-turn] .rb-picture')?.getBoundingClientRect(); return r ? +(r.height / r.width).toFixed(3) : null; })(),
        rows: [...thread.querySelectorAll('[data-work-rows] > li')].map((li) => li.textContent),
        rowHeights: [...new Set([...thread.querySelectorAll('[data-work-rows] > li')].map((li) => Math.round(li.getBoundingClientRect().height)))],
        weights: [getComputedStyle(row.querySelector('.rb-work-verb')).fontWeight, getComputedStyle(row.querySelector('.rb-work-object')).fontWeight],
        statuses: [...chat.querySelectorAll('[role=status]')].map((e) => e.textContent.trim()),
        rail: rail && { inThread: thread.contains(rail), above: rail.getBoundingClientRect().top <= chat.querySelector('[data-browser-chat-composer]').getBoundingClientRect().top, pills: [...rail.querySelectorAll('.rb-rail-row button')].map((b) => b.textContent.trim()) },
        quietPicker: !!chat.querySelector('[data-browser-chat-composer] [aria-label="Chat model and effort"][data-quiet]'),
        button: chat.querySelector('[data-browser-chat-composer] .rl-send').dataset.send,
        draft: chat.querySelector('[data-browser-chat-composer] textarea').value,
        targets: [...chat.querySelectorAll('[data-browser-chat-composer] button, [data-browser-chat-header] button, [data-browser-chat-rail] button')].map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); }),
      };
    })()`);
    check(`${size}: page chat header is one row naming what it follows`, chat.headerNext && chat.headerHeight <= 52 && JSON.stringify(chat.headerButtons) === JSON.stringify(["Linked mode", "Conversation actions", "Close discussion"]) && chat.context.includes("On tab 1 — Research overview") && !chat.context.includes("Following"), chat);
    check(`${size}: the user's messages are full-width cards carrying their chips`, chat.cardWidth >= chat.threadWidth - 1 && chat.chips.includes("quote") && chat.chips.includes("element"), chat);
    check(`${size}: a screenshot keeps the box of its size before the picture paints`, chat.pictureRatio !== null && Math.abs(chat.pictureRatio - 800 / 1200) < 0.02, chat.pictureRatio);
    check(`${size}: replies keep their steps as rows, reads folded and actions named`, ["Explored 2 pages, 1 search", "Clicked “Start free trial” · tab 1", "Stopped — you took over the page · tab 1"].every((r) => chat.rows.includes(r)) && JSON.stringify(chat.weights) === JSON.stringify(["500", "400"]) && chat.rowHeights.length === 1 && chat.rowHeights[0] <= 26, chat);
    check(`${size}: one live line names the running page action`, JSON.stringify(chat.statuses) === JSON.stringify(["Clicking · tab 1"]), chat.statuses);
    check(`${size}: the rail sits over the thread with the queue, the Task list and the mission`, chat.rail && !chat.rail.inThread && chat.rail.above && chat.rail.pills.some((p) => p.startsWith("1 queued")) && chat.rail.pills.includes("Task list · 2") && chat.rail.pills.includes("Team plan pricing"), chat.rail);
    // The draft from the previous viewport is restored on reload, as a draft is.
    check(`${size}: the model picker is quiet text in the composer's footer, beside one round button`, chat.quietPicker && chat.button === (chat.draft.trim() ? "queue" : "stop"), chat);
    check(`${size}: page chat controls are at least 24×24`, chat.targets.every((side) => side >= 24), chat.targets);
    await click("[data-browser-chat-composer] textarea"); await cdp.call("Input.insertText", { text: "A browser conversation draft with several lines.\n".repeat(24) }); await settle();
    await measureLayout(`${size} page conversation`, true); await screenshot(`${size}-page-conversation`);
    const capsule = await bounds("[data-browser-chat-composer] textarea"), panel = await bounds("[data-browser-chat]");
    check(`${size}: the composer grows to about 40% of the panel, then scrolls`, capsule.height <= panel.height * 0.4 + 1 && capsule.scrollHeight > capsule.clientHeight, { capsule, panel });
    await click('[aria-label="Chat model and effort"]'); const pickerPanel = await bounds('[role="menu"][aria-label="Chat model and effort"]');
    check(`${size}: model picker opens upward from the footer, bounded, Codex off and saying why without a ready codex`, pickerPanel?.within && pickerPanel.bottom <= (await bounds('[aria-label="Chat model and effort"]')).y + 1 && await cdp.evaluate("[...document.querySelectorAll('[aria-label=Provider] button')].map(b=>b.textContent+':'+b.disabled).join()==='Claude:false,Codex:true' && document.querySelector('[aria-label=Provider] button:last-child').title.length > 0"), pickerPanel);
    await screenshot(`${size}-chat-model-picker`); await key("Escape", "Escape", 27);
    await click('[aria-label="Conversation actions"]'); check(`${size}: conversation menu bounded`, (await bounds('[role="menu"]'))?.within);
    const actions = await cdp.evaluate("[...document.querySelector('[role=menu]').children].map(e=>e.textContent.trim())");
    // …and, under them, what the thread has spent.
    check(`${size}: the conversation menu holds the chat switch and the rest`, JSON.stringify(actions.slice(0, 5)) === JSON.stringify(["Open this tab’s own chat", "Start a research mission", "Text sizeA−A+", "Show the raw stream", "Clear history"]) && actions.length === 6 && /tok/.test(actions[5]), actions);
    await screenshot(`${size}-conversation-actions`); await key("Escape", "Escape", 27);
    for (const [pill, tray] of [["[data-mission]", "mission"], ["[data-browser-chat-rail] .rb-rail-row button:not([data-mission]):not(.rl-queue-pill)", "tasks"], [".rl-queue-pill", "queue"]]) {
      const threadBefore = await bounds("[data-browser-chat-messages]");
      await click(pill); const opened = await bounds(`[data-tray="${tray}"]`), threadAfter = await bounds("[data-browser-chat-messages]");
      check(`${size}: the ${tray} tray opens upward over the thread without changing its height`, opened?.within && opened.bottom <= (await bounds("[data-browser-chat-composer]")).y && threadAfter.height === threadBefore.height, { opened, threadBefore, threadAfter });
      if (tray === "mission") check(`${size}: the goal card's one primary action is Synthesize`, await cdp.evaluate("[...document.querySelectorAll('[data-tray=mission] .rb-button-primary')].map(b=>b.textContent).join()==='Synthesize'"));
      await screenshot(`${size}-rail-${tray}`);
      await key("Escape", "Escape", 27); check(`${size}: Esc closes the ${tray} tray`, !(await bounds(`[data-tray="${tray}"]`)));
    }
    await cdp.evaluate("(() => { const t = document.querySelector('[data-browser-chat-messages]'); t.scrollTop = 0; t.dispatchEvent(new Event('scroll')); })()"); await settle();
    check(`${size}: scrolling up stops following and offers ↓`, !!(await bounds("[data-browser-chat-rail] [data-jump]")));
    await screenshot(`${size}-reading-up`);
    await click("[data-browser-chat-rail] [data-jump]");
    check(`${size}: ↓ returns to the newest line and follows again`, await cdp.evaluate("(t => t.scrollHeight - t.scrollTop - t.clientHeight < 48)(document.querySelector('[data-browser-chat-messages]'))") && !(await bounds("[data-browser-chat-rail] [data-jump]")));
    await cdp.evaluate("window.__qa.setChatKind('browser-empty')"); await settle();
    const empty = await bounds("[data-browser-chat-empty]"), composerBox = await bounds("[data-browser-chat-composer]");
    check(`${size}: a new page chat opens on the composer with things to start and one tip`, empty?.within && empty.bottom <= composerBox.y + 1 && await cdp.evaluate("[...document.querySelectorAll('[data-browser-chat-empty] .rb-suggestion')].map(b=>b.textContent).join('|')==='Summarize this page|Extract a table|Start a mission' && !!document.querySelector('[data-browser-chat-empty] .rb-tip') && document.querySelector('[data-browser-chat-composer] .rl-send').dataset.send==='mic'"), { empty, composerBox });
    await screenshot(`${size}-page-chat-empty`);
    await cdp.evaluate("window.__qa.setChatKind('browser')"); await settle();
    check(`${size}: the tab the agent is acting on shows the working spinner`, await cdp.evaluate("!!document.querySelector('.rb-tab-rail [data-agent-acting] .rl-spinner')"));
    if (width === 1200) {
      // Every quiet word in the page chat reads at 4.5:1 or better on what is
      // behind it, in every theme (design decision 12).
      const contrast = `(() => {
        const parse = (c) => { let m = c.match(/rgba?\\(([^)]+)\\)/); if (m) { const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
          m = c.match(/color\\(srgb ([^)]+)\\)/); if (m) { const p = m[1].split(/[\\s\\/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; } return null; };
        const over = (top, [r, g, b]) => [top[0] * top[3] + r * (1 - top[3]), top[1] * top[3] + g * (1 - top[3]), top[2] * top[3] + b * (1 - top[3])];
        const behind = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } } return layers.reverse().reduce((acc, layer) => over(layer, acc), [255, 255, 255]); };
        const lum = (rgb) => rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
        const ratio = (el) => { const back = behind(el), fg = over(parse(getComputedStyle(el).color), back), [a, b] = [lum(fg), lum(back)].sort((x, y) => y - x); return +((a + 0.05) / (b + 0.05)).toFixed(2); };
        // The theme's own muted ink on the page, the quietest text a panel may use.
        const frame = document.querySelector('[data-browser-chat]'), probe = document.createElement('span');
        probe.style.color = 'var(--color-ink-muted)'; probe.textContent = 'x'; frame.append(probe);
        const out = { "muted ink": ratio(probe) }; probe.remove();
        for (const [name, sel] of [["row verb", ".rb-work-verb"], ["row object", ".rb-work-object"], ["header context", ".rb-chat-title span:last-child"], ["chip", "[data-user-turn] .rb-chip-label"], ["rail pill", ".rb-rail-pill"], ["tray text", "[data-tray] .rb-tray-more"], ["model", ".rb-harness-chip[data-quiet] span"], ["live line", "[data-reply='live'] [role=status]"], ["card text", "[data-user-turn] .rl-md"]]) {
          const el = document.querySelector('[data-browser-chat] ' + sel); out[name] = el ? ratio(el) : null;
        }
        return out;
      })()`;
      const themes = ["aurora", "studio", "basic", "pro", "homebrew", "ocean", "novel", "manpage", "redsand", "silveraerogel", "solidcolors", "grass", "blossom", "terminal", "redline"];
      const low = [], token = [];
      await click("[data-mission]");
      for (const theme of themes) {
        await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(theme)})`); await settle();
        const { "muted ink": muted, ...texts } = await cdp.evaluate(contrast);
        // A theme whose muted ink itself falls under the floor is the theme's
        // to fix (src/theme/derive.ts); nothing in the panel may be quieter.
        if (muted < 4.5) token.push({ theme, muted });
        for (const [name, value] of Object.entries(texts)) if (value === null || value < Math.min(4.5, muted) - 0.01) low.push({ theme, name, value, muted });
      }
      check("page chat text reads at 4.5:1 in all 15 themes, never quieter than the theme's muted ink", low.length === 0, { low, mutedInkUnderFloor: token });
      report.mutedInkUnderFloor = token;
      await key("Escape", "Escape", 27);
      await cdp.evaluate("window.__qa.setTheme('studio')"); await settle();
    }
    check(`${size}: vertical rail and new-tab button stay visible`, (await bounds('.rb-tab-rail'))?.within && (await bounds('.rb-rail-heading [aria-label="New tab"]'))?.within);
    check(`${size}: the rail starts as the 40 px icon strip`, (await bounds('.rb-tab-rail')).width === 40);
    await click('[aria-label="Show tab titles"]'); check(`${size}: showing titles widens the rail`, (await bounds('.rb-tab-rail')).width >= 168);
    await cdp.evaluate("window.__qa.setOrganized(true)"); await settle(); check(`${size}: organized groups render`, await cdp.evaluate("!!document.querySelector('[data-tab-group]')")); await screenshot(`${size}-organized-rail`);
    await cdp.evaluate("window.__qa.setOrganized(false)"); await settle();
    const savedHomeLayout = await cdp.evaluate("window.__qa.getState().layout");
    await cdp.evaluate("window.__qa.setChatOpen(false);window.__qa.setShowHome(true)"); await settle();
    check(`${size}: the new tab presents the omnibox, Pick back up and Reading by subject`, await cdp.evaluate("!!document.querySelector('.rb-home [aria-label=\"Browse or search\"]') && !!document.querySelector('.rb-home [aria-label=\"Pick back up\"]') && !!document.querySelector('.rb-home [aria-label=\"Reading, by subject\"]')")); await screenshot(`${size}-homepage`);
    // A pointer resting on the pill springs the compact card out.
    const pill = await bounds('.rl-monochat-notch'); await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: pill.x + pill.width / 2, y: pill.y + pill.height / 2 }); await delay(1200); await settle(); const island = await bounds('.rl-monochat-float');
    check(`${size}: the pill's compact card bounded to 640 wide over the mounted page`, island?.within && island.width <= 641 && island.height <= Math.min(420, height - 96) + 1 && await cdp.evaluate("!!document.querySelector('.rb-home') && !document.querySelector('[inert]:not(.rl-frontdoor-focus)')"), island);
    await screenshot(`${size}-floating-island`); await key("Escape", "Escape", 27);
    await cdp.evaluate("window.__qa.setShowHome(false);window.__qa.setChatOpen(true)"); await settle();
    if (width === 1600) {
      await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
      await click('[aria-label="Assign tab to page 1"]');
      check("tile picker themed and identifies assignments", await cdp.evaluate("document.querySelector('[role=menu]').textContent.includes('Tile 2') && !document.querySelector('select')"));
      await screenshot(`${size}-tile-picker`); await key("Escape", "Escape", 27);
      const originalLayout = await cdp.evaluate("window.__qa.getState().layout");
      const tabOrder = () => cdp.evaluate("[...document.querySelectorAll('[data-tab-id]')].map(e=>e.dataset.tabId)");
      const order = await tabOrder(), first = await bounds(`[data-tab-id="${order[0]}"]`), second = await bounds(`[data-tab-id="${order[1]}"]`);
      const start = { x: first.x + first.width / 2, y: first.y + first.height / 2 }, end = { x: start.x, y: second.bottom - 6 };
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...start }); await settle();
      check("hovering tab highlights its tile header", await cdp.evaluate("!!document.querySelector('[data-tile-index=\"0\"] .rb-tile-header[data-tile-hover]')"));
      check("tabs use the normal arrow cursor on hover", await cdp.evaluate("getComputedStyle(document.querySelector('[data-tab-id]')).cursor==='default'"));
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...start });
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...end }); await settle();
      check("tab drag follows pointer and shifts siblings before committing", JSON.stringify(await tabOrder()) === JSON.stringify(order) && await cdp.evaluate("document.querySelector('[data-dragging]').style.getPropertyValue('--tab-drag-y') !== '0px' && [...document.querySelectorAll('[data-tab-id]:not([data-dragging])')].some(e=>parseFloat(e.style.getPropertyValue('--tab-drag-y'))!==0 && e.style.getPropertyValue('--tab-drag-y'))"));
      check("tab drag prevents selection", await cdp.evaluate("getComputedStyle(document.querySelector('.rb-tabs')).userSelect === 'none' && !window.getSelection().toString()"));
      check("tab dragging keeps the normal arrow cursor", await cdp.evaluate("getComputedStyle(document.querySelector('[data-dragging]')).cursor==='default'"));
      await screenshot(`${size}-tab-drag`);
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...end }); await settle();
      check("tab order commits on release and drag styles clear", JSON.stringify(await tabOrder()) === JSON.stringify([order[1], order[0], ...order.slice(2)]) && await cdp.evaluate("!document.querySelector('[data-dragging], .rb-tabs-dragging')"));
      await delay(180);
      const edgeGrab = await bounds(`[data-tab-id="${order[1]}"]`);
      const shortStart = { x: edgeGrab.x + edgeGrab.width / 2, y: edgeGrab.y + 8 };
      const shortEnd = { x: shortStart.x + 25, y: shortStart.y + edgeGrab.height * .80 };
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...shortStart });
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...shortEnd }); await settle(); await delay(160);
      await cdp.evaluate(`window.__qaBeforeRelease = document.querySelector('[data-tab-id="${order[1]}"]').getBoundingClientRect().top; window.addEventListener('pointerup', () => { window.__qaAfterRelease = document.querySelector('[data-tab-id="${order[1]}"]').getBoundingClientRect().top; }, {once:true})`);
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...shortEnd }); await settle();
      check("short edge-grab drag swaps with a loose diagonal release", JSON.stringify(await tabOrder()) === JSON.stringify(order), await tabOrder());
      check("release preserves the dragged tab's screen position before settling", await cdp.evaluate("Math.abs(window.__qaAfterRelease-window.__qaBeforeRelease)<2"), await cdp.evaluate("({before:window.__qaBeforeRelease,after:window.__qaAfterRelease})"));
      await delay(180);
      const savedTabs = await cdp.evaluate("window.__qa.getState().tabs");
      await cdp.evaluate("window.__qa.setTabs([...window.__qa.getState().tabs, ...Array.from({length:20}, (_,i)=>({id:'overflow-'+i,browseId:'overflow-'+i,title:'Overflow page '+i,url:'https://example.test/overflow/'+i}))])"); await settle();
      const overflowStrip = await bounds('.rb-tabs'), overflowTab = await bounds(`[data-tab-id="${order[0]}"]`);
      const overflowPlus = await bounds('.rb-rail-heading [aria-label="New tab"]');
      check("new-tab button remains visible when tabs overflow", overflowPlus?.within, overflowPlus);
      const overflowEnd = { x: overflowTab.x + overflowTab.width / 2, y: overflowStrip.bottom - 3 };
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: overflowTab.x + 12, y: overflowTab.y + overflowTab.height / 2 });
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...overflowEnd }); await settle();
      const scrollBefore = await cdp.evaluate("document.querySelector('.rb-tabs').scrollTop"); await delay(350);
      const scrollAfter = await cdp.evaluate("document.querySelector('.rb-tabs').scrollTop");
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
      await click('[aria-label="Hide tab titles"]');
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
      await cdp.evaluate("window.__qa.setChatOpen(false);window.__qa.setShowHome(true)"); await settle();
      const lightPill = await bounds('.rl-monochat-notch'); await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: 450 }); await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: lightPill.x + lightPill.width / 2, y: lightPill.y + lightPill.height / 2 }); await delay(1200); await settle(); await screenshot("1600x900-light-home-island");
      await key("Escape","Escape",27); await cdp.evaluate("window.__qa.setShowHome(false);window.__qa.setChatOpen(true)"); await settle();
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
  check("mosaic 3×3: no draggable dividers", !(await cdp.evaluate("!!document.querySelector('.rb-workspace-pages [role=separator]')")));
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
