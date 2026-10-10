#!/usr/bin/env node
// Renderer memory soak (docs/perf-budget.md rule 7). Real surfaces, hooks and
// collab transport in headless Chrome, behind a synthetic Tauri boundary
// (fixtures/memory-soak). Each scenario repeats what a long session does —
// open a chat, stream replies, close it; join and leave a live room; wander a
// terminal through directories — forcing a garbage collection between steps,
// so what the heap still holds afterwards is what the page kept, not garbage.
//
// Usage: node scripts/memory-soak.mjs [output.json] [--cycles N]
// Prints a summary table; the full series goes to the JSON file
// (default build-analysis/memory-soak/report.json).
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn, execSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args.splice(i, 2)[1]);
};
const CYCLES = flag("--cycles", 12);
const output = path.resolve(root, args[0] ?? "build-analysis/memory-soak/report.json");
const temporary = await mkdtemp(path.join(tmpdir(), "redline-memory-soak-"));
const service = path.join(root, "fixtures/memory-soak/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MB = 1024 * 1024;

const report = {
  startedAt: new Date().toISOString(),
  commit: execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(),
  dirty: execSync("git status --porcelain -- src", { cwd: root }).toString().trim() !== "",
  fixture: "fixtures/memory-soak",
  limitations: [
    "Headless Chrome (V8), not WKWebView (JavaScriptCore): absolute sizes differ, growth per step is the signal.",
    "React's development build, as `tauri dev` runs it.",
    "The Tauri boundary is synthetic: no database, agent, PTY or network.",
  ],
  errors: [],
  scenarios: {},
};

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timeout);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        report.errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      }
    });
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 180_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  close() {
    this.ws.close();
  }
}

let server, chrome, cdp;

/** Live `Y.Doc` instances: everything still reachable after a collection. */
async function liveDocs() {
  const proto = await cdp.call("Runtime.evaluate", { expression: "window.__soakYDoc", objectGroup: "soak" });
  const { objects } = await cdp.call("Runtime.queryObjects", { prototypeObjectId: proto.result.objectId, objectGroup: "soak" });
  const { result } = await cdp.call("Runtime.callFunctionOn", {
    objectId: objects.objectId,
    functionDeclaration: "function () { return this.length; }",
    returnByValue: true,
  });
  await cdp.call("Runtime.releaseObjectGroup", { objectGroup: "soak" });
  return result.value;
}

async function measure(label) {
  // Twice: a first pass can leave finalizer-reachable garbage for the second.
  await cdp.call("HeapProfiler.collectGarbage");
  await delay(50);
  await cdp.call("HeapProfiler.collectGarbage");
  const heap = await cdp.call("Runtime.getHeapUsage");
  const dom = await cdp.call("Memory.getDOMCounters");
  return {
    label,
    heapMB: +(heap.usedSize / MB).toFixed(2),
    domNodes: dom.nodes,
    domListeners: dom.jsEventListeners,
    busListeners: await cdp.evaluate("window.__soak.listenerCount()"),
    leftoverDiagramNodes: await cdp.evaluate("window.__soak.leftoverDiagramNodes()"),
    liveYDocs: await liveDocs(),
  };
}

const grew = (from, to) => +(to.heapMB - from.heapMB).toFixed(2);

