// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! What the conversation says about itself, in words: the working row's
//! label and timer, a tool step as a row ("Read docs/x.md"), a settled turn
//! folded to one line ("✓ Read 4 files · planned in 2m 04s"), the Plan
//! ready card's counts, and the composer's model chip. Pure — the reducer's
//! view (./reducer.ts) and the terminal's derived state in, strings out.
//!
//! **The working row, first match wins:**
//! 1. *Needs you* — an ask is open (or the terminal's own hook says so).
//! 2. *A tool verb* — "Reading docs/x.md", the step running now.
//! 3. *Writing the plan* — plan mode, and the turn has already said what it
//!    will do: the plan is one tool call the transcript shows only once it is
//!    whole, so whatever follows (a thought included) is composing it.
//! 4. *Thinking* — the newest thing the turn did was think.
//! 5. *Writing the plan* — plan mode, a turn running, no tool running and no
//!    plan proposed yet: the model is composing it.
//! 6. *Plan ready* — the latest turn proposed a plan nobody has answered.
//!
//! A running turn that matches none of these is just *Working*.

import { foldSteps, type StepRow } from "../replySteps";
import { formatDuration, type Activity } from "../turnMeter";
import type { TermState } from "../termState";
import type { ConvoMode } from "./types";
import type { ConvoView, ModelFact, Turn, TurnItem } from "./reducer";

// ── Tools in words ────────────────────────────────────────────────────────

type ToolItem = Extract<TurnItem, { kind: "tool" }>;
type PlanItem = Extract<TurnItem, { kind: "plan" }>;

/** What a tool did, by name: its verb while running and once done, what its
 *  summary names (a path, a command, a URL), and what it counts as when a
 *  settled turn folds. Codex's tool names ride along. */
interface ToolWords {
  present: string;
  past: string;
  target: "path" | "url" | "text" | "none";
  group: "read" | "search" | "edit" | "run" | "web" | "search-web" | "agent" | "other";
}

const TOOLS: Record<string, ToolWords> = {
  Read: { present: "Reading", past: "Read", target: "path", group: "read" },
  NotebookRead: { present: "Reading", past: "Read", target: "path", group: "read" },
  read_file: { present: "Reading", past: "Read", target: "path", group: "read" },
  LS: { present: "Listing", past: "Listed", target: "path", group: "read" },
  Grep: { present: "Searching", past: "Searched", target: "text", group: "search" },
  Glob: { present: "Searching", past: "Searched", target: "text", group: "search" },
  ToolSearch: { present: "Searching", past: "Searched", target: "text", group: "search" },
  Edit: { present: "Editing", past: "Edited", target: "path", group: "edit" },
  MultiEdit: { present: "Editing", past: "Edited", target: "path", group: "edit" },
  NotebookEdit: { present: "Editing", past: "Edited", target: "path", group: "edit" },
  apply_patch: { present: "Editing", past: "Edited", target: "path", group: "edit" },
  Write: { present: "Writing", past: "Wrote", target: "path", group: "edit" },
  Bash: { present: "Running", past: "Ran", target: "text", group: "run" },
  shell: { present: "Running", past: "Ran", target: "text", group: "run" },
  exec_command: { present: "Running", past: "Ran", target: "text", group: "run" },
  WebFetch: { present: "Fetching", past: "Fetched", target: "url", group: "web" },
  WebSearch: { present: "Searching the web for", past: "Searched the web for", target: "text", group: "search-web" },
  Task: { present: "Running an agent:", past: "Ran an agent:", target: "text", group: "agent" },
  Agent: { present: "Running an agent:", past: "Ran an agent:", target: "text", group: "agent" },
  TodoWrite: { present: "Updating the todo list", past: "Updated the todo list", target: "none", group: "other" },
  Skill: { present: "Using the skill", past: "Used the skill", target: "text", group: "other" },
};

/** Tools that draw something else instead of a row: the plan card and the
 *  ask card. */
