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
const output = path.resolve(root, process.argv[2] ?? "docs/redline-card-qa-2026-10-09");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-browser-visual-qa-"));
const service = path.join(root, "fixtures/monochat-aurora-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/monochat-aurora-qa", screenshots: [], checks: [], errors: [], sourceSha256: {}, limitations: ["Headless Chrome component fixture; not WKWebView/native hit-testing or live Redline.", "Agent, dictation, audio and Tauri service interfaces are synthetic; no capture, database, user profile or agent launch.", "Document, browser page and recents contents are illustrative. Production chat, island, chips, setup, menus and theme components are imported intact."] };
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
  for (const file of ["src/hooks/useFrontDoorConversation.ts", "src/components/MonochatIsland.tsx", "src/components/MonochatIsland.css", "src/components/SurfaceChips.tsx", "src/lib/surfaceContext.ts", "src/components/ChatRoom.tsx", "src/components/MonochatTrace.tsx", "src/components/FrontDoor.tsx", "src/components/ComposerMenu.tsx", "src/components/ComposerMenu.css", "src/App.tsx", "src/components/IntegrationSetupDialog.tsx", "src/styles.css"]) report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root,file))).digest("hex");
  server = await createServer({ configFile:false, root, cacheDir:path.join(temporary,"vite-cache"), optimizeDeps:{entries:["fixtures/monochat-aurora-qa/index.html"], include:["@tauri-apps/plugin-deep-link", "@tauri-apps/api/webview", "@tauri-apps/api/dpi", "@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-webgl"]}, plugins:[react(),tailwindcss()], resolve:{alias:[
    {find:/^.*\/hooks\/useAgentTurn$/,replacement:service}, {find:/^.*\/audio\/useReadAloud$/,replacement:service}, {find:/^.*\/lib\/useDictation$/,replacement:service},
    ...["@tauri-apps/api/core","@tauri-apps/api/event","@tauri-apps/api/window","@tauri-apps/plugin-dialog","@tauri-apps/plugin-opener"].map(find=>({find,replacement:service}))
  ]},server:{host:"127.0.0.1",port:0,watch:{ignored:["**/src-tauri/**","**/docs/**"]}},clearScreen:false});
  await server.listen(); report.fixtureUrl=`http://127.0.0.1:${server.httpServer.address().port}/fixtures/monochat-aurora-qa/`;
  chrome=spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",["--headless=new",`--user-data-dir=${path.join(temporary,"chrome-profile")}`,"--remote-debugging-port=0","--remote-debugging-address=127.0.0.1","--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-sync","--disable-extensions","about:blank"],{stdio:"ignore"});
  let port; for(let i=0;i<150;i++){try{port=(await readFile(path.join(temporary,"chrome-profile/DevToolsActivePort"),"utf8")).split("\n")[0];break;}catch{} await delay(100);}
  if(!port)throw new Error("Chrome did not start");
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(); cdp=new CDP(targets.find(t=>t.type==="page").webSocketDebuggerUrl);
  await cdp.call("Page.enable");await cdp.call("Runtime.enable");await cdp.call("Log.enable");
  const card = () => bounds('.rl-monochat-card');
  const cardOpen = "!document.querySelector('.rl-monochat-card').hidden";
  for(const [width,height] of [[1440,960],[900,640],[480,720]]) {
    const size=`${width}x${height}`;
    await cdp.call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
    await cdp.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
    await cdp.call("Page.navigate",{url:report.fixtureUrl});
    let ready=false;for(let i=0;i<150;i++){if(await cdp.evaluate("document.documentElement.dataset.qaReady==='true'")){ready=true;break;}await delay(100);}
    if(!ready)throw new Error(`Fixture did not render: ${report.errors.join("\n")}`);
    await delay(700); await settle();
    // Boot: the card is open over an empty plate, carrying the recents, and the tour can anchor on it.
    await screenshot(`${size}-boot`);
    const boot = await card(), notch = await bounds('.rl-monochat-notch'), footer = await bounds('.rl-app-footer');
    check(`${size} boot opens the card with the caret in its composer`, await cdp.evaluate(cardOpen) && await cdp.evaluate("document.activeElement===document.querySelector('[data-chat-composer] textarea')"));
    check(`${size} card bounded, centred, at most 640 wide in compose`, boot.within && Math.abs(boot.x + boot.width/2 - width/2) < 1 && boot.width <= 641, boot);
    check(`${size} card floats above the pill and the footer`, boot.bottom <= notch.y + 1 && boot.bottom < footer.y, { boot, notch, footer });
    check(`${size} no hero headline anywhere`, await cdp.evaluate("!document.querySelector('.rl-monochat-card h1, .rl-monochat-card h2')"));
    check(`${size} recents sit above the composer`, await cdp.evaluate("(() => { const r=document.querySelector('[aria-label=\"Jump back in\"]'); const i=document.querySelector('.rl-fd-island'); return !!r && r.getBoundingClientRect().bottom <= i.getBoundingClientRect().top + 1; })()"));
    check(`${size} page recents capped at four`, await cdp.evaluate("document.querySelectorAll('.rl-fd-browse').length===4"));
    check(`${size} tour anchor measurable at boot`, (await bounds('[data-tour="landing"]'))?.visible);
    check(`${size} the workspace is not made inert`, await cdp.evaluate("!document.querySelector('.qa-nav').closest('[inert]')"));
    const islandBefore = await bounds('.rl-fd-island');
    await cdp.call("Input.insertText",{text:"Plan the billing export"}); await settle();
    const islandAfter = await bounds('.rl-fd-island');
    check(`${size} typing drops the recents and keeps the composer in place`, await cdp.evaluate("!document.querySelector('[aria-label=\"Jump back in\"]')") && Math.abs(islandAfter.bottom - islandBefore.bottom) < 1, { islandBefore, islandAfter });
    await screenshot(`${size}-typing`);
    await cdp.evaluate("window.__qa.setText('')"); await settle();
    // Esc from inside closes; the pill is centred in the footer row.
    await key('Escape','Escape',27);
    check(`${size} Esc collapses to the pill`, !await cdp.evaluate(cardOpen) && await cdp.evaluate("getComputedStyle(document.querySelector('.rl-monochat-notch')).visibility==='visible'"));
    const pill = await bounds('.rl-monochat-notch');
    check(`${size} pill centred in the footer row`, Math.abs(pill.x+pill.width/2-width/2)<1 && Math.abs(pill.y+pill.height/2-footer.y-footer.height/2)<1 && pill.width===160 && pill.height===40, { pill, footer });
    check(`${size} pill clear of footer controls`, pill.x>=(await bounds('.rl-footer-status')).right && pill.right<=(await bounds('.rl-footer-actions')).x);
    await screenshot(`${size}-pill`);
    // Document surface: hover peek, leave, collapse.
    await cdp.evaluate("window.__qa.setSurface('Document')"); await settle();
    await cdp.evaluate("document.querySelector('#qa-document-focus').focus()");
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:pill.x+pill.width/2,y:pill.y+pill.height/2}); await delay(900); await settle();
    check(`${size} a hover peeks the card open without taking focus`, await cdp.evaluate(cardOpen) && await cdp.evaluate("document.activeElement.id==='qa-document-focus'"));
    check(`${size} the plan surface offers its own chip, pressed`, await cdp.evaluate("[...document.querySelectorAll('.rl-context-chips button')].map(b=>b.textContent+':'+b.getAttribute('aria-pressed')).join()==='This plan · v3:true'"));
    await screenshot(`${size}-peek-document`);
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:20,y:height/2}); await delay(700); await settle();
    check(`${size} leaving an untouched peek collapses it`, !await cdp.evaluate(cardOpen));
    // Click opens and engages: clicks elsewhere do not dismiss it.
    await click('.rl-monochat-notch');
    check(`${size} a click opens and focuses the composer`, await cdp.evaluate(cardOpen) && await cdp.evaluate("document.activeElement===document.querySelector('[data-chat-composer] textarea')"));
    await click('.qa-nav strong'); await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:20,y:height/2}); await delay(700); await settle();
    check(`${size} an engaged card survives clicks and the pointer leaving`, await cdp.evaluate(cardOpen));
    await click('.rl-context-chips button');
    check(`${size} a chip toggles off`, await cdp.evaluate("document.querySelector('.rl-context-chips button').getAttribute('aria-pressed')==='false'"));
    for (const label of ['Choose project','Destination']) {
      await click(`[aria-label="${label}"]`);
      check(`${size} ${label} menu bounded`,(await bounds(`[role="menu"][aria-label="${label}"]`))?.within);
      await screenshot(`${size}-${label.replaceAll(' ','-').toLowerCase()}`);
      await key('Escape','Escape',27);
      check(`${size} ${label} Escape keeps the card open`, await cdp.evaluate(cardOpen));
    }
    await click('[aria-label="Collapse Redline"]');
    check(`${size} ⌄ collapses`, !await cdp.evaluate(cardOpen));
    // Shift+Enter summons from the document and focuses.
    await cdp.evaluate("document.querySelector('#qa-document-focus').focus()");
    await key('Enter','Enter',13,8);
    check(`${size} Shift+Enter summons and focuses`, await cdp.evaluate(cardOpen) && await cdp.evaluate("document.activeElement===document.querySelector('[data-chat-composer] textarea')"));
    await key('Escape','Escape',27);
    check(`${size} Esc returns focus to the document`, await cdp.evaluate("document.activeElement.id==='qa-document-focus'"));
    // Browser surface: This page / Task list.
    await cdp.evaluate("window.__qa.setSurface('Browser')"); await settle();
    await click('.rl-monochat-notch');
    check(`${size} the browser keeps This page and Task list`, await cdp.evaluate("[...document.querySelectorAll('.rl-context-chips button')].map(b=>b.textContent+':'+b.getAttribute('aria-pressed')).join()==='This page:true,Task list:false'"));
    await screenshot(`${size}-browser`);
    // The chat pose grows the same card; ⤢ grows it again; New hands back.
    await cdp.evaluate("window.__qa.openChat('qa')"); await delay(500); await settle();
    const chat = await card();
    check(`${size} a chat grows the card in place`, await cdp.evaluate("document.querySelector('.rl-monochat-card').dataset.pose==='chat'") && chat.within && chat.width <= 761 && chat.height > boot.height && !!await cdp.evaluate("document.querySelector('.rl-monochat-card [data-chat-messages]')?.textContent.includes('How do we preserve')"), chat);
    check(`${size} one composer, at the bottom of the thread`, await cdp.evaluate("document.querySelectorAll('textarea[aria-label=\"Message Redline\"]').length===1"));
    await screenshot(`${size}-chat`);
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:20,y:height/2}); await delay(700); await settle();
    check(`${size} the chat pose never collapses on leave`, await cdp.evaluate(cardOpen));
    await click('[aria-label="Enlarge the card"]'); await delay(450); await settle();
    const tall = await card();
    check(`${size} ⤢ makes it roomier, still inside the window`, tall.within && tall.height > chat.height && await cdp.evaluate("document.querySelector('.rl-monochat-card').dataset.size==='tall'"), tall);
    await screenshot(`${size}-chat-tall`);
    await click('.rl-monochat-new'); await settle();
    check(`${size} New returns to a blank composer`, await cdp.evaluate("document.querySelector('.rl-monochat-card').dataset.pose==='compose'&&!document.querySelector('[data-chat-room]')"));
    await cdp.evaluate("window.__qa.setSetup(true)");await settle();
    check(`${size} setup remains accessible above the card`,await cdp.evaluate("!!document.querySelector('dialog:modal')"));
    await key('Escape','Escape',27);
    await cdp.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
    await click('[aria-label="Collapse Redline"]'); await settle();
    check(`${size} reduced motion disables attraction`,await cdp.evaluate("document.querySelector('.rl-portal-membrane').style.getPropertyValue('--portal-pull')===''"));
  }
} catch(error) {report.errors.push(error.stack??String(error));}
finally {
  report.finishedAt=new Date().toISOString(); report.passed=report.checks.every(check=>check.passed)&&report.errors.length===0;
  await mkdir(output,{recursive:true});await writeFile(path.join(output,"report.json"),JSON.stringify(report,null,2)+"\n");
  cdp?.close();chrome?.kill();await server?.close();await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,errors:report.errors,output},null,2));if(!report.passed)process.exitCode=1;
}
