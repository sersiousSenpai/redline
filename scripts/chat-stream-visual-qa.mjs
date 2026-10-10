#!/usr/bin/env node
// Streaming QA: real chat components, a synthetic turn store, an isolated Chrome profile.
//
//   node scripts/chat-stream-visual-qa.mjs [outputDir] [scene,scene,...]
//
// Drives every chat surface (fixtures/chat-stream-qa) through one turn —
// idle → sent → tools → mid-stream → full stream → queued type-ahead →
// settled, then a heading-first reply whose first tool fires after its text
// began, and a reader parked mid-reply — and checks the rule in
// docs/perf-budget.md: a reply settles without moving, and the thread's
// viewport holds still through the turn.
//
// Measured by text position, not by the Layout Instability API: a settle
// REPLACES the streamed nodes with the settled row's, and layout-shift entries
// only count nodes that moved, so CLS reads ~0 through a 66 px jump.
//
// Contract the checks read: each scene's root carries `data-qa-scene`; a
// reply's root carries `data-reply` in both phases and its fixed-height tail
// row `data-reply-tail`. A chrome box is identified by its tag, class and
// data-attribute names, so a control that morphs in place (Send → Stop) keeps
// its class and states its phase in attribute values.
//
// A check listed in EXPECTED_FAIL is a known violation with its reason: it
// may fail without failing the run, and the run FAILS when it passes, so the
// change that fixes it also deletes its entry.
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
const output = path.resolve(root, process.argv[2] ?? "build-analysis/chat-stream-visual-qa");
const SCENES = ["card", "room", "browser", "browser-zoom", "mission", "memory", "review", "comment", "comment-chat", "drafter"];
const scenes = process.argv[3]?.split(",") ?? SCENES;
/** Surfaces where Enter during a reply queues the message. */
const QUEUEING = new Set(["card", "room", "browser", "browser-zoom", "mission", "memory"]);
/** Known violations, by check id: `{ scenes: [...], reason }`. Empty since
 *  the reply anatomy (ReplyBlock) landed; a regression found later goes here
 *  with its reason only while its fix is in flight. */
const EXPECTED_FAIL = {};
const temporary = await mkdtemp(path.join(tmpdir(), "redline-chat-stream-qa-"));
const service = path.join(root, "fixtures/chat-stream-qa/services.ts");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), fixture: "fixtures/chat-stream-qa", scenes: {}, screenshots: [], checks: [], errors: [], sourceSha256: {}, limitations: [
  "Headless Chrome component fixture, not WKWebView: scroll anchoring is switched off for the reader-up check to match WebKit, and frame timing differs.",
  "The turn store, agent, dictation, audio and Tauri service interfaces are synthetic; no database, model call or profile is touched.",
  "The card scene is the chat in a card-sized frame, not MonochatIsland itself; the door composer (FrontDoor) is the production component.",
] };
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
function check(scene, id, label, passed, details) {
  const known = EXPECTED_FAIL[id]?.scenes.includes(scene) ? EXPECTED_FAIL[id].reason : undefined;
  const outcome = passed ? (known ? "xpass" : "pass") : known ? "xfail" : "fail";
  report.checks.push({ scene, id, name: `${scene} ${label}`, passed: !!passed, outcome, expectedFail: known, details });
  if (outcome === "fail") console.error(`FAIL ${scene} ${label}`, JSON.stringify(details));
  if (outcome === "xpass") console.error(`XPASS ${scene} ${label}: passes now, delete its EXPECTED_FAIL entry`);
}
async function settle() { await cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"); await delay(120); }
async function screenshot(name) { const shot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); const file = `${name}.png`; await writeFile(path.join(output, file), Buffer.from(shot.data, "base64")); report.screenshots.push(file); }
const setTurn = (patch) => cdp.evaluate(`window.__turn.set(${JSON.stringify(patch)})`);