const CARD_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion"]);

function isCardTool(name: string): boolean {
  return CARD_TOOLS.has(name);
}

function wordsFor(name: string): ToolWords {
  const known = TOOLS[name];
  if (known) return known;
  // An MCP tool reads as its server and tool: `mcp__github__get_issue` →
  // "github · get_issue".
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  const label = mcp ? `${mcp[1]} · ${mcp[2]}` : name;
  return { present: `Using ${label}`, past: `Used ${label}`, target: "text", group: "other" };
}

/** A path as the board shows it: inside the project, relative to it;
 *  elsewhere under a home folder, from `~`. */
export function displayPath(path: string, projectPath?: string | null): string {
  const p = path.trim().replace(/(.)\/+$/, "$1");
  if (projectPath) {
    const root = projectPath.replace(/\/+$/, "");
    if (p === root) return ".";
    if (p.startsWith(root + "/")) return p.slice(root.length + 1);
  }
  return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** A URL without its scheme or `www.`, and without a trailing slash. */
export function displayUrl(url: string): string {
  return url.trim().replace(/^[a-z]+:\/\//i, "").replace(/^www\./, "").replace(/\/$/, "");
}

/** One line of a summary: the first line, whitespace collapsed. */
function oneLine(text: string): string {
  return text.split("\n").find((line) => line.trim())?.replace(/\s+/g, " ").trim() ?? "";
}

export interface ToolPhrase {
  verb: string;
  /** What it acted on, or "" when the verb says it all. */
  target: string;
}

export function toolPhrase(
  name: string,
  summary: string,
  tense: "present" | "past",
  projectPath?: string | null,
): ToolPhrase {
  const words = wordsFor(name);
  const verb = tense === "present" ? words.present : words.past;
  if (words.target === "none") return { verb, target: "" };
  const line = oneLine(summary);
  const target = words.target === "path" ? displayPath(line, projectPath) : words.target === "url" ? displayUrl(line) : line;
  return { verb, target };
}

/** One row of a turn's finished tools, as 4b draws them: "Read
 *  `docs/obsidian/build-log.md`", and a long run of looking folded to its
 *  first and newest — "Read `docs/obsidian/28 Roadmap.md` and 2 more". */
export interface ToolRow {
  id: string;
  verb: string;
  target: string;
  /** How many more steps this row stands for. */
  more: number;
  status: "done" | "error" | "stopped";
  /** Every step the row stands for, for its tooltip. */
  steps: string[];
}

/** The finished tool steps of `items` as rows. Which steps fold is
 *  `replySteps.foldSteps`' call — the same rule the chat surfaces' steps
 *  line uses: only LOOKING (reads, searches) ever folds; a step that did
 *  something is always a row of its own, and so is a failed one. A step
 *  still running isn't a row: the working row is saying it. */
export function toolRows(
  items: readonly TurnItem[],
  options: { projectPath?: string | null; ended?: boolean } = {},
): ToolRow[] {
  const tools = items.filter(
    (item): item is ToolItem =>
      item.kind === "tool" && !isCardTool(item.name) && (item.status !== "running" || !!options.ended),
  );
  const activity: Activity[] = tools.map((tool) => ({ at: tool.at, kind: "tool", label: `${tool.name}(${tool.summary})` }));
  const row = (tool: ToolItem, more = 0, steps: ToolItem[] = [tool]): ToolRow => {
    const phrase = toolPhrase(tool.name, tool.summary, "past", options.projectPath);
    return {
      id: tool.id,
      ...phrase,
      more,
      status: tool.status === "running" ? "stopped" : tool.status,
      steps: steps.map((step) => {
        const p = toolPhrase(step.name, step.summary, "past", options.projectPath);
        return p.target ? `${p.verb} ${p.target}` : p.verb;
      }),
    };
  };
  const rows: ToolRow[] = [];
  let at = 0;
  for (const step of foldSteps(activity) as StepRow[]) {
    const run = tools.slice(at, at + (step.folded?.length ?? 1));
    at += run.length;
    if (run.length <= 2 || run.some((tool) => tool.status !== "done")) for (const tool of run) rows.push(row(tool));
    else rows.push(row(run[0]), row(run[run.length - 1], run.length - 2, run.slice(1)));
  }
  return rows;
}

// ── Settled turns ─────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Read 4 files", "Read 4 files, ran 2 searches", … — what a run of tool
 *  steps added up to, in the order each kind first appeared. Files count
 *  once however often they were touched. */
export function stepsSummary(items: readonly TurnItem[]): string | null {
  const groups = new Map<ToolWords["group"], { calls: number; targets: Set<string> }>();
  for (const item of items) {
    if (item.kind !== "tool" || isCardTool(item.name)) continue;
    const group = wordsFor(item.name).group;
    const entry = groups.get(group) ?? { calls: 0, targets: new Set<string>() };
    entry.calls++;
    entry.targets.add(oneLine(item.summary));
    groups.set(group, entry);
  }
  const phrase = (group: ToolWords["group"], { calls, targets }: { calls: number; targets: Set<string> }) => {
    switch (group) {
      case "read":
        return `read ${plural(targets.size, "file", "files")}`;
      case "edit":
        return `edited ${plural(targets.size, "file", "files")}`;
      case "search":
        return `ran ${plural(calls, "search", "searches")}`;
      case "run":
        return `ran ${plural(calls, "command", "commands")}`;
      case "web":
        return `fetched ${plural(calls, "page", "pages")}`;
      case "search-web":
        return calls === 1 ? "searched the web" : `searched the web ${calls} times`;
      case "agent":
        return `ran ${plural(calls, "agent", "agents")}`;
      default:
        return `used ${plural(calls, "tool", "tools")}`;
    }
  };
  const entries = [...groups.entries()];
  if (entries.length === 0) return null;
  const shown = entries.slice(0, 3).map(([group, entry]) => phrase(group, entry));
  const rest = entries.slice(3).reduce((n, [, entry]) => n + entry.calls, 0);
  const text = shown.join(", ") + (rest ? `, and ${plural(rest, "more step", "more steps")}` : "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A stretch of a turn that folds as one: up to and including a plan it
 *  proposed, or from there to the turn's end. */
export interface Segment {
  id: string;
  /** The plan proposal that closes it, when one does. */
  plan: PlanItem | null;
  /** Folded: its plan is in, or its turn is over. */
  settled: boolean;
  /** What stays drawn: everything while it runs; once settled, a final
   *  answer's prose, and markers. */
  shown: TurnItem[];
  /** What the summary line stands for (and expands to). */
  folded: TurnItem[];
  /** "Read 4 files · planned in 2m 04s", when anything folded. */
  summary: string | null;
}

/** A turn cut at each plan it proposed. Settled, a stretch that ended in a
 *  plan folds whole — its reads and its narration were the way to the plan,
 *  and the plan card is what is left to read. A final stretch keeps its
 *  prose (the answer) and folds only the steps it took. */
export function turnSegments(turn: Turn): Segment[] {
  const segments: Segment[] = [];
  let items: TurnItem[] = [];
  let from = turn.startedAt;
  const push = (plan: PlanItem | null) => {
    const settled = plan !== null || turn.ended;
    const folds = (item: TurnItem) =>
      settled &&
      (plan !== null
        ? item.kind !== "compact" && !(item.kind === "ask" && item.outcome === null)
        : item.kind === "tool" || item.kind === "thinking" || (item.kind === "ask" && item.outcome !== null));
    const folded = items.filter(folds);
    const shown = items.filter((item) => !folds(item));
    const steps = stepsSummary(folded);
    let summary: string | null = null;
    if (plan) {
      const took = formatDuration(Math.max(0, plan.at - from));
      summary = steps ? `${steps} · planned in ${took}` : `Planned in ${took}`;
    } else if (settled && steps) {
      const end = turn.endedAt ?? from;
      const took = formatDuration(segments.length === 0 && turn.durationMs != null ? turn.durationMs : Math.max(0, end - from));
      summary = `${steps} · ${turn.interrupted ? `stopped after ${took}` : took}`;
    }
    segments.push({ id: `${turn.id}:${segments.length}`, plan, settled, shown, folded, summary });
    items = [];
  };
  for (const item of turn.items) {
    if (item.kind === "plan") {
      push(item);
      from = item.at;
    } else items.push(item);
  }
  if (items.length || segments.length === 0) push(null);
  return segments;
}

// ── The working row ───────────────────────────────────────────────────────

export type WorkingKind = "needs-you" | "tool" | "thinking" | "writing-plan" | "plan-ready" | "working";

export interface WorkingStatus {
  kind: WorkingKind;
  label: string;
  /** When the timer counts from: the running turn's start. Null when
   *  nothing is running (plan ready, an ask outside a turn). */
  since: number | null;
}

/** The step running now: the newest tool in the turn with no result yet,
 *  unless the turn has said something since. */
function runningTool(turn: Turn): ToolItem | null {
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const item = turn.items[i];
    if (item.kind === "ask") continue;
    if (item.kind === "tool" && item.status === "running") return isCardTool(item.name) ? null : item;
    if (item.kind === "tool") continue;
    return null;
  }
  return null;
}

/** A plan proposed in `turn` that nobody has answered: the turn is held on
 *  its review. */
function waitingPlan(turn: Turn | null): PlanItem | null {
  if (!turn) return null;
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const item = turn.items[i];
    if (item.kind === "plan") return item.plan.outcome === null ? item : null;
  }
  return null;
}

export function workingStatus(
  view: Pick<ConvoView, "openAsks" | "activeTurn" | "lastTurn" | "mode">,
  options: { term?: TermState | null; projectPath?: string | null } = {},
): WorkingStatus | null {
  const turn = view.activeTurn;
  const since = turn?.startedAt ?? null;
  if (view.openAsks.length > 0 || options.term === "needs-you") return { kind: "needs-you", label: "Needs you", since };
  const held = waitingPlan(view.lastTurn);
  if (turn && !held) {
    const tool = runningTool(turn);
    if (tool) {
      const phrase = toolPhrase(tool.name, tool.summary, "present", options.projectPath);
      return { kind: "tool", label: phrase.target ? `${phrase.verb} ${phrase.target}` : phrase.verb, since };
    }
    // In plan mode the plan is one tool call the transcript only shows once
    // it is whole, so after the turn has said what it will do, the model is
    // composing it — a thought between there and the plan is part of that.
    const said = turn.items.some((item) => item.kind === "prose");
    if (view.mode === "plan" && said) return { kind: "writing-plan", label: "Writing the plan", since };
    if (turn.items[turn.items.length - 1]?.kind === "thinking") return { kind: "thinking", label: "Thinking", since };
    if (view.mode === "plan") return { kind: "writing-plan", label: "Writing the plan", since };
  }
  if (held) return { kind: "plan-ready", label: "Plan ready", since: null };
  if (turn || options.term === "working") return { kind: "working", label: "Working", since };
  return null;
}

/** The working row's faint timer: "12s", "1m 12s", "1h 04m". Whole
 *  seconds — a tenth that ticks reads as jitter. */
export function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return formatDuration(secs * 1000) ?? `${secs}s`;
  const h = Math.floor(secs / 3600);
  return `${h}h ${String(Math.floor((secs % 3600) / 60)).padStart(2, "0")}m`;
}

// ── The plan card ─────────────────────────────────────────────────────────

/** Sections and steps in a plan's markdown, for "3 sections · 11 steps".
 *  Sections are its `##` headings (its `###` when it has none); steps are
 *  its top-level list items. Code fences are skipped. Null when it has
 *  neither — the card then says only what to do. */
export function planStats(markdown: string | null | undefined): { sections: number; steps: number } | null {
  if (!markdown) return null;
  let fence: string | null = null;
  let h2 = 0;
  let h3 = 0;
  let steps = 0;
  for (const line of markdown.split("\n")) {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (!fence) fence = open[1][0];
      else if (open[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^##\s+\S/.test(line)) h2++;
    else if (/^###\s+\S/.test(line)) h3++;
    else if (/^ {0,3}(?:\d+[.)]|[-*+])\s+\S/.test(line)) steps++;
  }
  const sections = h2 || h3;
  return sections || steps ? { sections, steps } : null;
}

export function planStatsLabel(stats: { sections: number; steps: number } | null): string | null {
  if (!stats) return null;
  const parts = [stats.sections ? plural(stats.sections, "section", "sections") : "", stats.steps ? plural(stats.steps, "step", "steps") : ""];
  return parts.filter(Boolean).join(" · ") || null;
}

// ── The composer's chips ──────────────────────────────────────────────────

/** A model id as people say it: `claude-opus-4-5-20251101` → "Opus 4.5",
 *  `claude-3-5-haiku-20241022` → "Haiku 3.5", `gpt-5.1-codex` →
 *  "GPT-5.1-Codex". The live catalog's own display name wins when it lists
 *  this exact id. */
export function modelDisplayName(
  model: string,
  catalog?: readonly { slug: string; displayName: string }[] | null,
): string {
  const listed = catalog?.find((entry) => entry.slug === model);
  if (listed) return listed.displayName;
  const id = model.trim().replace(/\[1m\]$/i, "").replace(/-20\d{6}$/, "");
  const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  const claude = id.replace(/^claude-/, "");
  if (claude !== id) {
    const newer = /^([a-z]+)-(\d+)(?:-(\d+))?/.exec(claude);
    if (newer) return `${cap(newer[1])} ${newer[2]}${newer[3] ? `.${newer[3]}` : ""}`;
    const older = /^(\d+)(?:-(\d+))?-([a-z]+)/.exec(claude);
    if (older) return `${cap(older[3])} ${older[1]}${older[2] ? `.${older[2]}` : ""}`;
    return cap(claude);
  }
  if (/^gpt-/i.test(id)) return id.split("-").map((part, i) => (i === 0 ? "GPT" : cap(part))).join("-");
  // A bare family alias from a launch flag (`opus`, `sonnet`) before the
  // catalog has answered.
  if (/^[a-z]+$/.test(id)) return cap(id);
  return id;
}

/** An effort level as the Front Door's notches say it. */
export function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** The model chip: "Opus 4.5 · High"; with the harness in front when more
 *  than one is installed ("Codex · GPT-5.1-Codex · Medium"). Before the CLI
 *  has said which model answered, just the harness. */
export function modelChipLabel(
  fact: ModelFact | null,
  options: {
    harness: "claude" | "codex";
    showHarness: boolean;
    catalog?: readonly { slug: string; displayName: string }[] | null;
  },
): string {
  const harness = options.harness === "codex" ? "Codex" : "Claude";
  if (!fact) return harness;
  const parts = [modelDisplayName(fact.model, options.catalog)];
  if (fact.effort) parts.push(effortLabel(fact.effort));
  if (options.showHarness) parts.unshift(harness);
  return parts.join(" · ");
}

/** The mode chip's word. */
export function modeLabel(mode: ConvoMode | null): string {
  switch (mode) {
    case "plan":
      return "Plan";
    case "default":
      return "Default";
    case "acceptEdits":
      return "Accept edits";
    case "bypassPermissions":
      return "Bypass permissions";
    case null:
      return "Mode";
    default:
      return mode;
  }
}
