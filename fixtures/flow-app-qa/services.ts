// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The fake Tauri backend behind the full-App QA fixture.
//!
//! scripts/flow-app-visual-qa.mjs aliases EVERY `@tauri-apps/*` import in
//! `src/` (api core/event/window/webview/dpi/path/app and the dialog, opener,
//! deep-link and notification plugins) to this one module, so the real
//! `src/main.tsx` → `App` boots in headless Chrome against scripted answers
//! instead of a Rust process. Nothing under `src/` knows it is here.
//!
//! - `invoke(cmd, args)` dispatches to the handler table below. A command
//!   with no handler still answers (an empty list for list-shaped names,
//!   `null` otherwise) and is recorded in `window.__qa.unmocked`, so the
//!   script can report exactly what App asked for that the fake doesn't know.
//! - `listen` / `emit` are an in-page event bus; the script drives it with
//!   `window.__qa.emit(name, payload)`.
//! - `Channel` is a plain object whose `onmessage` the fake (or the script,
//!   through `__qa.convoPush` / `__qa.ptyOutput`) feeds: the PTY byte stream
//!   and the conversation mirror's batches both ride one.
//! - Window and webview handles are proxies that answer every method with a
//!   resolved no-op, so a native call App makes can never throw here.

import {
  DIN,
  HOME,
  type Scenario,
  type SeedComment,
  type SeedSession,
  type SeedTerminal,
} from "./scenarios";
import type { ConvoBatch, ConvoEvent } from "../../src/components/agent/convo/types";

type Args = Record<string, unknown> | undefined;
type Handler = (args: Args) => unknown;

interface PtyState {
  id: string;
  cwd: string | null;
  channel: Channel<ArrayBuffer> | null;
  /** Everything typed into it, for the script to read back. */
  input: string[];
  /** Bound to a scenario launch (4b): the agent "starts" when the launch
   *  command is typed. */
  launched: boolean;
  sessionId: string | null;
}

interface ConvoSub {
  subscriptionId: string;
  channel: Channel<ConvoBatch>;
}

/** What a frozen page clock reads. `main.tsx` installs it before the App
 *  module loads; `__qa.advance(ms)` moves it. */
export const clock = { now: Date.now(), frozen: false };

const state = {
  scenario: null as Scenario | null,
  calls: [] as { cmd: string; args: unknown; at: number }[],
  unmocked: new Map<string, { count: number; firstArgs: unknown }>(),
  listeners: new Map<string, Set<(event: { event: string; id: number; payload: unknown }) => void>>(),
  ptys: new Map<string, PtyState>(),
  convoSubs: new Map<string, ConvoSub>(),
  /** Events per terminal: the seeded tail plus anything pushed since. */
  convo: new Map<string, ConvoEvent[]>(),
  attention: new Map<string, Record<string, unknown>>(),
  overrides: new Map<string, Handler>(),
  sessions: new Map<string, ReturnType<typeof buildSession>>(),
  eventSeq: 0,
  subSeq: 0,
};

// ── Plan parsing ───────────────────────────────────────────────────────────
//
// `get_session` hands App each revision already parsed into sections and
// blocks with stable ids, the way `src-tauri/src/parser.rs` does. The seed
// plans are simple (one block per blank-line-separated run of lines), so a
// small walker reproduces the parser's anchors exactly: top-level headings
// are A, B, …; a nested heading is `A.1`; a block is `<section>.p<n>`.

interface Block {
  kind: "heading" | "block";
  level: number;
  markdown: string;
  blockId: string;
}