// ── The conversation ────────────────────────────────────────────────────
const FENCE = "```";
const FULL = [
  "**MARKERSTART** The conversation keeps its history and source anchors, so switching harnesses never loses the thread or the decisions already made in it.",
  "", "## What carries over", "",
  "- The bounded recap of every prior turn.", "- Source anchors on each action item.", "- The usage meter for the turn.", "",
  `${FENCE}ts`, "const recap = summarize(thread, { maxTokens: 2000 });", FENCE, "",
  "MARKEREND Existing action items remain attached to their original document.",
].join("\n");
const OPEN_FENCE_AT = FULL.indexOf("{ maxTokens");
const HEADING_FIRST = "## MARKERHEAD Meter\n\nMARKERTAIL The meter rides with the row once the turn settles.";
const LONG = FULL.replace("MARKERSTART", "MARKERUP").replace("MARKEREND", "MARKERUPEND") + "\n\n" +
  Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1} keeps the reply long enough to scroll past the fold, so the reader can sit mid-reply.`).join("\n\n");
const meter = (out, done) => ({ model: "claude-opus-4-6", effort: "xhigh", serviceTier: null, speed: null, inputTokens: 4, outputTokens: out, cacheReadTokens: 30200, cacheCreationTokens: 2100, contextTokens: 32304, contextWindow: 200000, toolCalls: 2, lastTool: "Grep", lastToolLabel: "Grep(seat_burn)", thinkingTokens: 120, stopReason: done ? "end_turn" : null, rateLimited: null, numTurns: done ? 3 : null, durationMs: done ? 12400 : null, costUsd: null, rev: out });
function conversation(scene) {
  const ids = { companionId: "qa", browseId: "b-1", missionId: "m-1", sessionId: "s-1", commentId: "c-1", ...(scene === "comment-chat" ? { mode: "chat" } : {}) };
  const msg = (id, role, body, createdAt) => ({ id, role, body, status: "complete", createdAt, backend: "claude-code", ...ids });
  const history = [
    msg("q1", "user", "How do we preserve the discussion while changing harnesses?", 1),
    msg("a1", "assistant", "The conversation keeps its history and source anchors.\n\n- Keep the current document in view.\n- Choose a harness for the next turn.", 2),
  ];
  const q2 = msg("q2", "user", "QA-QUESTION-2 What carries over when we switch?", 3), a2 = msg("a2", "assistant", FULL, 4);
  const q3 = msg("q3", "user", "QA-QUESTION-3 And the meter?", 5), a3 = msg("a3", "assistant", HEADING_FIRST, 6);
  const q4 = msg("q4", "user", "QA-QUESTION-4 Once more, longer?", 7), a4 = msg("a4", "assistant", LONG, 8);
  const queued = { ...msg("qq1", "user", "QA-QUEUED and one more thing", 9), status: "queued" };
  return { history, q2, a2, q3, a3, q4, a4, queued };
}

// ── In-page measurement ─────────────────────────────────────────────────
// Serialized into the page; reads one turn: the question `ask`, its reply's
// first line `first` and last line `last`.
function measure(ask, first, last) {
  const scene = document.querySelector("[data-qa-scene]");
  const textNode = (needle) => { const walk = document.createTreeWalker(scene, NodeFilter.SHOW_TEXT); let n; while ((n = walk.nextNode())) if (n.data.includes(needle)) return n; return null; };
  const scrollerOf = (el) => { for (let e = el; e && e !== scene.parentElement; e = e.parentElement) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY)) return e; return null; };
  const question = textNode(ask)?.parentElement ?? null;
  // The thread's scroller, found from its first message, which every state has.
  const scroller = scrollerOf(textNode("How do we preserve").parentElement);
  const frame = scroller.getBoundingClientRect();
  const line = (needle) => {
    const n = textNode(needle); if (!n) return null;
    const range = document.createRange(); range.setStart(n, n.data.indexOf(needle)); range.setEnd(n, n.data.indexOf(needle) + needle.length);
    const block = n.parentElement.closest("p,li,h1,h2,h3,div"), style = getComputedStyle(block);
    return { y: +range.getClientRects()[0].top.toFixed(1), font: style.fontSize, weight: style.fontWeight, marginTop: style.marginTop };
  };
  const transparent = (c) => c === "transparent" || /rgba\(.*,\s*0\)$/.test(c);
  const afterQuestion = (el) => !question || (question.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  const boxes = [];
  for (const el of scene.querySelectorAll("*")) {
    if (el.closest(".rl-md") || el.closest("textarea") || el === scroller) continue;
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    const s = getComputedStyle(el); if (s.visibility === "hidden" || +s.opacity === 0) continue;
    const border = ["Top", "Right", "Bottom", "Left"].some((k) => parseFloat(s[`border${k}Width`]) > 0 && s[`border${k}Style`] !== "none" && !transparent(s[`border${k}Color`]));
    if (!border && transparent(s.backgroundColor) && s.boxShadow === "none") continue;
    const inThread = scroller.contains(el);
    if (inThread && !afterQuestion(el)) continue;
    const data = [...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => a.name).sort().join(" ");
    boxes.push({ key: `${inThread ? "thread" : "frame"}|${el.tagName.toLowerCase()}|${el.getAttribute("class") ?? ""}|${data}|${el.getAttribute("role") ?? ""}`, text: (el.innerText ?? "").replace(/\s+/g, " ").slice(0, 48), h: Math.round(r.height), w: Math.round(r.width) });
  }
  const composer = [...scene.querySelectorAll("textarea")].filter((t) => t.getBoundingClientRect().height > 0).pop();
  const reply = textNode(first)?.parentElement.closest("[data-reply]");
  const tail = reply?.querySelector("[data-reply-tail]");
  // A tail control is out of reach when it sits past the reply's edge and no
  // scrolling row carries it back into view.
  const replyBox = reply?.getBoundingClientRect();
  const outOfReach = (b) => {
    const r = b.getBoundingClientRect(), row = b.closest(".rl-reply-actions");
    const scrolls = row && row.scrollWidth > row.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(row).overflowX);
    return !scrolls && (r.right > replyBox.right + 0.5 || r.left < replyBox.left - 0.5);
  };
  return {
    scroller: { clientHeight: scroller.clientHeight, top: +frame.top.toFixed(1), gapToBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) },
    composerWidth: composer ? +composer.getBoundingClientRect().width.toFixed(1) : null,
    ask: question ? +question.getBoundingClientRect().top.toFixed(1) : null, first: line(first), last: line(last), boxes,
    statuses: [...scene.querySelectorAll("[role=status]")].map((e) => e.textContent.replace(/\s+/g, " ").trim().slice(0, 48)),
    workingWords: (scene.textContent.match(/working…|Thinking|Preparing your reply/g) ?? []).length,
    caret: scene.textContent.includes("▌"),
    queued: scene.innerText.includes("QA-QUEUED"),
    tail: tail ? Math.round(tail.getBoundingClientRect().height) : null,
    tailOutOfReach: tail ? [...tail.querySelectorAll("button")].filter(outOfReach).map((b) => b.getAttribute("aria-label") ?? b.textContent) : null,
    codeFrames: [...scene.querySelectorAll(".rl-md pre")].map((pre) => { let n = 0; for (let e = pre; e && !e.classList.contains("rl-md"); e = e.parentElement) { const cs = getComputedStyle(e); if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none") n++; } return n; }),
    listStyle: (() => { const ul = scene.querySelector(".rl-md ul"); return ul ? getComputedStyle(ul).listStyleType : null; })(),
  };
}
const measureTurn = (ask, first, last) => cdp.evaluate(`(${measure})(${JSON.stringify(ask)}, ${JSON.stringify(first)}, ${JSON.stringify(last)})`);
/** Applies `patch` and reads the gap to the bottom on the first painted frame. */
const firstFrameGap = (patch) => cdp.evaluate(`new Promise(resolve => { window.__turn.set(${JSON.stringify(patch)}); requestAnimationFrame(() => resolve((${measure})("QA-QUESTION-2", "MARKERSTART", "MARKEREND").scroller.gapToBottom)); })`);

async function runScene(scene) {
  const rec = { states: {} };
  report.scenes[scene] = rec;
  const c = conversation(scene);
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: `${report.fixtureUrl}?scene=${scene}` });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    const [flag, error] = await cdp.evaluate("[document.documentElement.dataset.qaReady, document.body?.dataset.qaError]").catch(() => [null, null]);
    if (error) throw new Error(`${scene}: ${error}`);
    if (flag === "true") { ready = true; break; }
    await delay(100);
  }
  if (!ready) throw new Error(`${scene} did not render: ${report.errors.join("\n")}`);
  await delay(400);
  const state = async (name, patch) => { await setTurn(patch); await settle(); rec.states[name] = await measureTurn("QA-QUESTION-2", "MARKERSTART", "MARKEREND"); await screenshot(`${scene}-${name}`); return rec.states[name]; };
  const t0 = Date.now();
  const idle = await state("0-idle", { messages: c.history, status: "idle", liveText: "", activity: [], meter: null, meters: {}, queue: [] });
  const sent = await state("1-sent", { messages: [...c.history, c.q2], status: "streaming", startedAt: t0, liveText: "", activity: [], meter: null });
  const tool = await state("2-tool", { meter: meter(0, false), activity: [{ at: t0 + 1, kind: "thinking", label: "Thinking…" }, { at: t0 + 2, kind: "tool", label: "Grep(seat_burn)" }] });
  // Thirty chunks up to an open code fence, each read on the next animation frame.
  const gaps = [];
  for (let i = 1; i <= 30; i++) { const cut = Math.round((i / 30) * OPEN_FENCE_AT); gaps.push(await firstFrameGap({ liveText: FULL.slice(0, cut), meter: meter(cut, false) })); }
  const mid = await state("3-midstream", {});
  const full = await state("4-stream-full", { liveText: FULL });
  const queued = QUEUEING.has(scene) ? await state("4q-queued", { queue: [c.queued] }) : null;
  await setTurn({ queue: [] }); await settle();
  const settled = await state("5-settled", { messages: [...c.history, c.q2, c.a2], liveText: "", status: "idle", meter: null, activity: [], meters: { a2: meter(OPEN_FENCE_AT, true) } });
  // A reply that opens on a heading, written before the turn's first tool —
  // the agent says what it will check, then checks — so the tool fires under
  // text already on screen.
  await setTurn({ messages: [...c.history, c.q2, c.a2, c.q3], status: "streaming", startedAt: Date.now(), liveText: HEADING_FIRST, meter: { ...meter(20, false), toolCalls: 0, lastTool: null, lastToolLabel: null }, activity: [] }); await settle();
  const textFirst = rec.states["6-head-text-first"] = await measureTurn("QA-QUESTION-3", "MARKERHEAD", "MARKERTAIL");
  await setTurn({ meter: meter(21, false), activity: [{ at: Date.now(), kind: "tool", label: "Grep(seat_burn)" }] }); await settle();
  const headLive = rec.states["6-head-streaming"] = await measureTurn("QA-QUESTION-3", "MARKERHEAD", "MARKERTAIL");
  await setTurn({ messages: [...c.history, c.q2, c.a2, c.q3, c.a3], liveText: "", status: "idle", meter: null, meters: { a2: meter(OPEN_FENCE_AT, true), a3: meter(20, true) } }); await settle();
  const headSettled = rec.states["7-head-settled"] = await measureTurn("QA-QUESTION-3", "MARKERHEAD", "MARKERTAIL");
  await screenshot(`${scene}-7-head-settled`);
  // A reader parked near the top of a long reply when it settles. Scroll
  // anchoring is off, as in WebKit.
  const before = [...c.history, c.q2, c.a2, c.q3, c.a3, c.q4];
  await setTurn({ messages: before, status: "streaming", startedAt: Date.now(), liveText: LONG, meter: meter(400, false), activity: [{ at: Date.now(), kind: "tool", label: "Grep(seat_burn)" }] }); await settle();
  const parked = await cdp.evaluate(`(() => {
    const m = (${measure})("QA-QUESTION-4", "MARKERUP", "MARKERUPEND"), scene = document.querySelector("[data-qa-scene]");
    const walk = document.createTreeWalker(scene, NodeFilter.SHOW_TEXT); let n; while ((n = walk.nextNode()) && !n.data.includes("MARKERUP"));
    let sc = n.parentElement; while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement;
    if (!sc) return null;
    sc.style.overflowAnchor = "none";
    sc.scrollTop += m.first.y - sc.getBoundingClientRect().top - 60;
    sc.dispatchEvent(new Event("scroll"));
    return true;
  })()`);
  await settle();
  const readerBefore = parked && (await measureTurn("QA-QUESTION-4", "MARKERUP", "MARKERUPEND")).first?.y;
  await setTurn({ messages: [...before, c.a4], liveText: "", status: "idle", meter: null, activity: [], meters: { a2: meter(OPEN_FENCE_AT, true), a3: meter(20, true), a4: meter(400, true) } }); await settle();
  const readerAfter = parked && (await measureTurn("QA-QUESTION-4", "MARKERUP", "MARKERUPEND")).first?.y;
  await screenshot(`${scene}-8-reader-up-settled`);
  rec.readerUp = { before: readerBefore, after: readerAfter };

  // ── Checks ──
  const delta = (a, b) => (a == null || b == null ? null : +(b - a).toFixed(1));
  const still = (d, tolerance = 0.5) => d !== null && Math.abs(d) <= tolerance;
  // Counted per key, so a Stop inserted beside a Send of the same class
  // still counts as a box of its own.
  const tally = (s) => s.boxes.reduce((m, b) => m.set(b.key, [...(m.get(b.key) ?? []), b]), new Map());
  const rest = [idle, settled].map(tally);
  const streamingOnly = new Map();
  for (const s of [sent, tool, mid, full]) {
    for (const [k, boxes] of tally(s)) {
      const extra = boxes.length - Math.max(...rest.map((m) => m.get(k)?.length ?? 0));
      if (extra > (streamingOnly.get(k)?.extra ?? 0)) streamingOnly.set(k, { key: k, extra, seen: boxes.map(({ text, h, w }) => ({ text, h, w })) });
    }
  }
  check(scene, "one-status", "shows one status line while the reply waits", sent.statuses.length === 1 && tool.statuses.length === 1 && sent.workingWords === 1, { sent: sent.statuses, tool: tool.statuses, workingWords: sent.workingWords });
  check(scene, "no-caret", "streams with no caret glyph", !mid.caret && !full.caret, { mid: mid.caret, full: full.caret });
  check(scene, "settled-quiet", "says nothing is running once the reply settles", settled.statuses.length === 0, settled.statuses);
  check(scene, "viewport-send", "keeps the thread viewport at send and at the first tool", idle.scroller.clientHeight === sent.scroller.clientHeight && sent.scroller.clientHeight === tool.scroller.clientHeight, [idle, sent, tool].map((s) => s.scroller.clientHeight));
  check(scene, "viewport-settle", "keeps the thread viewport at settle", full.scroller.clientHeight === settled.scroller.clientHeight, [full.scroller.clientHeight, settled.scroller.clientHeight]);
  check(scene, "follow-streaming", "follows every streamed frame while parked", gaps.every((gap) => gap <= 2), { notPinned: gaps.filter((gap) => gap > 2).length, gaps });
  if (queued) {
    check(scene, "viewport-queue", "keeps the thread viewport when a message is queued", full.scroller.clientHeight === queued.scroller.clientHeight, [full.scroller.clientHeight, queued.scroller.clientHeight]);
    check(scene, "follow-queue", "stays pinned to the newest line after a queued send", queued.scroller.gapToBottom === 0, queued.scroller);
    check(scene, "queue-visible", "shows the queued message", queued.queued, {});
  }
  check(scene, "settle-first-line", "settles without moving its first line", still(delta(full.first?.y, settled.first?.y)), { delta: delta(full.first?.y, settled.first?.y) });
  check(scene, "settle-last-line", "settles without moving its last line", still(delta(full.last?.y, settled.last?.y)), { delta: delta(full.last?.y, settled.last?.y) });
  // The question above it too: parked at the bottom, a line pushed in above
  // the text moves what is ABOVE the line, not the text under it.
  const toolShift = { ask: delta(textFirst.ask, headLive.ask), first: delta(textFirst.first?.y, headLive.first?.y), last: delta(textFirst.last?.y, headLive.last?.y) };
  check(scene, "tool-after-text", "keeps the turn still when a tool fires after the reply has started writing", Object.values(toolShift).every((d) => still(d)), toolShift);
  check(scene, "settle-heading-first", "settles a heading-first reply without moving it", still(delta(headLive.first?.y, headSettled.first?.y)), { delta: delta(headLive.first?.y, headSettled.first?.y), marginTop: [headLive.first?.marginTop, headSettled.first?.marginTop] });
  check(scene, "reader-up", "leaves a reader parked mid-reply where they are", readerBefore != null && delta(readerBefore, readerAfter) === 0, { before: readerBefore, after: readerAfter });
  check(scene, "lead-scale", "sizes the lead paragraph at or above the reply's text, at any text size", !!settled.first && parseFloat(settled.first.font) >= parseFloat(settled.last?.font), { lead: settled.first?.font, body: settled.last?.font });
  check(scene, "lead-font", "keeps the lead paragraph's type at settle", !!full.first && full.first.font === settled.first?.font && full.first.weight === settled.first?.weight, { streamed: [full.first?.font, full.first?.weight], settled: [settled.first?.font, settled.first?.weight] });
  check(scene, "streaming-only-boxes", "draws no box that exists only while streaming", streamingOnly.size === 0, [...streamingOnly.values()]);
  check(scene, "composer-steady", "keeps the composer's field the same width through the turn", [sent, full, settled].every((s) => still(delta(idle.composerWidth, s.composerWidth))), [idle, sent, full, settled].map((s) => s.composerWidth));
  check(scene, "code-frames", "frames each code block once", settled.codeFrames.length > 0 && settled.codeFrames.every((n) => n === 1), settled.codeFrames);
  check(scene, "list-markers", "keeps list bullets", settled.listStyle === "disc", settled.listStyle);
  check(scene, "tail-height", "holds the reply's tail row at one height", mid.tail != null && mid.tail === full.tail && full.tail === settled.tail, [mid.tail, full.tail, settled.tail]);
  check(scene, "tail-reachable", "keeps every control in a settled reply's tail within reach", settled.tailOutOfReach != null && settled.tailOutOfReach.length === 0, settled.tailOutOfReach);
}

try {
  await mkdir(output, { recursive: true });
  for (const file of ["src/components/ReplyBlock.tsx", "src/components/ReplyBlock.css", "src/components/StreamingText.tsx", "src/components/MarkdownView.tsx", "src/components/QueueTray.tsx", "src/components/SendStopButton.tsx", "src/components/ChatWorkbench.css", "src/components/ChatRoom.tsx", "src/components/BrowserChat.tsx", "src/components/MissionChat.tsx", "src/components/MemoryAsk.tsx", "src/components/ReviewThread.tsx", "src/components/CommentThread.tsx", "src/components/DrafterSidecar.tsx", "src/components/FrontDoor.tsx", "src/hooks/useStickToBottom.ts", "src/styles.css"]) report.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  server = await createServer({ configFile: false, root, cacheDir: path.join(temporary, "vite-cache"), optimizeDeps: { entries: ["fixtures/chat-stream-qa/index.html"], include: ["@tauri-apps/plugin-deep-link", "@tauri-apps/api/dpi"] }, plugins: [react(), tailwindcss()], resolve: { alias: [
    { find: /^.*\/hooks\/useAgentTurn$/, replacement: service }, { find: /^.*\/audio\/useReadAloud$/, replacement: service }, { find: /^.*\/lib\/useDictation$/, replacement: service },
    ...["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/window", "@tauri-apps/api/webview", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener"].map((find) => ({ find, replacement: service })),
  ] }, server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/src-tauri/**", "**/docs/**"] } }, clearScreen: false });
  await server.listen(); report.fixtureUrl = `http://127.0.0.1:${server.httpServer.address().port}/fixtures/chat-stream-qa/`;
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--user-data-dir=${path.join(temporary, "chrome-profile")}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-extensions", "about:blank"], { stdio: "ignore" });
  let port; for (let i = 0; i < 150; i++) { try { port = (await readFile(path.join(temporary, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch {} await delay(100); }
  if (!port) throw new Error("Chrome did not start");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); cdp = new CDP(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable"); await cdp.call("Runtime.enable"); await cdp.call("Log.enable");
  for (const scene of scenes) { try { await runScene(scene); } catch (error) { report.errors.push(`${scene}: ${error.stack ?? error}`); } }
} catch (error) { report.errors.push(error.stack ?? String(error)); }
finally {
  report.finishedAt = new Date().toISOString();
  const count = (outcome) => report.checks.filter((c) => c.outcome === outcome).length;
  report.summary = { pass: count("pass"), fail: count("fail"), xfail: count("xfail"), xpass: count("xpass") };
  report.passed = report.summary.fail === 0 && report.summary.xpass === 0 && report.errors.length === 0;
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  cdp?.close(); chrome?.kill(); await server?.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(JSON.stringify({ passed: report.passed, ...report.summary, errors: report.errors, output }, null, 2)); if (!report.passed) process.exitCode = 1;
}
