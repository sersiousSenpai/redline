#!/usr/bin/env node
// The voice panel and the Discuss pill in headless Chrome: real components and
// styles, a scripted voice backend (fixtures/voice-panel-visual-qa/services.ts)
// and timed fake speech. Usage: node scripts/voice-panel-visual-qa.mjs [output-dir]
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
const output = path.resolve(root, process.argv[2] ?? path.join(tmpdir(), "redline-voice-panel-visual-qa"));
const temporary = await mkdtemp(path.join(tmpdir(), "redline-voice-panel-qa-"));
const service = path.join(root, "fixtures/voice-panel-visual-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/voice-panel-visual-qa", screenshots: [], checks: [], errors: [], limitations: ["Headless Chrome component fixture; not WKWebView, the native mic, real speech or a live agent.", "Real VoicePanel, DiscussPill, markdown and themes; a scripted voice backend and fake speech that plays each clip for a fixed time."] };
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
async function center(selector) { return cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw new Error('Missing selector: '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`); }
async function click(selector) { const at = await center(selector); await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at }); await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...at }); await settle(); }
async function hover(selector) { const at = await center(selector); await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...at }); await settle(); }
async function holdSpace(ms) { await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32 }); await delay(ms); await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 }); await settle(); }
async function enter(text) { await cdp.evaluate("document.querySelector(\"input[aria-label='Type a message to the voice agent']\").focus()"); await cdp.call("Input.insertText", { text }); await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }); await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); await settle(); }
async function emit(event, payload) { await cdp.evaluate(`window.__qaEmit(${JSON.stringify(event)}, ${JSON.stringify(payload)})`); await settle(); }
async function screenshot(name) { const shot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); const file = `${name}.png`; await writeFile(path.join(output, file), Buffer.from(shot.data, "base64")); report.screenshots.push(file); }
async function rect(selector) { return cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};})()`); }
const calls = (name) => cdp.evaluate(`window.__qaCalls.filter(c => c[0] === ${JSON.stringify(name)}).map(c => c[1] ?? null)`);
const panelText = () => cdp.evaluate("document.querySelector('[data-tour=voice]').textContent");
const SID = "qa-plan";
const turn = (n) => ({ sessionId: SID, generation: 1, turn: n });
const REPLY = "The risk is a double apply when the panel comes back mid-turn. ⟦§A.2⟧ Gate the replay on the turn id.\n⟦screen⟧\n| Case | Today | Fix |\n|---|---|---|\n| remount | replays | gate on turn |";
try {
  await mkdir(output, { recursive: true });
  server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), optimizeDeps: { entries: ["fixtures/voice-panel-visual-qa/index.html"] }, plugins: [react(), tailwindcss()], resolve: { alias: ["@tauri-apps/api/core", "@tauri-apps/api/event"].map((find) => ({ find, replacement: service })) }, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null }, clearScreen: false });
  await server.listen();
  report.fixtureUrl = `http://127.0.0.1:${server.httpServer.address().port}/fixtures/voice-panel-visual-qa/`;
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--user-data-dir=${path.join(temporary, "chrome-profile")}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-extensions", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeLog = ""; chrome.stderr.on("data", (data) => { chromeLog += data; });
  let port;
  for (let i = 0; i < 150; i++) { try { port = (await readFile(path.join(temporary, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch {} await delay(100); }
  if (!port) throw new Error(`Chrome failed to start: ${chromeLog.slice(-3000)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new CDP(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Log.enable");
  report.browserVersion = (await cdp.call("Browser.getVersion")).product;
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: report.fixtureUrl });
  for (let i = 0; i < 200 && !(await cdp.evaluate("document.documentElement.dataset.qaReady === 'true' && !!document.querySelector('[data-voice-reply]')")); i++) await delay(100);
  await cdp.evaluate("window.__qa.setTheme('basic')"); await settle();

  // A reply stored raw renders through the same reader as a live one.
  const loaded = await panelText();
  check("A reloaded reply shows no raw markers", !loaded.includes("⟦"), loaded.slice(0, 200));
  check("…its section chip and its on-screen detail", await cdp.evaluate("[...document.querySelectorAll('[data-tour=voice] button')].some(b => b.textContent === '§ Risks') && document.querySelectorAll('[data-voice-screen] li').length === 2"));
  await screenshot("01-reloaded");

  // Space anywhere outside the panel is the app's, untouched.
  await click("[data-qa=doc-button]");
  const pressedBefore = await cdp.evaluate("window.__qa.pressed()");
  await cdp.evaluate("window.__qaCalls.length = 0");
  await holdSpace(400); await delay(450);
  check("Space held on a plan button never talks", (await calls("dictation_start")).length === 0);
  check("…and still presses that button", (await cdp.evaluate("window.__qa.pressed()")) === pressedBefore + 1);

  // A typed turn, and what the agent is doing before it speaks.
  await enter("Is the replay safe on remount?");
  check("A typed turn sends", (await calls("voice_send")).length === 1);
  await emit("voice-meter", { ...turn(1), rev: 1, meter: {}, activity: { at: 1, kind: "tool", label: "Bash…" } });
  check("Before the first word, the activity shows", (await cdp.evaluate("document.querySelector('[data-voice-thinking]')?.textContent ?? ''")).includes("Reading the plan…"));
  await screenshot("02-thinking");

  // A follow-up typed mid-reply waits in a tray that floats over the thread.
  const scroller = "[data-tour=voice] .overflow-y-auto";
  const before = await rect(scroller);
  await enter("Add that as feedback");
  check("A follow-up mid-reply is queued, not sent", (await calls("voice_send")).length === 1 && !!(await rect("[aria-label='Queued messages']")));
  const after = await rect(scroller);
  check("The tray never resizes the thread", Math.abs(before.height - after.height) < 1, { before, after });
  await cdp.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(scroller)}); s.scrollTop = s.scrollHeight; })()`); await settle();
  const thinkingBox = await rect("[data-voice-thinking]"), tray = await rect("[aria-label='Queued messages']");
  check("…nor hides the newest line", thinkingBox.bottom <= tray.y + 1, { thinkingBox, tray });
  const x = await rect("[aria-label='Queued messages'] button");
  check("The tray's × is a 24px target", x.width >= 24 && x.height >= 24, x);
  check("The composer is never disabled", !(await cdp.evaluate("document.querySelector(\"input[aria-label='Type a message to the voice agent']\").disabled")));
  await screenshot("03-queued");

  // The reply streams: spoken part to speech, detail to the screen.
  const docTop = await cdp.evaluate("document.querySelector('[data-qa=doc-scroll]').scrollTop");
  let rawSeen = false;
  for (let i = 0; i < REPLY.length; i += 9) {
    await emit("voice-delta", { ...turn(1), text: REPLY.slice(i, i + 9) });
    if ((await panelText()).includes("⟦")) rawSeen = true;
  }
  check("No marker is ever shown while streaming", !rawSeen);
  let pointed = false;
  for (let i = 0; i < 40 && !pointed; i++) { pointed = await cdp.evaluate("document.querySelector('[data-anchor-id=\"A.2\"]').classList.contains('rl-voice-point')"); if (!pointed) await delay(100); }
  check("The section lights up while its sentence plays", pointed);
  await emit("voice-done", { ...turn(1), body: REPLY, messageId: "m1", timing: {} });
  const spoken = await cdp.evaluate("window.__qaSpoken.join(' | ')");
  check("Only the spoken part is spoken", spoken.includes("The risk is a double apply") && !/Case|remount \||⟦/.test(spoken), spoken);
  check("The detail renders as a table", await cdp.evaluate("!!document.querySelector('[data-voice-reply]:last-of-type [data-voice-screen] table') || [...document.querySelectorAll('[data-voice-screen] table')].length > 0"));
  check("The queued follow-up goes once the reply is done", (await calls("voice_send")).map((a) => a.text).join(",") === "Is the replay safe on remount?,Add that as feedback");
  check("Pointing never scrolled the plan", (await cdp.evaluate("document.querySelector('[data-qa=doc-scroll]').scrollTop")) === docTop);
  await screenshot("04-reply");
  await emit("voice-done", { ...turn(2), body: "Noted — I'll stage it.", messageId: "m2", timing: {} });

  // A chip outlines on hover and scrolls on click.
  await cdp.evaluate("[...document.querySelectorAll('[data-tour=voice] button')].filter(b => b.textContent === '§ Risks').pop().setAttribute('data-qa', 'chip')");
  await delay(1700);
  await hover("[data-qa=chip]");
  check("A chip's hover outlines its section", await cdp.evaluate("document.querySelector('[data-anchor-id=\"A.2\"]').classList.contains('rl-voice-point')"));
  await click("[data-qa=chip]"); await delay(1500);
  const headingTop = await cdp.evaluate("document.querySelector('[data-anchor-id=\"A.2\"]').getBoundingClientRect().top - document.querySelector('[data-qa=doc-scroll]').getBoundingClientRect().top");
  check("A chip's click brings the section to the top", headingTop >= -2 && headingTop < 120, { headingTop });
  await screenshot("05-chip");

  // A capture confirmation comes from the write, with Undo and Show.
  await emit("voice-captured", { sessionId: SID, commentId: "c1", anchorId: "A.2", blockId: "b-A.2", sectionTitle: "Risks", body: "Gate replay on the turn id", offerId: "o1" });
  check("The capture names its section", (await panelText()).includes("📝 Captured as feedback on “Risks”: Gate replay on the turn id"));
  const undo = await cdp.evaluate("(() => { const b = [...document.querySelectorAll('[data-tour=voice] button')].filter(b => b.textContent === 'Undo' || b.textContent === 'Show'); return b.map(e => { const r = e.getBoundingClientRect(); return { t: e.textContent, h: r.height, w: r.width }; }); })()");
  check("Undo and Show are 24px targets", undo.length === 2 && undo.every((b) => b.h >= 24 && b.w >= 24), undo);
  await screenshot("06-captured");

  // Stop interrupts in place: a muted tag, never a red error.
  await enter("Walk me through testing");
  await emit("voice-delta", { ...turn(3), text: "Testing covers the reader first." });
  await click("[aria-label=Stop]");
  check("Stop asks for an interrupt, never a kill", (await calls("voice_interrupt")).length === 1 && (await calls("voice_session_stop")).length === 0);
  await emit("voice-interrupted", { ...turn(3), text: "Testing covers the reader first.", streamedChars: 32, messageId: "m3", killed: false, timing: {} });
  check("An interrupted reply is kept, with a muted tag", (await panelText()).includes("(interrupted)"));
  check("…and no error", !(await cdp.evaluate("!!document.querySelector('[data-tour=voice] p[style*=danger]')")));
  await screenshot("07-interrupted");

  // Space talks only from inside the panel, and only once held.
  await cdp.evaluate("[...document.querySelectorAll('[data-voice-reply]')].pop().firstElementChild.setAttribute('data-qa', 'byline')");
  await click("[data-qa=byline]");
  check("A click in the thread focuses the panel", await cdp.evaluate("document.activeElement?.dataset.tour === 'voice'"));
  await cdp.evaluate("window.__qaCalls.length = 0");
  await holdSpace(100); await delay(300);
  check("A Space tap in the panel does nothing", (await calls("dictation_start")).length === 0);
  await cdp.evaluate("window.__qaDictated = 'And the rollout?'");
  await holdSpace(450); await delay(500);
  check("A Space hold in the panel talks and sends on release", (await calls("dictation_start")).length === 1 && (await calls("dictation_stop")).length === 1);

  // The pill's states.
  await cdp.evaluate("window.__qaInFlight = true; window.__qa.setAway({ key: 'qa-plan', state: 'thinking' })"); await settle();
  check("The pill shows a working mark", await cdp.evaluate("!!document.querySelector('.rl-discuss-badge[data-state=thinking]')"));
  await cdp.evaluate("window.__qa.setAway({ key: 'qa-plan', state: 'waiting' })"); await settle();
  const pill = await rect(".rl-discuss-pill"), badge = await rect(".rl-discuss-badge");
  check("…then a reply-waiting dot on its corner", badge && Math.abs(badge.right - pill.right) < 6 && Math.abs(badge.y - pill.y) < 6, { pill, badge });
  check("…and stays one button", await cdp.evaluate("document.querySelector('.rl-discuss-pill').querySelectorAll('button').length === 0"));
  await screenshot("08-pill-waiting");

  // A turn taken with the hold key and the panel closed: the pill springs into
  // a caption — what it hears, then what the agent does, then the reply as it
  // is spoken — and shrinks back once it is said. (Another conversation's key,
  // so the open panel here never takes it over.)
  const AWAY = { sessionId: "qa-away", generation: 1 };
  const capWait = async (test, ms = 3000) => { for (let i = 0; i < ms / 50 && !(await cdp.evaluate(test)); i++) await delay(50); return cdp.evaluate(test); };
  await cdp.evaluate("window.__qa.setCaption({ key: 'qa-away', phase: 'hearing', text: 'is the replay safe on remount', levels: [0.2, 0.5, 0.9, 0.6, 0.3, 0.7], activity: null, since: Date.now() })");
  await capWait("!!document.querySelector('.rl-discuss-caption')");
  await delay(500);
  const pillBox = await rect(".rl-discuss-pill"), capBox = await rect(".rl-discuss-caption");
  check("Hearing, the pill springs into a caption on its own corner", capBox && Math.abs(capBox.x - pillBox.x) < 1.5 && Math.abs(capBox.bottom - pillBox.bottom) < 1.5, { pillBox, capBox });
  check("…at most 420 px wide, and never past the pane", capBox.width <= 420 && capBox.right <= (await rect("[data-qa=doc-scroll]")).right, capBox);
  check("…the pill hidden under it", (await cdp.evaluate("getComputedStyle(document.querySelector('.rl-discuss-pill')).visibility")) === "hidden");
  check("…with the waveform and the words", await cdp.evaluate("document.querySelectorAll('.rl-discuss-caption-wave i').length === 16 && document.querySelector('.rl-discuss-caption').textContent.includes('is the replay safe on remount')"));
  await screenshot("11-caption-hearing");
  await cdp.evaluate("window.__qa.setCaption({ ...window.__qa.caption(), phase: 'thinking', text: '', levels: [], activity: { at: 1, kind: 'tool', label: 'Bash…' } })"); await settle();
  check("Thinking, it says what the agent is doing", (await cdp.evaluate("document.querySelector('.rl-discuss-caption').textContent")).includes("Reading the plan…"));
  check("…on one line", (await rect(".rl-discuss-caption")).height <= 32, await rect(".rl-discuss-caption"));
  await screenshot("12-caption-thinking");

  // The reply, through the background reply's own speech queue.
  await cdp.evaluate("window.__qa.setClipMs(400); window.__qaSpoken.length = 0");
  await cdp.evaluate("window.__qa.away.expect('qa-away').then(() => window.__qa.away.sent('qa-away', { generation: 1, turn: 41 }))"); await settle();
  await emit("voice-delta", { ...AWAY, turn: 41, text: "Mostly, yes. The risk is a double apply when the panel comes back in the middle of a turn that is still streaming its answer. " });
  await emit("voice-delta", { ...AWAY, turn: 41, text: "Gate it on the turn id.\n⟦screen⟧\n| Case | Fix |\n|---|---|\n| remount | gate |" });
  const speakingCap = await capWait("window.__qa.caption()?.phase === 'speaking'");
  check("Speaking, it shows the sentence being said", speakingCap && (await cdp.evaluate("document.querySelector('.rl-discuss-caption').textContent")).includes("Mostly, yes."));
  await capWait("document.querySelector('.rl-discuss-caption').textContent.includes('double apply')");
  const two = await rect(".rl-discuss-caption");
  check("…in two lines at most", two.height > 32 && two.height <= 52, two);
  check("…and only the spoken part is said", await cdp.evaluate("window.__qaSpoken.join(' ').includes('Mostly, yes.') && !/Case|remount|⟦/.test(window.__qaSpoken.join(' '))"), await cdp.evaluate("window.__qaSpoken"));
  await screenshot("13-caption-speaking");
  // A click opens the panel, and the caret stays where it was.
  await cdp.evaluate("document.querySelector(\"input[aria-label='Type a message to the voice agent']\").focus()");
  const openedBefore = await cdp.evaluate("window.__qa.opened()");
  await click(".rl-discuss-caption");
  check("A click on the caption is the pill's: the panel opens", (await cdp.evaluate("window.__qa.opened()")) === openedBefore + 1);
  check("…and the caret stays where it was", (await cdp.evaluate("document.activeElement?.getAttribute('aria-label')")) === "Type a message to the voice agent");
  // Esc stops it: the speech, the turn, and the caption.
  await cdp.evaluate("document.activeElement.blur(); window.__qaCalls.length = 0");
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await settle();
  check("Esc stops the reply and the turn", (await calls("voice_interrupt")).some((a) => a?.sessionId === "qa-away"));
  check("…and the caption shrinks back into the pill", await capWait("!document.querySelector('.rl-discuss-caption') && getComputedStyle(document.querySelector('.rl-discuss-pill')).visibility === 'visible'"));
  // A reply heard to its end stays a moment, then goes by itself.
  await cdp.evaluate("window.__qa.setCaption({ key: 'qa-away', phase: 'thinking', text: '', levels: [], activity: null, since: Date.now() })");
  await cdp.evaluate("window.__qa.away.expect('qa-away').then(() => window.__qa.away.sent('qa-away', { generation: 1, turn: 42 }))"); await settle();
  await emit("voice-delta", { ...AWAY, turn: 42, text: "It ships behind a flag." });
  await emit("voice-done", { ...AWAY, turn: 42, body: "It ships behind a flag.", messageId: "m9", timing: {} });
  check("Once said, it rests on the last sentence", await capWait("window.__qa.caption()?.phase === 'done'"));
  await screenshot("14-caption-done");
  check("…for about 2 s, then shrinks back by itself", !(await cdp.evaluate("!document.querySelector('.rl-discuss-caption')")) && (await capWait("!document.querySelector('.rl-discuss-caption')", 4000)));
  // Its words reach 4.5:1 in every theme.
  for (const theme of ["studio", "aurora", "terminal", "basic"]) {
    await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(theme)})`);
    await cdp.evaluate("window.__qa.setCaption({ key: 'qa-away', phase: 'speaking', text: 'The risk is a double apply when the panel comes back.', levels: [], activity: null, since: Date.now() })");
    await capWait("!!document.querySelector('.rl-discuss-caption')"); await delay(450);
    const ratio = await cdp.evaluate(`(() => { const lum = (c) => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }; const el = document.querySelector('.rl-discuss-caption'); const s = getComputedStyle(el); const a = lum(s.color), b = lum(s.backgroundColor); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); })()`);
    check(`${theme}: the caption's words reach 4.5:1`, ratio >= 4.5, { ratio });
    await screenshot(`15-caption-${theme}`);
    await cdp.evaluate("window.__qa.setCaption(null)"); await capWait("!document.querySelector('.rl-discuss-caption')");
  }
  await cdp.evaluate("window.__qa.setTheme('basic')"); await settle();

  // The studio voice: its card in settings, then a reply its stand-in reads
  // while the model warms, with a quiet chip that takes no focus.
  await emit("voice-done", { ...turn(await cdp.evaluate("window.__qaTurn")), body: "It ships behind a flag.", messageId: "m4", timing: {} });
  await click("[aria-label='Voice settings']");
  await cdp.evaluate("(() => { const s = document.querySelector('[data-tour=voice] select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'studio'); s.dispatchEvent(new Event('change', { bubbles: true })); })()");
  for (let i = 0; i < 50 && !(await cdp.evaluate("!!document.querySelector('[data-studio-card] [aria-label=\"Play a sample of Ryan\"]')")); i++) await delay(100);
  const cardText = await cdp.evaluate("document.querySelector('[data-studio-card]')?.textContent ?? ''");
  check("The studio card says what it costs", cardText.includes("Studio voice — 3.1 GB download, about 4.2 GB memory while speaking"), cardText.slice(0, 120));
  check("…and that it is installed, with its speed check", cardText.includes("✓ Installed") && cardText.includes("3.7 times faster"));
  const plays = await cdp.evaluate("[...document.querySelectorAll('[data-studio-card] button[aria-label^=\"Play a sample\"]')].map(b => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height }; })");
  check("Its three previews are 24px targets", plays.length === 3 && plays.every((b) => b.w >= 24 && b.h >= 24), plays);
  await screenshot("09-studio-card");
  const polishRow = await cdp.evaluate("document.querySelector('[data-studio-polish]')?.textContent ?? ''");
  check("Local polish is offered as a download of its own", polishRow.includes("Polish dictation locally — 1.7 GB download, about 1.9 GB of memory while in use"), polishRow.slice(0, 120));
  await cdp.evaluate("document.querySelector('[data-studio-polish]').scrollIntoView({ block: 'center' })"); await settle();
  const polishInstall = await rect("[data-studio-polish] button");
  check("…its install a 24px target", polishInstall && polishInstall.height >= 24 && polishInstall.width >= 24, polishInstall);
  await cdp.evaluate("window.__qa.setWidth(300)"); await settle();
  const spill = await cdp.evaluate("(() => { const c = document.querySelector('[data-studio-card]'); const right = c.getBoundingClientRect().right; return [...c.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > right + 1).map(e => e.tagName + ':' + (e.textContent ?? '').slice(0, 30)).slice(0, 5); })()");
  check("At 300px nothing in the studio card, local polish included, spills out", spill.length === 0, spill);
  await screenshot("09-studio-polish-300");
  await cdp.evaluate("window.__qa.setWidth(360)"); await settle();
  await cdp.evaluate("[...document.querySelectorAll('[data-tour=voice] button')].find(b => b.textContent === 'Save').click()"); await delay(300);
  await enter("And the testing section?");
  const studioTurn = turn(await cdp.evaluate("window.__qaTurn"));
  const focusBefore = await cdp.evaluate("document.activeElement?.getAttribute('aria-label')");
  await emit("voice-delta", { ...studioTurn, text: "⟦tone: calm⟧ Testing covers the reader first. Then the replay." });
  for (let i = 0; i < 30 && !(await cdp.evaluate("!!document.querySelector('[data-studio-chip]')")); i++) await delay(100);
  const chip = await cdp.evaluate("document.querySelector('[data-studio-chip]')?.textContent ?? ''");
  check("A reply before the model is warm shows why its stand-in reads", chip === "Studio voice warming · System voice reading", chip);
  check("…which never takes focus", (await cdp.evaluate("document.activeElement?.getAttribute('aria-label')")) === focusBefore, focusBefore);
  check("…and the stand-in reads it, the tone marker left out", (await cdp.evaluate("window.__qaSpoken.slice(-1)[0] ?? ''")).startsWith("Testing covers the reader first."));
  const status = await rect("[data-studio-chip] + span"), chipBox = await rect("[data-studio-chip]");
  check("…on the status row, beside the speech state, on one line", chipBox && chipBox.right <= status.x && Math.abs(chipBox.y + chipBox.height / 2 - (status.y + status.height / 2)) < 3 && chipBox.height < 24, { status, chipBox });
  await screenshot("10-studio-chip");
  await emit("voice-done", { ...studioTurn, body: "⟦tone: calm⟧ Testing covers the reader first. Then the replay.", messageId: "m5", timing: {} });
  await click("[aria-label='Voice settings']");
  check("The speed slider is off on the studio voice", await cdp.evaluate("document.querySelector(\"input[aria-label='Speech speed']\").disabled"));
  await click("[aria-label='Voice settings']");

  for (const theme of ["studio", "aurora", "terminal", "basic"]) {
    for (const width of [360, 300]) {
      await cdp.evaluate(`window.__qa.setTheme(${JSON.stringify(theme)}); window.__qa.setWidth(${width})`); await settle();
      const overflow = await cdp.evaluate("(() => { const p = document.querySelector('[data-tour=voice]'); return [...p.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > p.getBoundingClientRect().right + 1 && getComputedStyle(e).position !== 'fixed').map(e => e.tagName + '.' + e.className).slice(0, 5); })()");
      check(`${theme} ${width}px: nothing spills out of the panel`, overflow.length === 0, overflow);
      await screenshot(`09-${theme}-${width}`);
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