function letterLabel(n: number): string {
  let out = "";
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

/** The parser's plain text: markup gone, list items and paragraphs ended,
 *  whitespace collapsed. */
function plainText(md: string): string {
  return md
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").replace(/^\|?|\|?$/g, "").replace(/\|/g, " ").replace(/^-{3,}.*$/, ""))
    .join(" ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** The editor's textContent for a block: list items and table cells run
 *  together with no separator, which is what a selection's offsets count. */
function editorText(md: string): string {
  if (/^\s*(?:\d+\.|[-*+])\s/.test(md)) {
    return md.split("\n").map((l) => l.replace(/^\s*(?:\d+\.|[-*+])\s+/, "")).join("").replace(/\*\*|`/g, "");
  }
  if (md.startsWith("|")) {
    return md
      .split("\n")
      .filter((l) => !/^\|?\s*-{3,}/.test(l))
      .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()).join(""))
      .join("")
      .replace(/\*\*/g, "");
  }
  return md.replace(/\*\*|`/g, "").replace(/\n/g, " ");
}

function blocksOf(markdown: string, seed: string): Block[] {
  const blocks: Block[] = [];
  let n = 0;
  for (const chunk of markdown.split(/\n{2,}/)) {
    const md = chunk.trim();
    if (!md) continue;
    n += 1;
    const blockId = `blk-${seed}${n.toString(16).padStart(4, "0")}`;
    const heading = /^(#{1,6})\s+(.*)$/.exec(md);
    blocks.push(heading
      ? { kind: "heading", level: heading[1].length, markdown: md, blockId }
      : { kind: "block", level: 0, markdown: md, blockId });
  }
  return blocks;
}

interface ParsedSection {
  anchorId: string;
  blockId: string;
  level: number;
  title: string;
  bodyMarkdown: string;
  children: ParsedSection[];
  paragraphs: { anchorId: string; blockId: string; markdown: string; text: string }[];
}

function parsePlan(markdown: string, seed: string) {
  const blocks = blocksOf(markdown, seed);
  const root: ParsedSection & { next: number; nextP: number } = { anchorId: "", blockId: "", level: 0, title: "", bodyMarkdown: "", children: [], paragraphs: [], next: 0, nextP: 0 };
  const stack: (ParsedSection & { next: number; nextP: number })[] = [root];
  /** Per block, in order: its anchor (for comments). */
  const anchors: string[] = [];
  for (const b of blocks) {
    if (b.kind === "heading") {
      while (stack.length > 1 && stack[stack.length - 1].level >= b.level) stack.pop();
      const parent = stack[stack.length - 1];
      parent.next += 1;
      const anchorId = parent.level === 0 ? letterLabel(parent.next) : `${parent.anchorId}.${parent.next}`;
      const section = { anchorId, blockId: b.blockId, level: b.level, title: b.markdown.replace(/^#+\s+/, ""), bodyMarkdown: "", children: [], paragraphs: [], next: 0, nextP: 0 };
      parent.children.push(section);
      stack.push(section);
      anchors.push(anchorId);
    } else {
      const frame = stack[stack.length - 1];
      frame.nextP += 1;
      const anchorId = `${frame.anchorId}.p${frame.nextP}`;
      frame.bodyMarkdown += (frame.bodyMarkdown ? "\n\n" : "") + b.markdown;
      frame.paragraphs.push({ anchorId, blockId: b.blockId, markdown: b.markdown, text: plainText(b.markdown) });
      anchors.push(anchorId);
    }
  }
  const strip = (s: ParsedSection & { next?: number; nextP?: number }): ParsedSection => ({
    anchorId: s.anchorId, blockId: s.blockId, level: s.level, title: s.title, bodyMarkdown: s.bodyMarkdown,
    paragraphs: s.paragraphs, children: s.children.map(strip),
  });
  // The stored markdown carries a sidecar before every block, as a parsed
  // revision does once the backend has stamped it.
  const raw = blocks.map((b) => `<!-- rl:${b.blockId} -->\n${b.markdown}`).join("\n\n") + "\n";
  return { sections: root.children.map(strip), raw, blocks, anchors };
}

function buildComment(c: SeedComment, parsed: ReturnType<typeof parsePlan>) {
  const block = parsed.blocks[c.block];
  const comment: Record<string, unknown> = {
    id: c.id,
    type: c.type,
    anchorId: c.anchorOverride ?? parsed.anchors[c.block],
    body: c.body,
    createdAt: c.createdAt,
    status: c.status,
  };
  if (!c.anchorOverride && block) comment.blockId = block.blockId;
  if (c.quote && block) {
    const text = editorText(block.markdown);
    const start = text.indexOf(c.quote);
    comment.selection = {
      charStart: Math.max(0, start),
      charEnd: Math.max(0, start) + c.quote.length,
      quotedText: c.quote,
      ...(c.sentence ? { subBlockId: `${block.blockId}.s${c.sentence}` } : {}),
    };
  }
  if (c.resolution) comment.resolution = c.resolution;
  if (c.provenance) comment.provenance = c.provenance;
  return comment;
}

function buildSession(seed: SeedSession) {
  const seedHex = seed.sessionId.replace(/[^a-f0-9]/g, "").padEnd(4, "a").slice(0, 4);
  const revisions = seed.revisions.map((r) => {
    const parsed = parsePlan(r.markdown, seedHex);
    return {
      versionNumber: r.version,
      receivedAt: r.receivedAt,
      rawPlanMarkdown: parsed.raw,
      sections: parsed.sections,
      comments: (r.comments ?? []).map((c) => buildComment(c, parsed)),
      threadStart: r.version === 1,
      restored: false,
    };
  });
  const latest = revisions[revisions.length - 1];
  const title = /^#\s+(.*)$/m.exec(seed.revisions[seed.revisions.length - 1].markdown)?.[1] ?? null;
  const projectName = seed.projectPath.split("/").filter(Boolean).pop() ?? seed.projectPath;
  const full = {
    sessionId: seed.sessionId,
    projectPath: seed.projectPath,
    projectName,
    createdAt: seed.createdAt,
    revisions,
    status: seed.status,
    attachState: seed.attachState ?? "idle",
    backend: "claude-code",
    model: seed.model ?? null,
    effort: seed.effort ?? null,
  };
  const pending = latest.comments.filter((c) => c.status === "draft").length;
  const summary = {
    sessionId: seed.sessionId,
    projectName,
    projectPath: seed.projectPath,
    planTitle: title,
    archivedAt: null as number | null,
    titleOverride: seed.titleOverride ?? null,
    latestVersion: latest.versionNumber,
    revisions: revisions.map((r) => ({ versionNumber: r.versionNumber, receivedAt: r.receivedAt, threadStart: r.threadStart, restored: false })),
    createdAt: seed.createdAt,
    updatedAt: seed.updatedAt,
    status: seed.status,
    pendingCount: pending,
    awaitingReview: seed.status === "in_review",
    held: seed.attachState === "held",
    heldTerminalId: null as string | null,
    attachState: seed.attachState ?? "idle",
    runState: seed.runState ?? null,
    runMode: seed.runState ? "workflow" : null,
    backend: "claude-code",
    model: seed.model ?? null,
    effort: seed.effort ?? null,
  };
  return { full, summary };
}

function summaries() {
  return [...state.sessions.values()]
    .map((s) => s.summary)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Event bus ──────────────────────────────────────────────────────────────

function dispatch(event: string, payload: unknown): void {
  const set = state.listeners.get(event);
  if (!set) return;
  const id = ++state.eventSeq;
  for (const handler of [...set]) {
    try {
      handler({ event, id, payload });
    } catch (err) {
      console.error(`[qa] listener for ${event} threw`, err);
    }
  }
}

export type UnlistenFn = () => void;

export async function listen<T>(event: string, handler: (event: { event: string; id: number; payload: T }) => void): Promise<UnlistenFn> {
  let set = state.listeners.get(event);
  if (!set) state.listeners.set(event, (set = new Set()));
  const h = handler as (e: { event: string; id: number; payload: unknown }) => void;
  set.add(h);
  return () => set!.delete(h);
}

export async function once<T>(event: string, handler: (event: { event: string; id: number; payload: T }) => void): Promise<UnlistenFn> {
  const off = await listen<T>(event, (e) => {
    off();
    handler(e);
  });
  return off;
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  dispatch(event, payload);
}

export async function emitTo(_target: unknown, event: string, payload?: unknown): Promise<void> {
  dispatch(event, payload);
}

// ── Channel ────────────────────────────────────────────────────────────────

let channelSeq = 0;

/** Tauri's IPC channel, minus the IPC: whoever holds it calls `onmessage`. */
export class Channel<T = unknown> {
  id = ++channelSeq;
  onmessage: (message: T) => void = () => {};
  toJSON(): string {
    return `__CHANNEL__:${this.id}`;
  }
}

export function transformCallback(): number {
  return 0;
}

export function convertFileSrc(path: string): string {
  return path;
}

export function isTauri(): boolean {
  return false;
}

// ── Windows and webviews ───────────────────────────────────────────────────

const unlistenAsync = async () => () => {};

/** A handle whose every method resolves to nothing: `on*`/`listen`/`once`
 *  resolve to an unlisten function, getters to plausible values. `then` is
 *  left undefined so an `await handle` doesn't mistake it for a promise. */
function nativeHandle(label: string, known: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    label,
    listen: unlistenAsync,
    once: unlistenAsync,
    emit: async () => {},
    isFocused: async () => true,
    isFullscreen: async () => false,
    isMaximized: async () => false,
    isMinimized: async () => false,
    isVisible: async () => true,
    isDecorated: async () => true,
    scaleFactor: async () => 1,
    innerSize: async () => new PhysicalSize(window.innerWidth, window.innerHeight),
    outerSize: async () => new PhysicalSize(window.innerWidth, window.innerHeight),
    innerPosition: async () => new PhysicalPosition(0, 0),
    outerPosition: async () => new PhysicalPosition(0, 0),
    position: async () => new PhysicalPosition(0, 0),
    size: async () => new PhysicalSize(window.innerWidth, window.innerHeight),
    theme: async () => "dark",
    title: async () => "Redline",
    ...known,
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === "then" || typeof prop === "symbol") return undefined;
      if (/^on[A-Z]/.test(prop)) return unlistenAsync;
      return async () => null;
    },
  });
}

const currentWindow = nativeHandle("main");
const currentWebview = nativeHandle("main", { window: currentWindow });

export function getCurrentWindow() {
  return currentWindow;
}

export function getAllWindows() {
  return [currentWindow];
}

export class Window {
  static getCurrent() {
    return currentWindow;
  }
  static async getByLabel(label: string) {
    return label === "main" ? currentWindow : null;
  }
  static async getAll() {
    return [currentWindow];
  }
  constructor(label: string) {
    return nativeHandle(label) as unknown as Window;
  }
}

export function getCurrentWebview() {
  return currentWebview;
}

export function getCurrentWebviewWindow() {
  return currentWebview;
}

/** Child webviews (the embedded browser) don't exist headless: none are
 *  found, and creating one yields an inert handle. */
export class Webview {
  static getCurrent() {
    return currentWebview;
  }
  static async getByLabel() {
    return null;
  }
  static async getAll() {
    return [currentWebview];
  }
  constructor(_window: unknown, label: string) {
    return nativeHandle(label) as unknown as Webview;
  }
}

export const UserAttentionType = { Critical: 1, Informational: 2 } as const;

export class LogicalSize {
  type = "Logical";
  constructor(public width: number, public height: number) {}
}
export class PhysicalSize {
  type = "Physical";
  constructor(public width: number, public height: number) {}
  toLogical() {
    return new LogicalSize(this.width, this.height);
  }
}
export class LogicalPosition {
  type = "Logical";
  constructor(public x: number, public y: number) {}
}
export class PhysicalPosition {
  type = "Physical";
  constructor(public x: number, public y: number) {}
  toLogical() {
    return new LogicalPosition(this.x, this.y);
  }
}

// ── Plugins and paths ──────────────────────────────────────────────────────

/** plugin-dialog `open`: the picker answers the DIN repo. */
export async function open(): Promise<string | null> {
  return DIN;
}
export async function save(): Promise<string | null> {
  return null;
}
export async function message(): Promise<void> {}
export async function ask(): Promise<boolean> {
  return true;
}
export async function confirm(): Promise<boolean> {
  return true;
}
export async function openUrl(url: string): Promise<void> {
  record("plugin:opener|open_url", { url });
}
export async function openPath(path: string): Promise<void> {
  record("plugin:opener|open_path", { path });
}
export async function revealItemInDir(path: string): Promise<void> {
  record("plugin:opener|reveal_item_in_dir", { path });
}
/** plugin-deep-link. */
export async function onOpenUrl(): Promise<UnlistenFn> {
  return () => {};
}
export async function getCurrent(): Promise<string[] | null> {
  return null;
}
/** plugin-notification. */
export async function isPermissionGranted(): Promise<boolean> {
  return false;
}
export async function requestPermission(): Promise<string> {
  return "denied";
}
export function sendNotification(): void {}
export async function homeDir(): Promise<string> {
  return HOME;
}
export async function getVersion(): Promise<string> {
  return "0.0.0-qa";
}

// ── PTYs ───────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function send(pty: PtyState, text: string): void {
  if (!pty.channel) return;
  pty.channel.onmessage(encoder.encode(text).buffer as ArrayBuffer);
}

function ptyFor(id: string, cwd: string | null = null): PtyState {
  let pty = state.ptys.get(id);
  if (!pty) {
    pty = { id, cwd, channel: null, input: [], launched: false, sessionId: null };
    state.ptys.set(id, pty);
  }
  return pty;
}

function seededTerminal(id: string): SeedTerminal | undefined {
  return state.scenario?.terminals.find((t) => t.id === id);
}

/** The launch command reached the shell: start the scenario's agent in
 *  this terminal — its screen, its bind, its attention and its mirror. */
function startLaunch(pty: PtyState): void {
  const launch = state.scenario?.launch;
  if (!launch || pty.launched) return;
  if ([...state.ptys.values()].some((p) => p.launched)) return;
  pty.launched = true;
  pty.sessionId = launch.sessionId;
  setTimeout(() => {
    send(pty, `\r\n${launch.screen}`);
    const events = launch.convo.map((e) =>
      e.kind === "bound" ? { ...e, sessionId: launch.sessionId } : e,
    );
    state.convo.set(pty.id, events);
    dispatch("convo-bound", { terminalId: pty.id, sessionId: launch.sessionId, harness: "claude", transcriptPath: null });
    // The CLI names the session itself (its ai-title, experiment (m) S12)
    // long before the plan's heading exists: that is 4b's title.
    if (launch.title) dispatch("convo-title", { terminalId: pty.id, sessionId: launch.sessionId, title: launch.title });
    const attention = { terminalId: pty.id, sessionId: launch.sessionId, at: clock.now, kind: "working" };
    state.attention.set(pty.id, attention);
    dispatch("term-attention", attention);
    const sub = state.convoSubs.get(pty.id);
    if (sub) sub.channel.onmessage({ events, reset: true });
  }, 60);
}

// ── invoke ─────────────────────────────────────────────────────────────────

/** Commands whose answer is typed as a list in `src/` (grep of
 *  `invoke<…[]>`), plus the obvious name shapes: unknown ones of these get
 *  `[]` rather than `null`, so a `.map` never throws on a fake's silence. */
const LIST_COMMANDS = new Set(
  "browse_list_reorder browser_organize_tabs browser_workspace_list classmem_proposals classmem_runs classmem_tree comment_offers_pending companion_changes companion_get_thread companion_list doc_lines draft_comment_list draft_source_list draft_suggestions_pending extensions_list get_seat_roster git_gui_commit_files git_gui_log git_gui_stash_files harness_agent_list ledger_list_events ledger_prompt_models ledger_query list_dir list_harnesses list_orchestrations list_sessions list_share_returns list_shares mission_get_tabs mission_list mission_list_findings monochat_traces parse_markdown_sections pty_list pty_procs review_annotation_list review_commits review_diff review_list_viewed review_question_list review_sessions_list runner_list runner_node_diff scaled_pending seat_preflight self_develop_list shots_list term_attention_snapshot thumbs_list voice_thread".split(" "),
);

function defaultFor(cmd: string): unknown {
  if (LIST_COMMANDS.has(cmd) || /(^list_|_list$|_history$|_recent$)/.test(cmd)) return [];
  return null;
}

function record(cmd: string, args: unknown): void {
  state.calls.push({ cmd, args: summarizeArgs(args), at: performance.now() });
}

/** Channels and long strings don't survive JSON well; keep the gist. */
function summarizeArgs(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v instanceof Channel) out[k] = "<channel>";
    else if (typeof v === "string" && v.length > 160) out[k] = `${v.slice(0, 157)}…`;
    else out[k] = v;
  }
  return out;
}

const READY_PREFLIGHT = () => ({
  claude: { found: true, path: "/usr/local/bin/claude", source: "path", identity: "imani@example.com" },
  providers: {
    "claude-code": {
      found: true,
      path: "/usr/local/bin/claude",
      source: "path",
      usable: true,
      version: "2.1.300",
      identity: "imani@example.com",
      authentication: "signed-in",
      hook: { installed: true, state: "installed", hooksPath: `${HOME}/.claude/settings.json`, error: null },
      skill: { installed: true, outdated: false, skillPath: `${HOME}/.claude/skills/redline/SKILL.md` },
    },
  },
  codex: null,
  curl: { ok: true, version: "8.7.1" },
  mode: "active",
  hook: { installed: true, conflictingUrl: null, settingsPath: `${HOME}/.claude/settings.json`, matcherFound: true, attentionInstalled: true },
  skill: { installed: true, outdated: false, skillPath: `${HOME}/.claude/skills/redline/SKILL.md`, version: 5 },
  codexHook: null,
  codexSkill: null,
  extension: null,
});

/** The fake model catalog. See scenarios.ts for why it says "Opus 4.5". */
const CLAUDE_MODELS = [
  { slug: "opus", displayName: "Opus 4.5", description: "Most capable for complex work", defaultEffort: "high", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { slug: "sonnet", displayName: "Sonnet 4.5", description: "Best for everyday tasks", defaultEffort: "medium", efforts: ["low", "medium", "high"] },
  { slug: "haiku", displayName: "Haiku 4.5", description: "Fastest for quick answers", defaultEffort: null, efforts: [] },
];

function runSnapshot() {
  const run = state.scenario?.run;
  if (!run) return null;
  const started = clock.now - 40 * 60_000;
  return {
    planSessionId: run.sessionId,
    claudeSessionId: `${run.sessionId}-build`,
    runState: "running",
    startedAt: started,
    updatedAt: clock.now - 20_000,
    seq: 42,
    mode: "workflow",
    runId: "run-qa-1",
    workflowName: "Build v4",
    workflowDescription: null,
    phases: run.phases.map((title) => ({ title, detail: null })),
    scriptPath: null,
    transcriptDir: null,
    totals: { plannedAgents: run.steps, running: 1, done: run.step - 1, failed: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, toolCalls: 0, filesChanged: [] },
    agents: run.phases.slice(0, run.step).map((title, i) => ({
      agentId: `agent-${i + 1}`,
      label: title,
      labelSource: "manifest",
      phase: title,
      model: "opus",
      effort: "high",
      state: i + 1 < run.step ? "done" : "running",
      startedAt: started + i * 600_000,
      lastActivityAt: clock.now - 20_000,
      durationMs: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolCalls: 0,
      lastToolName: null,
      promptPreview: null,
      resultPreview: null,
      filesChanged: [],
      transcriptBytes: 0,
    })),
    manifest: null,
    reportFiled: false,
    dirsMissing: false,
    notes: [],
  };
}

const handlers: Record<string, Handler> = {
  // Boot: one snapshot decides the first frame (App's "Core bootstrap").
  bootstrap_state: () => ({
    sessions: summaries(),
    heldSessionId: state.scenario?.heldSessionId ?? null,
    mode: "active",
    daemon: "ready",
    workspace: null,
    harnessFlavor: null,
    harnesses: [],
  }),
  daemon_state: () => "ready",
  list_sessions: () => summaries(),
  get_session: (a) => state.sessions.get(String(a?.id ?? a?.sessionId))?.full ?? null,
  review_sessions_list: () => [],
  get_run_state: (a) => state.sessions.get(String(a?.sessionId))?.summary.runState ?? null,
  list_orchestrations: () => {
    const run = state.scenario?.run;
    if (!run) return [];
    return [{
      planSessionId: run.sessionId,
      claudeSessionId: `${run.sessionId}-build`,
      transcriptPath: `${HOME}/.claude/projects/build.jsonl`,
      cwd: state.sessions.get(run.sessionId)?.full.projectPath ?? null,
      startedAt: clock.now - 40 * 60_000,
      runId: "run-qa-1",
      transcriptDir: null,
      scriptPath: null,
      mode: "workflow",
      terminalId: run.terminalId,
      runState: "running",
    }];
  },
  orchestration_snapshot: () => runSnapshot(),
  home_dir: () => HOME,
  resume_startup_cwd: () => HOME,

  // Readiness: everything installed and signed in.
  preflight_status: () => READY_PREFLIGHT(),
  hook_status: () => READY_PREFLIGHT().hook,
  skill_status: () => READY_PREFLIGHT().skill,
  model_catalog_snapshot: (a) => ({
    models: a?.backend === "claude-code" ? CLAUDE_MODELS : [],
    checkedAt: clock.now - 60_000,
    source: a?.backend === "claude-code" ? "harness" : "unavailable",
    warning: null,
  }),
  codex_model_catalog: () => [],
  list_harnesses: () => [],
  get_ui_prefs: () => ({ theme: null, font: null, lint: null, workspaceNudge: null }),
  set_ui_pref: () => null,
  get_agent_seats: () => ({ seats: {} }),
  fork_thread_model: () => [null, null],

  // Chats.
  companion_list: () =>
    (state.scenario?.chats ?? []).map((c) => ({ ...c, status: "active" })),
  companion_get_thread: () => [],

  // Terminals.
  pty_list: () =>
    [...state.ptys.values()].map((p, i) => ({ id: p.id, cwd: p.cwd, pid: 4200 + i, alive: true })),
  pty_is_live: (a) => state.ptys.has(String(a?.id)),
  pty_spawn: (a) => {
    const pty = ptyFor(String(a?.id), (a?.cwd as string | null) ?? null);
    pty.channel = a?.onOutput as Channel<ArrayBuffer>;
    // The initial replay frame (empty for a fresh shell), then the prompt.
    pty.channel.onmessage(new ArrayBuffer(0));
    setTimeout(() => send(pty, `\u001b[2m${(pty.cwd ?? HOME).replace(HOME, "~")}\u001b[0m ❯ `), 20);
    return null;
  },
  pty_attach: (a) => {
    const pty = ptyFor(String(a?.id));
    pty.channel = a?.onOutput as Channel<ArrayBuffer>;
    const seed = seededTerminal(pty.id);
    const screen = seed?.screen ?? "";
    pty.channel.onmessage(encoder.encode(screen).buffer as ArrayBuffer);
    return null;
  },
  pty_detach: () => null,
  pty_ack: () => null,
  pty_resize: () => null,
  pty_kill: (a) => {
    state.ptys.delete(String(a?.id));
    return null;
  },
  pty_kill_all: () => null,
  pty_write: (a) => writePty(a),
  pty_write_checked: (a) => writePty(a),
  pty_cwd: (a) => state.ptys.get(String(a?.id))?.cwd ?? null,
  pty_cwds: (a) =>
    Object.fromEntries(((a?.ids as string[]) ?? []).map((id) => [id, state.ptys.get(id)?.cwd ?? HOME])),
  pty_procs: () =>
    [...state.ptys.values()].map((p) => ({
      id: p.id,
      fgComm: p.launched || seededTerminal(p.id)?.sessionId ? "claude" : "zsh",
      fgIsShell: !(p.launched || seededTerminal(p.id)?.sessionId),
      ports: [],
    })),
  term_attention_snapshot: () => [...state.attention.values()],

  // The conversation mirror (src/components/agent/convo/api.ts).
  convo_subscribe: (a) => {
    const terminalId = String(a?.terminalId);
    const channel = a?.onBatch as Channel<ConvoBatch>;
    const subscriptionId = `sub-${++state.subSeq}`;
    state.convoSubs.set(terminalId, { subscriptionId, channel });
    return { subscriptionId, events: state.convo.get(terminalId) ?? [], hasOlder: false };
  },
  convo_unsubscribe: (a) => {
    const sub = state.convoSubs.get(String(a?.terminalId));
    if (sub?.subscriptionId === a?.subscriptionId) state.convoSubs.delete(String(a?.terminalId));
    return null;
  },
  convo_page: () => ({ events: [], hasOlder: false }),
  convo_expect: () => null,
  pty_submit: (a) => {
    ptyFor(String(a?.terminalId)).input.push(String(a?.text ?? ""));
    return { status: "sent" };
  },
  pty_interrupt: () => null,
  convo_answer_ask: () => null,
  convo_set_mode: () => ({ status: "sent" }),
  convo_set_model: () => ({ status: "sent" }),

  // The row menu's actions (Wave A commands) change what the next read
  // returns, so a drive that renames or archives sees the result.
  rename_session: (a) => {
    const s = state.sessions.get(String(a?.sessionId));
    if (s) s.summary.titleOverride = (a?.title as string) || null;
    return null;
  },
  archive_session: (a) => {
    const s = state.sessions.get(String(a?.sessionId));
    if (s) s.summary.archivedAt = a?.archived ? clock.now : null;
    return null;
  },
  delete_session: (a) => state.sessions.delete(String(a?.sessionId)),
  archive_companion: () => null,

  // Launches record and succeed.
  record_plan_launch: () => null,
  set_interception_mode: () => null,
  surface_set_active: () => null,
  show_main_window: () => null,

  // Memory's freshness (the Tools menu's "Memory 2h ago").
  memory_status: () => ({
    live: true,
    itemCount: 1240,
    backlog: 0,
    lastOrganizedTs: state.scenario?.memoryAt ?? null,
    lastOrganizedSummary: null,
    chainOk: true,
    compactedCount: 0,
    reclaimedBytes: 0,
    lastCompactionTs: null,
    queuedProposals: 0,
  }),
  work_ready_count: () => 0,

  // Hook health: nothing else claims the plan hook.
  scan_hook_conflicts: () => ({ conflicts: [], errors: [], inactivePlugins: [] }),
  watch_hook_conflicts: () => "qa-watch-1",
  unwatch_hook_conflicts: () => null,
  reduced_transparency: () => false,

  // The drafter's shelf and the share relay: empty, as on a fresh profile.
  bookshelf_list: () => ({ folders: [], drafts: [] }),
  drafter_get_doc: () => ({ docJson: null, docMarkdown: "", projectPath: null, updatedAt: 0 }),
  get_relay_config: () => ({ displayName: "Imani", signaling: [] }),
  get_collab_requests: () => "[]",
  // A repo has no logo file: the dock draws its generated mark.
  repo_icon: (a) => {
    const cwd = String(a?.cwd ?? HOME);
    return { root: cwd, name: cwd.split("/").filter(Boolean).pop() ?? cwd, dataUrl: null };
  },
  // The file tree of a session's repo: a plausible top level.
  list_dir: (a) => {
    const dir = String(a?.path ?? HOME);
    return ["docs", "src", "README.md", "package.json"].map((name) => ({ name, path: `${dir}/${name}`, isDir: !name.includes(".") }));
  },
  watch_dir: () => null,
  unwatch_dir: () => null,
  activation_status: () => ({ verifying: false, gated: false, gatedMessage: "", runningRelease: null, lastReport: null }),
  set_attention_badge: () => null,
  browser_workspace_write: (a) => ({ ...(a?.value as object), revision: Number(a?.expectedRevision ?? 0) + 1 }),
  // The review loop, enough of it to use by hand: each command changes the
  // session and announces it, as the backend does, so App reloads it.
  accept_resolution: (a) => editComment(a, (c) => ({ ...c, status: "accepted", resolution: { ...(c.resolution as object), acceptedAt: Date.now() } })),
  reopen_resolution: (a) =>
    editComment(a, (c) => ({ ...c, status: "reopened", reopenNote: (a?.note as string | null) ?? null, ...(a?.asChange ? { actionable: true } : {}) })),
  update_comment: (a) => editComment(a, (c) => ({ ...c, ...(a?.update as object) })),
  delete_comment: (a) => editComment(a, () => null),
  add_comment: (a) => addComment(a),
};

type FixtureComment = Record<string, unknown> & { id: string };

/** Replace one comment (null removes it) wherever it lives in the session,
 *  without mutating what App already holds, and announce the change. */
function editComment(a: Args, next: (c: FixtureComment) => FixtureComment | null): null {
  const sessionId = String(a?.sessionId);
  const s = state.sessions.get(sessionId);
  if (!s) return null;
  const id = String(a?.commentId);
  s.full = {
    ...s.full,
    revisions: s.full.revisions.map((r) => ({
      ...r,
      comments: (r.comments as FixtureComment[]).flatMap((c) => (c.id === id ? [next(c)].filter((x): x is FixtureComment => !!x) : [c])),
    })),
  };
  queueMicrotask(() => dispatch("comments-changed", { sessionId }));
  return null;
}

let fixtureCommentSeq = 100;
function addComment(a: Args): FixtureComment | null {
  const sessionId = String(a?.sessionId);
  const s = state.sessions.get(sessionId);
  if (!s) return null;
  const comment: FixtureComment = { ...(a?.request as object), id: `c-${++fixtureCommentSeq}`, status: "draft", createdAt: Date.now() };
  const last = s.full.revisions.length - 1;
  s.full = {
    ...s.full,
    revisions: s.full.revisions.map((r, i) => (i === last ? { ...r, comments: [...(r.comments as FixtureComment[]), comment] } : r)),
  };
  queueMicrotask(() => dispatch("comments-changed", { sessionId }));
  return comment;
}

/** Commands whose default answer (`null` / `[]`) IS the right answer for a
 *  fresh profile: handled, so the unmocked report lists only real gaps. */
for (const cmd of [
  "record_render_crash",
  "bookshelf_touch_draft",
  "bookshelf_migrate_local",
  "browser_workspace_read",
  "mission_list",
  "draft_source_list",
  "scaled_pending",
  "self_develop_list",
  "classmem_tree",
]) {
  handlers[cmd] ??= () => defaultFor(cmd);
}

function writePty(a: Args): null {
  const pty = ptyFor(String(a?.id));
  const data = String(a?.data ?? "");
  pty.input.push(data);
  // The tty echoes what was typed; a launch command starts the agent.
  send(pty, data.replace(/\r/g, "\r\n"));
  if (/\bclaude\b/.test(data) && data.includes("\r")) startLaunch(pty);
  return null;
}

export async function invoke<T = unknown>(cmd: string, args?: Args): Promise<T> {
  record(cmd, args);
  const handler = state.overrides.get(cmd) ?? handlers[cmd];
  if (!handler) {
    const seen = state.unmocked.get(cmd);
    if (seen) seen.count += 1;
    else state.unmocked.set(cmd, { count: 1, firstArgs: summarizeArgs(args) });
    return defaultFor(cmd) as T;
  }
  return (await handler(args)) as T;
}

// ── Scenario install + the script's handle ─────────────────────────────────

export function installScenario(scenario: Scenario): void {
  state.scenario = scenario;
  clock.now = scenario.now;
  for (const seed of scenario.sessions) state.sessions.set(seed.sessionId, buildSession(seed));
  for (const t of scenario.terminals) {
    const pty = ptyFor(t.id, t.cwd);
    pty.sessionId = t.sessionId ?? null;
    if (t.convo) state.convo.set(t.id, t.convo);
    if (t.attention) {
      state.attention.set(t.id, { terminalId: t.id, sessionId: t.sessionId ?? null, at: t.attentionAt ?? scenario.now, ...t.attention });
    }
    const summary = t.sessionId ? state.sessions.get(t.sessionId)?.summary : undefined;
    if (summary?.held) summary.heldTerminalId = t.id;
  }
}

export interface QaHandle {
  scenario: () => Scenario | null;
  emit: (event: string, payload: unknown) => void;
  /** Feed a terminal's conversation subscription a batch. */
  convoPush: (terminalId: string, events: ConvoEvent[], reset?: boolean) => boolean;
  /** Write bytes to a terminal's screen. */
  ptyOutput: (terminalId: string, text: string) => boolean;
  /** Replace or add a command handler from the script. */
  handle: (cmd: string, answer: unknown) => void;
  advance: (ms: number) => number;
  calls: () => { cmd: string; args: unknown; at: number }[];
  unmocked: () => { cmd: string; count: number; firstArgs: unknown }[];
  terminals: () => { id: string; cwd: string | null; launched: boolean; sessionId: string | null; input: string[]; subscribed: boolean }[];
  listening: () => string[];
}

export const qa: QaHandle = {
  scenario: () => state.scenario,
  emit: (event, payload) => dispatch(event, payload),
  convoPush: (terminalId, events, reset = false) => {
    state.convo.set(terminalId, reset ? events : [...(state.convo.get(terminalId) ?? []), ...events]);
    const sub = state.convoSubs.get(terminalId);
    if (!sub) return false;
    sub.channel.onmessage({ events, ...(reset ? { reset: true } : {}) });
    return true;
  },
  ptyOutput: (terminalId, text) => {
    const pty = state.ptys.get(terminalId);
    if (!pty?.channel) return false;
    send(pty, text);
    return true;
  },
  handle: (cmd, answer) => {
    state.overrides.set(cmd, () => answer);
  },
  advance: (ms) => (clock.now += ms),
  calls: () => state.calls,
  unmocked: () => [...state.unmocked].map(([cmd, v]) => ({ cmd, ...v })),
  terminals: () =>
    [...state.ptys.values()].map((p) => ({
      id: p.id,
      cwd: p.cwd,
      launched: p.launched,
      sessionId: p.sessionId,
      input: p.input,
      subscribed: state.convoSubs.has(p.id),
    })),
  listening: () => [...state.listeners].filter(([, s]) => s.size).map(([name]) => name),
};
