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
const output = path.resolve(root, process.argv[2] ?? "docs/frontdoor-qa-2026-09-29");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-browser-visual-qa-"));
const service = path.join(root, "fixtures/monochat-aurora-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/monochat-aurora-qa", screenshots: [], checks: [], errors: [], sourceSha256: {}, limitations: ["Headless Chrome component fixture; not WKWebView/native hit-testing or live Redline.", "Agent, dictation, audio and Tauri service interfaces are synthetic; no capture, database, user profile or agent launch.", "Document and anchored-discussion contents are illustrative. Production chat, island, setup, harness menu, and theme components are imported intact."] };
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
  for (const file of ["src/hooks/useFrontDoorConversation.ts", "src/components/MonochatIsland.tsx", "src/components/MonochatIsland.css", "src/components/ChatRoom.tsx", "src/components/MonochatTrace.tsx", "src/components/FrontDoor.tsx", "src/components/ComposerMenu.tsx", "src/components/ComposerMenu.css", "src/App.tsx", "src/components/IntegrationSetupDialog.tsx", "src/styles.css"]) report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root,file))).digest("hex");
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
  for(const [width,height] of [[1440,960],[900,640],[480,720]]) {
    const size=`${width}x${height}`;
    await cdp.call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
    await cdp.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
    await cdp.call("Page.navigate",{url:report.fixtureUrl});
    let ready=false;for(let i=0;i<150;i++){if(await cdp.evaluate("document.documentElement.dataset.qaReady==='true'")){ready=true;break;}await delay(100);}
    if(!ready)throw new Error(`Fixture did not render: ${report.errors.join("\n")}`);
    await settle(); await screenshot(`${size}-home-entry`);
    check(`${size} fresh entry never selects saved history`,await cdp.evaluate("!document.querySelector('[data-chat-room]')&&!!document.querySelector('[aria-label=\"Conversation history\"]')"));
    check(`${size} home is title-free`,await cdp.evaluate("!document.querySelector('.rl-monochat-rest h1, .rl-monochat h1, .rl-monochat header')"));
    check(`${size} home composer bounded`,(await bounds('[data-chat-composer]'))?.within);
    const focusPoint = await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-chat-composer] textarea');
      const composer = document.querySelector('[data-chat-composer]');
      const before = composer.getBoundingClientRect();
      const samples = [];
      window.__qaFocusMotion = new Promise(resolve => {
      function sample() {
        const rect = composer.getBoundingClientRect();
        samples.push({ shift: Math.max(Math.abs(rect.x-before.x), Math.abs(rect.y-before.y), Math.abs(rect.width-before.width), Math.abs(rect.height-before.height)), opacity: Number(getComputedStyle(document.querySelector('.rl-frontdoor-focus'), '::before').opacity) });
        if (samples.length < 24) requestAnimationFrame(sample);
        else resolve({ samples, focused: document.activeElement === input, transforms: document.querySelector('.rl-monochat').getAnimations().length });
      }
      requestAnimationFrame(sample);
      });
      const r = input.getBoundingClientRect();
      return { x:r.x+r.width/2, y:r.y+r.height/2 };
    })()`);
    await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...focusPoint});
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...focusPoint});
    const focusMotion = await cdp.evaluate('window.__qaFocusMotion');
    check(`${size} home focus keeps composer and caret in place throughout transition`,focusMotion.focused&&focusMotion.transforms===0&&focusMotion.samples.every(sample=>sample.shift<1),focusMotion);
    check(`${size} focus backdrop fades to opaque`,focusMotion.samples[0].opacity<1&&focusMotion.samples.at(-1).opacity===1);
    await cdp.call("Input.insertText",{text:"Keep this thought as I move between surfaces.\n".repeat(8)});await settle();
    check(`${size} typing opens focused front door`,await cdp.evaluate("!!document.querySelector('.rl-frontdoor-focus[role=dialog][data-open=true]')"));
    await screenshot(`${size}-writing`);
    check(`${size} growing composer bounded`,(await bounds('[data-chat-composer]'))?.within);
    await cdp.evaluate("window.__qaDraft=document.querySelector('[data-chat-composer] textarea');window.__qaText=window.__qaDraft.value;window.__qa.setSurface('Document')");await settle();
    await cdp.evaluate("document.querySelector('#qa-document-focus').focus()");await settle();
    const notch=await bounds('.rl-monochat-notch'), footer=await bounds('.rl-app-footer'), plate=await bounds('.qa-document');
    check(`${size} accessible capsule centered in existing footer row`,Math.abs(notch.x+notch.width/2-width/2)<1&&Math.abs(notch.y+notch.height/2-footer.y-footer.height/2)<1&&notch.width===160&&notch.height===40);
    check(`${size} entrance bounded and clear of footer controls`,notch.within&&notch.x>=(await bounds('.rl-footer-status')).right&&notch.right<=(await bounds('.rl-footer-actions')).x);
    check(`${size} entrance avoids terminal caret`,notch.y>(await bounds('[aria-label="Show terminal"]')).bottom);
    check(`${size} entrance consumes no layout space`,await cdp.evaluate("getComputedStyle(document.querySelector('.rl-frontdoor-dock')).position==='fixed'&&Math.abs(document.querySelector('.rl-app-footer').getBoundingClientRect().bottom-innerHeight)<1"));
    await screenshot(`${size}-resting`);
    await key('Enter', 'Enter', 13, 8);
    check(`${size} Shift+Enter opens and focuses without editing the draft`, await cdp.evaluate("document.querySelector('.rl-monochat').dataset.pose==='conversation'&&document.activeElement===window.__qaDraft&&window.__qaDraft.value===window.__qaText"));
    for (const edge of ["top", "left", "right", "bottom"]) await click(`[data-window-drag-edge="${edge}"]`);
    check(`${size} all four invisible edges request a window drag without dismissing`, await cdp.evaluate("window.__qaWindowDrags===4&&document.querySelector('.rl-monochat').dataset.pose==='conversation'"));
    check(`${size} drag edges have no painted decoration`, await cdp.evaluate("Array.from(document.querySelectorAll('[data-window-drag-edge]')).every(e=>{const s=getComputedStyle(e);return s.backgroundColor==='rgba(0, 0, 0, 0)'&&s.borderTopWidth==='0px'&&s.boxShadow==='none';})"));
    await key('Escape', 'Escape', 27);
    check(`${size} shortcut-opened front door returns focus to the workspace`, await cdp.evaluate("document.querySelector('.rl-monochat').dataset.pose==='notch'&&document.activeElement.id==='qa-document-focus'"));
    await cdp.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});await settle();
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:width/2+40,y:notch.y+20});await delay(250);
    check(`${size} proximity lifts membrane without opening chat`,await cdp.evaluate("document.querySelector('.rl-monochat').dataset.pose==='notch'&&parseFloat(document.querySelector('.rl-portal-membrane').style.getPropertyValue('--portal-pull'))>.1&&document.activeElement.id==='qa-document-focus'"),await cdp.evaluate("({pull:document.querySelector('.rl-portal-membrane').style.getPropertyValue('--portal-pull'),pose:document.querySelector('.rl-monochat').dataset.pose,focus:document.activeElement.outerHTML.slice(0,160)})"));
    check(`${size} stable click target during attraction`,JSON.stringify(await bounds('.rl-monochat-notch'))===JSON.stringify(notch));
    await screenshot(`${size}-approach`);
    await click('.rl-monochat-notch');await delay(400);
    check(`${size} dialog covers whole viewport`,await cdp.evaluate("(() => {const r=document.querySelector('[role=dialog]').getBoundingClientRect();return r.x===0&&r.y===0&&r.width===innerWidth&&r.height===innerHeight;})()"));
    check(`${size} focused background is opaque`,await cdp.evaluate("getComputedStyle(document.querySelector('.rl-frontdoor-focus'),'::before').opacity==='1'&&getComputedStyle(document.querySelector('.rl-frontdoor-focus'),'::before').backgroundColor!=='rgba(0, 0, 0, 0)'"));
    check(`${size} background inert`,await cdp.evaluate("document.querySelector('.qa-document').inert&&document.querySelector('.qa-nav').inert"));
    check(`${size} preserves draft and node identity`,await cdp.evaluate("window.__qaDraft===document.querySelector('[data-chat-composer] textarea')&&window.__qaDraft.value===window.__qaText"));
    check(`${size} footer and document dimensions unchanged`,JSON.stringify(await bounds('.rl-app-footer'))===JSON.stringify(footer)&&JSON.stringify(await bounds('.qa-document'))===JSON.stringify(plate));
    await screenshot(`${size}-conversation`);
    check(`${size} one front door composer`, await cdp.evaluate("document.querySelectorAll('textarea[aria-label=\"Message Redline\"]').length === 1"));
    for (const label of ['Harness','Choose project','Destination']) {
      await click(label==='Harness'?'.rl-monochat [aria-haspopup="menu"]':`[aria-label="${label}"]`);
      check(`${size} ${label} menu bounded`,(await bounds(`[role="menu"][aria-label="${label}"]`))?.within);
      await screenshot(`${size}-${label.replaceAll(' ','-').toLowerCase()}`);
      if (label === 'Harness') {
        await click('[role="group"][aria-label="Model"] button:last-child');
        const effortPanel = await bounds('.rl-effort-strip');
        const modelsPanel = await bounds('[role="group"][aria-label="Model"]');
        check(`${size} model opens a compact effort strip without widening the menu`,effortPanel.within&&effortPanel.width===184&&effortPanel.height<140&&(width<600||effortPanel.x>=modelsPanel.right||effortPanel.right<=modelsPanel.x)&&(await bounds('[role="menu"][aria-label="Harness"]')).width===328);
        const high = await bounds('.rl-effort-notches [aria-label="High"]');
        await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:high.x+high.width/2,y:high.y+high.height/2});await settle();
        check(`${size} hovering effort previews cumulative notches without committing`,await cdp.evaluate("document.querySelectorAll('.rl-effort-notches [data-lit=true]').length===3&&document.querySelector('.rl-effort-default').getAttribute('aria-checked')==='true'&&document.querySelector('.rl-effort-value').textContent==='High'"));
        await screenshot(`${size}-effort-preview`);
        await click('.rl-effort-notches [aria-label="High"]');
        check(`${size} clicking a notch selects the model effort`,await cdp.evaluate("document.querySelector('.rl-effort-notches [aria-label=High]').getAttribute('aria-checked')==='true'&&Array.from(document.querySelectorAll('.rl-monochat .rl-composer-chip')).some(button=>button.title.includes('Codex model · high'))"));
        await key('ArrowRight','ArrowRight',39);
        check(`${size} arrow keys preview without changing selected effort`,await cdp.evaluate("document.activeElement.getAttribute('aria-label')==='Extra high'&&document.querySelector('.rl-effort-notches [aria-label=High]').getAttribute('aria-checked')==='true'"));
        await key('Enter','Enter',13);
        check(`${size} keyboard confirms effort selection`,await cdp.evaluate("document.querySelector('.rl-effort-notches [aria-label=\"Extra high\"]').getAttribute('aria-checked')==='true'"));
        await screenshot(`${size}-effort-selected`);
        await key('Escape','Escape',27);
        await click('.rl-monochat [aria-haspopup="menu"]');
        check(`${size} reopening picker does not show effort for the saved model`,await cdp.evaluate("!document.querySelector('.rl-effort-strip')"));
        const modelRow=await bounds('[data-effort-model="qa-model"]');
        await cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:modelRow.x+modelRow.width/2,y:modelRow.y+modelRow.height/2});await settle();
        check(`${size} hovering selected model reveals its effort strip`,await cdp.evaluate("!!document.querySelector('.rl-effort-strip')&&document.querySelector('.rl-effort-notches [aria-label=\"Extra high\"]').getAttribute('aria-checked')==='true'"));
      }
      await key('Escape','Escape',27);
      check(`${size} menu Escape keeps front door open`,await cdp.evaluate("document.querySelector('.rl-monochat').dataset.pose==='conversation'"));
    }
    await cdp.evaluate("window.__qa.setSetup(true)");await settle();
    check(`${size} setup remains accessible above front door`,await cdp.evaluate("!!document.querySelector('dialog:modal')"));
    await key('Escape','Escape',27);
    check(`${size} setup Escape keeps front door open`,await cdp.evaluate("!document.querySelector('dialog')&&document.querySelector('.rl-monochat').dataset.pose==='conversation'"));
    await key('Escape','Escape',27);
    check(`${size} one Escape closes and returns document focus`,await cdp.evaluate("document.querySelector('.rl-monochat').dataset.pose==='notch'&&document.activeElement.id==='qa-document-focus'&&!document.querySelector('.qa-document').inert"));
    await click('#qa-document-focus');
    check(`${size} discussion stays on source surface`,await cdp.evaluate("!!document.querySelector('.qa-discussion textarea')&&document.querySelector('.rl-monochat').dataset.pose==='notch'"));
    await screenshot(`${size}-sidecar`);
    await cdp.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
    await settle();
    check(`${size} reduced motion disables attraction`,await cdp.evaluate("document.querySelector('.rl-portal-membrane').style.getPropertyValue('--portal-pull')===''"));
    await cdp.call("Page.navigate",{url:report.fixtureUrl+'?empty'});
    for(let i=0;i<150;i++){if(await cdp.evaluate("document.documentElement.dataset.qaReady==='true'"))break;await delay(100);}
    await settle();
    await click('[data-chat-composer] textarea');
    check(`${size} empty front door has no title or suggestions`,await cdp.evaluate("!document.querySelector('.rl-frontdoor-focus h1, .rl-frontdoor-focus h2')&&!document.querySelector('[data-chat-room]')"));
    const emptyComposer=await bounds('[data-chat-composer]');
    check(`${size} empty input centered vertically`,Math.abs(emptyComposer.y+emptyComposer.height/2-height/2)<40);
    check(`${size} return affordance uses bottom pill without an X`,await cdp.evaluate("!document.querySelector('.rl-frontdoor-close')&&!!document.querySelector('.rl-frontdoor-return[aria-label=\"Return to workspace\"]')"));
    await screenshot(`${size}-empty-frontdoor`);
    await click('[aria-label="Conversation history"]');
    await click('[role="menuitem"]');
    check(`${size} explicit history selection opens the chosen exchange`,await cdp.evaluate("!!document.querySelector('[data-chat-room]')&&document.querySelector('[data-chat-messages]').textContent.includes('How do we preserve the discussion')"));
    await screenshot(`${size}-explicit-history`);
    check(`${size} saved chat keeps History explicit and hides the usage icon`,await cdp.evaluate("!!document.querySelector('[data-chat-composer] [aria-label=\"Conversation history\"]')&&!document.querySelector('.rl-monochat-trace-toggle')"));
    await click('[aria-label="Conversation actions"]');
    const usagePoint=await cdp.evaluate(`(() => {const e=Array.from(document.querySelectorAll('[role="menuitem"]')).find(button=>button.textContent.includes('Activity & usage'));const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...usagePoint});
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...usagePoint});await settle();
    check(`${size} More opens clearly labeled usage for the current conversation`,await cdp.evaluate("!!document.querySelector('[role=dialog][aria-label=\"Activity and usage\"]')&&document.querySelector('.rl-monochat-trace-summary').textContent.includes('in this conversation')&&document.activeElement.getAttribute('aria-label')==='Close activity'"));
    await screenshot(`${size}-activity-usage`);
    await key('Escape','Escape',27);
    check(`${size} Escape closes usage without closing the conversation`,await cdp.evaluate("!document.querySelector('.rl-monochat-traces')&&document.querySelector('.rl-frontdoor-focus').dataset.open==='true'&&!!document.querySelector('[data-chat-room]')"));
    await cdp.evaluate("document.querySelector('[data-chat-composer] textarea').focus()");
    await key('Escape','Escape',27);
    check(`${size} Escape closes a saved chat through its portal without clearing history`,await cdp.evaluate("document.querySelector('.rl-frontdoor-focus').dataset.open==='false'&&!!document.querySelector('[data-chat-room]')"));
    await key('Enter','Enter',13,8);
    check(`${size} Shift+Enter reopens the saved chat and focuses its composer`,await cdp.evaluate("document.querySelector('.rl-frontdoor-focus').dataset.open==='true'&&document.activeElement===document.querySelector('[data-chat-composer] textarea')&&!!document.querySelector('[data-chat-room]')"));
    const newChatBounds = await cdp.evaluate(`(() => { const button = Array.from(document.querySelectorAll('[data-chat-composer] button')).find(button => button.textContent === 'New chat'); const r = button?.getBoundingClientRect(); return r && { x:r.x+r.width/2, y:r.y+r.height/2, within:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight }; })()`);
    check(`${size} saved chat exposes New chat without opening a menu`,newChatBounds?.within);
    await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:newChatBounds.x,y:newChatBounds.y});
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:newChatBounds.x,y:newChatBounds.y});await settle();
    check(`${size} New chat returns to composer and preserves history`,await cdp.evaluate("!document.querySelector('[data-chat-room]')&&!!document.querySelector('[aria-label=\"Conversation history\"]')&&document.activeElement===document.querySelector('[data-chat-composer] textarea')"));
    const shortComposer=await bounds('[data-chat-composer]');
    await cdp.call('Input.insertText',{text:'A thought that needs room to unfold.\n'.repeat(12)});await settle();
    check(`${size} context box grows with multiline input`,(await bounds('[data-chat-composer]')).height>shortComposer.height+100);
    await cdp.call('Input.insertText',{text:'Continue this detailed thought.\n'.repeat(150)});await settle();
    check(`${size} long input scrolls at viewport cap and keeps controls visible`,(await bounds('[data-chat-composer]')).within&&await cdp.evaluate("(() => {const t=document.querySelector('[data-chat-composer] textarea');const r=t.getBoundingClientRect();return r.height<=innerHeight*.5+1&&t.scrollHeight>t.clientHeight&&getComputedStyle(t).overflowY==='auto';})()"));
    await screenshot(`${size}-expanded-input`);
    const draftText=await cdp.evaluate("document.querySelector('[data-chat-composer] textarea').value");
    // Bare space just outside the visible box, but inside the invisible room.
    const contextBox=await bounds('[data-chat-composer]');
    const outside={x:width/2,y:contextBox.y-12};
    await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...outside});
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...outside});await settle();
    check(`${size} clicking outside context exits focus and preserves input`,await cdp.evaluate("document.querySelector('.rl-frontdoor-focus').dataset.open==='false'")&&await cdp.evaluate("document.querySelector('[data-chat-composer] textarea').value")===draftText);
    await click('[data-chat-composer] textarea');
    await click('[aria-label="Return to workspace"]');
    check(`${size} bottom pill tucks away front door`,await cdp.evaluate("document.querySelector('.rl-frontdoor-focus').dataset.open==='false'"));



  }
} catch(error) {report.errors.push(error.stack??String(error));}
finally {
  report.finishedAt=new Date().toISOString(); report.passed=report.checks.every(check=>check.passed)&&report.errors.length===0;
  await mkdir(output,{recursive:true});await writeFile(path.join(output,"report.json"),JSON.stringify(report,null,2)+"\n");
  cdp?.close();chrome?.kill();await server?.close();await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,errors:report.errors,output},null,2));if(!report.passed)process.exitCode=1;
}
