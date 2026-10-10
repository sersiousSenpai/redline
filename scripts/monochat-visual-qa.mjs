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
const output = path.resolve(root, process.argv[2] ?? "docs/front-door-qa-2026-10-10");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-browser-visual-qa-"));
const service = path.join(root, "fixtures/monochat-aurora-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/monochat-aurora-qa", screenshots: [], checks: [], errors: [], sourceSha256: {}, limitations: ["Headless Chrome component fixture; not WKWebView/native hit-testing or live Redline.", "Agent, dictation, audio and Tauri service interfaces are synthetic; no capture, database, user profile or agent launch.", "Document, browser page and recents contents are illustrative. Production chat, island, compact card, chips, setup, menus and theme components are imported intact."] };
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
  for (const file of ["src/hooks/useFrontDoorConversation.ts", "src/components/MonochatIsland.tsx", "src/components/MonochatIsland.css", "src/components/MonochatCard.tsx", "src/components/MonochatCard.css", "src/components/SurfaceChips.tsx", "src/lib/surfaceContext.ts", "src/components/ChatRoom.tsx", "src/components/MonochatTrace.tsx", "src/components/FrontDoor.tsx", "src/components/ComposerMenu.tsx", "src/components/ComposerMenu.css", "src/App.tsx", "src/components/IntegrationSetupDialog.tsx", "src/styles.css"]) report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root,file))).digest("hex");
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
  const card = () => bounds('.rl-monochat-float');
  const cardOpen = "!!document.querySelector('.rl-monochat-float')";
  const pose = "document.querySelector('.rl-monochat').dataset.pose";
  const doorComposer = "document.querySelector('.rl-frontdoor-focus [data-chat-composer] textarea')";
  const move = (x, y) => cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  for(const [width,height] of [[1440,960],[900,640],[480,720]]) {
    const size=`${width}x${height}`;
    await cdp.call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
    await cdp.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
    await cdp.call("Page.navigate",{url:report.fixtureUrl});
    let ready=false;for(let i=0;i<150;i++){if(await cdp.evaluate("document.documentElement.dataset.qaReady==='true'")){ready=true;break;}await delay(100);}
    if(!ready)throw new Error(`Fixture did not render: ${report.errors.join("\n")}`);
    await delay(700); await settle();
    // Boot on the empty plate: the door rests there — headline, composer,
    // recents — with no pill and no caret taken.
    await screenshot(`${size}-rest`);
    const footer = await bounds('.rl-app-footer');
    check(`${size} boot rests the door on the empty plate`, await cdp.evaluate(`${pose}==='entry'`) && !!await cdp.evaluate("document.querySelector('.rl-fd-welcome-hero h1')?.textContent.includes('Every build starts as a draft.')"));
    check(`${size} boot takes no caret and opens nothing modal`, await cdp.evaluate("document.activeElement===document.body && !document.querySelector('[aria-modal]') && !document.querySelector('.qa-nav').closest('[inert]')"));
    check(`${size} no pill while the door rests`, await cdp.evaluate("getComputedStyle(document.querySelector('.rl-monochat-notch')).visibility==='hidden'"));
    check(`${size} recents sit below the composer`, await cdp.evaluate("(() => { const r=document.querySelector('[aria-label=\"Jump back in\"]'); const i=document.querySelector('.rl-frontdoor-focus .rl-fd-island'); return !!r && r.getBoundingClientRect().top >= i.getBoundingClientRect().bottom - 1; })()"));
    check(`${size} page recents never scroll`, await cdp.evaluate("(() => { const l=document.querySelector('.rl-fd-browse-list'); return !l || l.scrollHeight <= l.clientHeight + 1; })()"));
    check(`${size} tour anchor measurable at rest`, (await bounds('[data-tour="landing"]'))?.visible);
    // A press in the resting composer engages it: the backdrop spreads, the box stays put.
    const restBox = await bounds('.rl-frontdoor-focus .rl-fd-island');
    await click('.rl-frontdoor-focus .rl-fd-input');
    const engagedBox = await bounds('.rl-frontdoor-focus .rl-fd-island');
    check(`${size} a press engages the resting door as a modal`, await cdp.evaluate(`${pose}==='conversation'`) && await cdp.evaluate("!!document.querySelector('[role=dialog][aria-modal=true]')"));
    check(`${size} engaging never moves the composer`, Math.abs(engagedBox.y-restBox.y)<1 && Math.abs(engagedBox.x-restBox.x)<1, { restBox, engagedBox });
    check(`${size} the welcome stays until a keystroke`, await cdp.evaluate("!document.querySelector('.rl-frontdoor-focus .rl-frontdoor').classList.contains('is-engaged')"));
    await cdp.call("Input.insertText",{text:"Plan the billing export"}); await settle();
    const typedBox = await bounds('.rl-frontdoor-focus .rl-fd-island');
    check(`${size} typing fades the welcome and keeps the composer in place`, await cdp.evaluate("document.querySelector('.rl-frontdoor-focus .rl-frontdoor').classList.contains('is-engaged')") && Math.abs(typedBox.y-engagedBox.y)<1, { engagedBox, typedBox });
    await screenshot(`${size}-engaged`);
    await cdp.evaluate("window.__qa.setText('')"); await settle();
    await key('Escape','Escape',27);
    check(`${size} Esc returns the door to rest`, await cdp.evaluate(`${pose}==='entry'`));
    // Document surface: the pill, centred in the footer row.
    await cdp.evaluate("window.__qa.setSurface('Document')"); await settle();
    const pill = await bounds('.rl-monochat-notch');
    check(`${size} pill centred in the footer row`, Math.abs(pill.x+pill.width/2-width/2)<1 && Math.abs(pill.y+pill.height/2-footer.y-footer.height/2)<1 && pill.width===160 && pill.height===40, { pill, footer });
    check(`${size} pill clear of footer controls`, pill.x>=(await bounds('.rl-footer-status')).right && pill.right<=(await bounds('.rl-footer-actions')).x);
    await screenshot(`${size}-pill`);
    // Hover springs the compact card out, without the caret.
    await cdp.evaluate("document.querySelector('#qa-document-focus').focus()");
    await move(pill.x+pill.width/2, pill.y+pill.height/2); await delay(1200); await settle();
    const peek = await card();
    check(`${size} a resting pointer springs the compact card out without taking focus`, await cdp.evaluate(cardOpen) && await cdp.evaluate("document.activeElement.id==='qa-document-focus'"));
    check(`${size} the card is bounded, centred and above the pill`, peek?.within && Math.abs(peek.x + peek.width/2 - width/2) < 1 && peek.width <= 641 && peek.bottom <= pill.y + 1, { peek, pill });
    check(`${size} the card carries the surface's chip, pressed`, await cdp.evaluate("[...document.querySelectorAll('.rl-monochat-float .rl-context-chips button')].map(b=>b.textContent+':'+b.getAttribute('aria-pressed')).join()==='This plan · v3:true'"));
    check(`${size} the card holds no headline, recents or History`, await cdp.evaluate("!document.querySelector('.rl-monochat-float h1, .rl-monochat-float [aria-label=\"Jump back in\"], .rl-monochat-float [aria-label=\"Conversation history\"]')"));
    check(`${size} the card never scrolls sideways`, await cdp.evaluate("(() => { const c=document.querySelector('.rl-monochat-float'); return c.scrollWidth <= c.clientWidth && getComputedStyle(c).overflowX==='hidden'; })()"));
    check(`${size} the pill stays a live target while the card is out`, await cdp.evaluate("getComputedStyle(document.querySelector('.rl-monochat-notch')).visibility==='visible'"));
    await screenshot(`${size}-card-document`);
    await move(20, height/2); await delay(700); await settle();
    check(`${size} leaving an untouched card closes it`, !await cdp.evaluate(cardOpen));
    // Pinned by a press inside; a press outside still closes it.
    await move(pill.x+pill.width/2, pill.y+pill.height/2); await delay(1200); await settle();
    await click('.rl-monochat-float .rl-fd-input');
    await move(20, height/2); await delay(700); await settle();
    check(`${size} a press inside pins the card`, await cdp.evaluate(cardOpen));
    await click('.qa-nav strong');
    check(`${size} a press outside closes it`, !await cdp.evaluate(cardOpen));
    // A click on the pill grows the card into the door, caret in.
    await move(pill.x+pill.width/2, pill.y+pill.height/2); await delay(1200); await settle();
    await click('.rl-monochat-notch'); await delay(400); await settle();
    check(`${size} a click on the pill opens the full door with the caret`, !await cdp.evaluate(cardOpen) && await cdp.evaluate(`${pose}==='conversation'`) && await cdp.evaluate(`document.activeElement===${doorComposer}`));
    check(`${size} the door wears its headline`, await cdp.evaluate("!!document.querySelector('.rl-frontdoor-focus .rl-fd-welcome-hero h1')"));
    await screenshot(`${size}-door`);
    for (const label of ['Choose project','Destination']) {
      await click(`.rl-frontdoor-focus [aria-label="${label}"]`);
      check(`${size} ${label} menu bounded`,(await bounds(`[role="menu"][aria-label="${label}"]`))?.within);
      await key('Escape','Escape',27);
      check(`${size} ${label} Escape keeps the door open`, await cdp.evaluate(`${pose}==='conversation'`));
    }
    await click('[aria-label="Return to workspace"]');
    check(`${size} ⌄ returns to the workspace`, await cdp.evaluate(`${pose}==='notch'`));
    // Shift+Enter summons from the document, never from a text field.
    await cdp.evaluate("document.querySelector('#qa-document-focus').focus()");
    await key('Enter','Enter',13,8);
    check(`${size} Shift+Enter summons the door with the caret`, await cdp.evaluate(`${pose}==='conversation'`) && await cdp.evaluate(`document.activeElement===${doorComposer}`));
    await key('Escape','Escape',27);
    check(`${size} Esc returns focus to the document`, await cdp.evaluate("document.activeElement.id==='qa-document-focus'"));
    await cdp.evaluate("window.__qa.setSidecar(true)"); await settle();
    await cdp.evaluate("document.querySelector('[aria-label=\"Anchored reply\"]').focus()");
    await key('Enter','Enter',13,8);
    check(`${size} Shift+Enter in a text field stays that field's newline`, await cdp.evaluate(`${pose}==='notch'`));
    await cdp.evaluate("window.__qa.setSidecar(false)"); await settle();
    // Browser surface: This page / Task list, Plan and Run only.
    await cdp.evaluate("window.__qa.setSurface('Browser')"); await settle();
    await move(20, height/2); await move(pill.x+pill.width/2, pill.y+pill.height/2); await delay(1200); await settle();
    check(`${size} the browser card keeps This page and Task list`, await cdp.evaluate("[...document.querySelectorAll('.rl-monochat-float .rl-context-chips button')].map(b=>b.textContent+':'+b.getAttribute('aria-pressed')).join()==='This page:true,Task list:false'"));
    await click('.rl-monochat-float [aria-label="Destination"]');
    check(`${size} the browser card offers Plan and Run alone`, await cdp.evaluate("[...document.querySelectorAll('[role=menu][aria-label=Destination] [role=menuitemradio]')].map(b=>b.textContent).join('|').match(/Plan a build|Just run it/g)?.length===2 && document.querySelectorAll('[role=menu][aria-label=Destination] [role=menuitemradio]').length===2"));
    await key('Escape','Escape',27);
    await screenshot(`${size}-card-browser`);
    await click('.qa-nav strong');
    // A chat takes the room at the room's size; its heading carries the one New.
    await cdp.evaluate("window.__qa.openChat('qa')"); await delay(500); await settle();
    const chat = await bounds('.rl-monochat');
    check(`${size} a chat opens in the room`, await cdp.evaluate(`${pose}==='conversation'`) && chat.within && !!await cdp.evaluate("document.querySelector('.rl-monochat [data-chat-messages]')?.textContent.includes('How do we preserve')"), chat);
    check(`${size} one composer, at the bottom of the thread`, await cdp.evaluate("document.querySelectorAll('textarea[aria-label=\"Message Redline\"]').length===1"));
    check(`${size} one New, in the room's heading`, await cdp.evaluate("document.querySelectorAll('.rl-monochat-new').length===1"));
    await screenshot(`${size}-chat`);
    check(`${size} the window-drag strip never covers the room's heading`, await cdp.evaluate("(() => { const r=document.querySelector('.rl-monochat-new').getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.rl-monochat-new') != null; })()"));
    await click('.rl-monochat-new'); await settle();
    check(`${size} New returns to a blank composer`, await cdp.evaluate("!document.querySelector('[data-chat-room]') && !!document.querySelector('.rl-frontdoor-focus [data-chat-composer] textarea')"));
    await cdp.evaluate("window.__qa.setSetup(true)");await settle();
    check(`${size} setup remains accessible above the door`,await cdp.evaluate("!!document.querySelector('dialog:modal')"));
    await key('Escape','Escape',27);
    await cdp.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
    await click('[aria-label="Return to workspace"]'); await settle();
    check(`${size} reduced motion disables attraction`,await cdp.evaluate("document.querySelector('.rl-portal-membrane').style.getPropertyValue('--portal-pull')===''"));
  }
} catch(error) {report.errors.push(error.stack??String(error));}
finally {
  report.finishedAt=new Date().toISOString(); report.passed=report.checks.every(check=>check.passed)&&report.errors.length===0;
  await mkdir(output,{recursive:true});await writeFile(path.join(output,"report.json"),JSON.stringify(report,null,2)+"\n");
  cdp?.close();chrome?.kill();await server?.close();await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,errors:report.errors,output},null,2));if(!report.passed)process.exitCode=1;
}
