#!/usr/bin/env node
// Real React components, synthetic service responses, and an isolated Chrome profile.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, process.argv[2] ?? "docs/memory-cosmos-visual-qa-2026-09-24");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-browser-visual-qa-"));
const service = path.join(root, "fixtures/memory-cosmos/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/memory-cosmos", screenshots: [], checks: [], errors: [], sourceSha256: {}, limitations: ["Headless Chrome component fixture; not WKWebView/native hit-testing or live Redline.", "Agent, dictation, audio and Tauri service interfaces are synthetic; no capture, database, user profile or agent launch.", "Real Three.js renderer with a synthetic 150-node memory corpus; timings are Chrome on this Mac, not WKWebView."] };
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
  await mkdir(output,{recursive:true});
  for(const file of ["src/components/MemoryMap.tsx","src/lib/memoryMap3d.ts","src/components/memory-cosmos/scene.ts","src/components/memory-cosmos/planets.ts","src/components/memory-cosmos/filaments.ts"]) report.sourceSha256[file]=createHash("sha256").update(await readFile(path.join(root,file))).digest("hex");
  server=await createServer({configFile:false,root,cacheDir:path.join(temporary,"vite-cache"),optimizeDeps:{entries:["fixtures/memory-cosmos/index.html"]},plugins:[react()],resolve:{alias:[{find:"@tauri-apps/api/core",replacement:service},{find:"@tauri-apps/api/event",replacement:service}]},server:{host:"127.0.0.1",port:0,watch:{ignored:["**/src-tauri/**","**/docs/**"]}}});
  await server.listen(); const port=server.httpServer.address().port;
  report.fixtureUrl=`http://127.0.0.1:${port}/fixtures/memory-cosmos/`;
  chrome=spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",["--headless=new",`--user-data-dir=${path.join(temporary,"chrome-profile")}`,"--remote-debugging-port=0","--remote-debugging-address=127.0.0.1","--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-sync","--disable-extensions","about:blank"],{stdio:["ignore","ignore","pipe"]});
  let chromeLog="";chrome.stderr.on("data",data=>{chromeLog+=data;});
  let debugPort;for(let i=0;i<150;i++){try{debugPort=(await readFile(path.join(temporary,"chrome-profile/DevToolsActivePort"),"utf8")).split("\n")[0];break;}catch{}await delay(100);}
  if(!debugPort)throw new Error(`Chrome did not start: ${chromeLog}`);
  const targets=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();cdp=new CDP(targets.find(t=>t.type==="page").webSocketDebuggerUrl);
  await cdp.call("Page.enable");await cdp.call("Runtime.enable");await cdp.call("Log.enable");report.browserVersion=await cdp.call("Browser.getVersion");
  await cdp.call("Emulation.setDeviceMetricsOverride",{width:1440,height:940,deviceScaleFactor:1,mobile:false});
  await cdp.call("Page.navigate",{url:report.fixtureUrl});
  for(let i=0;i<200 && !(await cdp.evaluate("!!document.querySelector('.mc-canvas')"));i++)await delay(100);
  check("150-node scene renders",await cdp.evaluate("!!document.querySelector('.mc-canvas') && document.querySelector('.mc-count')?.textContent.includes('150 shown')"));
  await delay(1000);await screenshot("overview-150");
  const original=await cdp.evaluate("JSON.stringify(window.__cosmos.view.current.camera)");
  const area=await bounds(".mc-canvas");const start={x:area.x+area.width*.5,y:area.y+area.height*.5};
  await cdp.call("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...start});
  for(let i=1;i<=12;i++)await cdp.call("Input.dispatchMouseEvent",{type:"mouseMoved",button:"left",buttons:1,x:start.x+i*12,y:start.y+i*4});
  await cdp.call("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,x:start.x+144,y:start.y+48});await delay(750);
  check("drag rotates camera without selecting",await cdp.evaluate(`JSON.stringify(window.__cosmos.view.current.camera)!==${JSON.stringify(original)} && !window.__cosmos.view.current.selectedId`));await screenshot("orbit-behind-clusters");
  await cdp.evaluate("document.querySelector('.mc-list').open=true; const select=document.querySelector('#cosmos-memory');select.value='memory-0';select.dispatchEvent(new Event('change',{bubbles:true}))");await settle();
  check("keyboard selection stays in cosmos",await cdp.evaluate("!!document.querySelector('.mc-canvas') && document.querySelector('.mc-inspector h3').textContent==='Research & evidence'"));
  await cdp.evaluate("[...document.querySelectorAll('.mc-controls button')].find(b=>b.textContent==='Approach').click()");await delay(1000);await screenshot("close-range-planet");
  const beforeTimeline=await cdp.evaluate("JSON.stringify(window.__cosmos.view.current.camera)");
  await cdp.evaluate("document.querySelector('.mc-inspector button').click()");await settle();
  check("Timeline receives exact class focus and releases context",await cdp.evaluate("window.__cosmos.getFocus().classNodeId==='class-0' && window.__cosmos.graphicsAllocation().cosmos===0"));
  await click("#map-tab");await delay(750);
  const restored=await cdp.evaluate("window.__cosmos.view.current.camera");
  const saved=JSON.parse(beforeTimeline), cameraError=Math.max(...[...restored.position,...restored.target].map((v,i)=>Math.abs(v-[...saved.position,...saved.target][i])));
  check("return restores camera and selection",cameraError<.001 && await cdp.evaluate("document.querySelector('#cosmos-memory').value==='memory-0' && window.__cosmos.graphicsAllocation().cosmos===1"),{cameraError});
  const positions=await cdp.evaluate("JSON.stringify(window.__cosmos.view.current.positions.map(n=>[n.id,n.x,n.y,n.z]))");
  await cdp.evaluate("document.querySelector('.mc-toolbar button').click()");await settle();
  check("edge filter preserves spatial landmarks",await cdp.evaluate(`JSON.stringify(window.__cosmos.view.current.positions.map(n=>[n.id,n.x,n.y,n.z]))===${JSON.stringify(positions)}`));
  await cdp.evaluate("[...document.querySelectorAll('.mc-controls button')].find(b=>b.textContent==='Fly').click()");await settle();
  const preFlight=await cdp.evaluate("JSON.stringify(window.__cosmos.view.current.camera.position)");
  await cdp.call("Input.dispatchKeyEvent",{type:"keyDown",key:"w",code:"KeyW",windowsVirtualKeyCode:87});await delay(500);await cdp.call("Input.dispatchKeyEvent",{type:"keyUp",key:"w",code:"KeyW",windowsVirtualKeyCode:87});
  check("flight moves along view",await cdp.evaluate(`JSON.stringify(window.__cosmos.view.current.camera.position)!==${JSON.stringify(preFlight)}`));
  await key("Escape","Escape",27);
  check("Escape returns to orbit",await cdp.evaluate("[...document.querySelectorAll('.mc-controls button')].find(b=>b.textContent==='Orbit').getAttribute('aria-pressed')==='true'"));
  await cdp.evaluate("[...document.querySelectorAll('.mc-controls button')].find(b=>b.textContent==='Home').click()");await delay(800);
  await cdp.call("Emulation.setDeviceMetricsOverride",{width:900,height:680,deviceScaleFactor:1,mobile:false});await delay(300);await screenshot("compact-900");
  check("resize preserves positions and stays in viewport",await cdp.evaluate(`JSON.stringify(window.__cosmos.view.current.positions.map(n=>[n.id,n.x,n.y,n.z]))===${JSON.stringify(positions)} && document.documentElement.scrollWidth<=innerWidth`));
  await cdp.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});await settle();
  check("reduced motion freezes ambient effects",await cdp.evaluate("!!document.querySelector('.mc-still') && [...document.querySelectorAll('.mc-toolbar button')].some(b=>b.disabled && b.textContent==='Motion off')"));
  await cdp.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
  await delay(4500);report.performance=await cdp.evaluate("JSON.parse(document.querySelector('.mc-render').dataset.frameStats || 'null')");
  await cdp.evaluate("window.__cosmos.setCount(190)");await delay(1100);check("over-limit data shows explicit hidden count",await cdp.evaluate("document.querySelector('.mc-count').textContent.includes('150 shown · 40 hidden')"));
  await cdp.evaluate("window.__cosmos.setCount(1)");await delay(1100);await screenshot("single-memory");check("single node renders",await cdp.evaluate("document.querySelector('.mc-count').textContent.includes('1 shown') && !!document.querySelector('.mc-canvas')"));
  await cdp.evaluate("window.__cosmos.setCount(0)");await delay(1100);check("empty corpus releases graphics",await cdp.evaluate("document.body.textContent.includes('No memories to map yet') && window.__cosmos.graphicsAllocation().cosmos===0"));
  await cdp.evaluate("window.__cosmos.setCount(150)");await delay(1100);
  await cdp.evaluate("document.querySelector('.mc-canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()");await delay(200);
  check("context loss exposes usable list and releases lease",await cdp.evaluate("document.body.textContent.includes('graphics context was lost') && document.querySelector('.mc-list').open && window.__cosmos.graphicsAllocation().cosmos===0"));await screenshot("context-loss-fallback");
  await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Retry 3D').click()");await delay(600);check("retry allocates exactly one replacement context",await cdp.evaluate("!!document.querySelector('.mc-canvas') && window.__cosmos.graphicsAllocation().cosmos===1"));
  for(let i=0;i<5;i++){await click("#timeline-tab");await click("#map-tab");await delay(200);}
  check("repeated Map–Timeline switches retain one context",await cdp.evaluate("window.__cosmos.graphicsAllocation().cosmos===1"));
  await writeFile(path.join(output,"chrome.stderr.log"),chromeLog);
} catch(error){report.errors.push(String(error?.stack??error));}
finally {
  report.finishedAt=new Date().toISOString();report.passed=!report.errors.length&&report.checks.every(c=>c.passed);
  await mkdir(output,{recursive:true});await writeFile(path.join(output,"results.json"),JSON.stringify(report,null,2)+"\n");
  cdp?.close();if(chrome){chrome.kill("SIGTERM");await Promise.race([new Promise(resolve=>chrome.once("exit",resolve)),delay(3000)]);if(chrome.exitCode===null)chrome.kill("SIGKILL");}
  await server?.close();await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,failed:report.checks.filter(c=>!c.passed),errors:report.errors,performance:report.performance,output},null,2));if(!report.passed)process.exitCode=1;