try {
  await mkdir(path.dirname(output), { recursive: true });
  server = await createServer({
    configFile: false,
    root,
    cacheDir: path.join(temporary, "vite-cache"),
    optimizeDeps: { entries: ["fixtures/memory-soak/index.html"], include: ["mermaid", "yjs", "y-webrtc", "highlight.js/lib/core", "lowlight", "markdown-it"] },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: ["@tauri-apps/api/core", "@tauri-apps/api/event"].map((find) => ({ find, replacement: service })),
    },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null },
    clearScreen: false,
  });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/fixtures/memory-soak/`;
  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", `--user-data-dir=${path.join(temporary, "chrome-profile")}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-extensions", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let chromeLog = "";
  chrome.stderr.on("data", (data) => { chromeLog += data; });
  let port;
  for (let i = 0; i < 150 && !port; i++) {
    try {
      port = (await readFile(path.join(temporary, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0];
    } catch {
      await delay(100);
    }
  }
  if (!port) throw new Error(`Chrome failed to start: ${chromeLog.slice(-3000)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new CDP(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("HeapProfiler.enable");
  report.browserVersion = (await cdp.call("Browser.getVersion")).product;
  await cdp.call("Page.navigate", { url });
  for (let i = 0; i < 300 && !(await cdp.evaluate("document.documentElement.dataset.soakReady === 'true'").catch(() => false)); i++) await delay(100);

  // A. Open a chat, stream eight replies into it, close it — again and again.
  // Warm-up first: the first cycle loads mermaid and fills the JIT's caches.
  await cdp.evaluate(`window.__soak.chatCycle("warm", { history: 40, turns: 8, deltas: 16 })`);
  const chat = [await measure("after warm-up")];
  for (let c = 1; c <= CYCLES; c++) {
    const { rows } = await cdp.evaluate(`window.__soak.chatCycle("c${c}", { history: 40, turns: 8, deltas: 16 })`);
    chat.push({ ...(await measure(`cycle ${c}`)), rowsShown: rows });
  }
  report.scenarios.chatCycles = {
    what: `${CYCLES} cycles of: mount a chat with 40 history rows, stream 8 replies (16 deltas each, every 4th with a broken mermaid fence), unmount`,
    heapGrowthMBPerCycle: +(grew(chat[0], chat.at(-1)) / CYCLES).toFixed(3),
    leftoverDiagramNodes: chat.at(-1).leftoverDiagramNodes,
    busListenersAfter: chat.at(-1).busListeners,
    series: chat,
  };

  // B. One very long thread, open.
  const longBefore = await measure("before");
  const { rows: longRows } = await cdp.evaluate("window.__soak.openLongThread(2400)");
  const longOpen = await measure("2400-row thread open");
  await cdp.evaluate("window.__soak.closeLongThread()");
  const longAfter = await measure("closed");
  report.scenarios.longThread = {
    what: "mount a chat whose persisted thread is 2400 rows, then unmount it",
    rowsInMemoryAndShown: longRows,
    heapWhileOpenMB: grew(longBefore, longOpen),
    heapAfterCloseMB: grew(longBefore, longAfter),
    series: [longBefore, longOpen, longAfter],
  };

  // C. Join and leave a live room, as a revision rollover or a re-invite does.
  const collabBefore = await measure("before");
  await cdp.evaluate("window.__soak.collabCycles(20)");
  const collabAfter = await measure("after 20 rooms");
  report.scenarios.collabRooms = {
    what: "20 cycles of: a Y.Doc with ~66 KB of plan text, createCollabProvider (unreachable relay), awareness set, handle.destroy(), doc dropped",
    liveYDocsAfter: collabAfter.liveYDocs,
    heapGrowthMB: grew(collabBefore, collabAfter),
    series: [collabBefore, collabAfter],
  };

  // D. One terminal wandering through 300 directories of 3 repos.
  const iconsBefore = await measure("before");
  const { cachedDirectories } = await cdp.evaluate("window.__soak.repoIconWalk(300, 3)");
  const iconsAfter = await measure("after 300 directories");
  report.scenarios.repoIcons = {
    what: "cd through 300 directories across 3 repos, each repo_icon answer a fresh 256 KB data URL",
    cachedDirectories,
    heapGrowthMB: grew(iconsBefore, iconsAfter),
    series: [iconsBefore, iconsAfter],
  };

  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  const s = report.scenarios;
  console.log(`memory soak @ ${report.commit}${report.dirty ? "+dirty" : ""} — ${report.browserVersion}`);
  console.log(`  chat cycles       ${s.chatCycles.heapGrowthMBPerCycle} MB/cycle retained, ${s.chatCycles.leftoverDiagramNodes} diagram temp nodes left, ${s.chatCycles.busListenersAfter} listeners left`);
  console.log(`  long thread       ${s.longThread.rowsInMemoryAndShown} rows shown, +${s.longThread.heapWhileOpenMB} MB open, +${s.longThread.heapAfterCloseMB} MB after close`);
  console.log(`  collab rooms      ${s.collabRooms.liveYDocsAfter} Y.Docs still alive of 20, +${s.collabRooms.heapGrowthMB} MB`);
  console.log(`  repo icons        ${s.repoIcons.cachedDirectories} directories cached, +${s.repoIcons.heapGrowthMB} MB`);
  if (report.errors.length) console.log(`  page errors: ${report.errors.length} (see ${path.relative(root, output)})`);
  console.log(`report: ${path.relative(root, output)}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  cdp?.close();
  chrome?.kill();
  await server?.close();
  await rm(temporary, { recursive: true, force: true }).catch(() => {});
}
