// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// How a page-chat turn is drawn: the context the user's card carries, the
// reply's work rows, the one live line, and when the thread follows. Pure.
// BrowserChat renders these; nothing in it reads an activity label or a
// message body to decide what a step or a chip is.
//
// Rule ids (BC-n) are catalogued in invariants.ts.

import type { Activity } from "../turnMeter";
import contract from "./contract.json";

// --- work rows --------------------------------------------------------------

/** What a step did: looked (read, search), changed something (act), or asked
 *  another agent (consult). Only looking folds (BC-34). */
export type WorkKind = "read" | "search" | "act" | "consult";

/** What "Explored N …" counts a look as. */
type Unit = "page" | "file" | "search" | "lookup";

/** One step as a row: a verb and its object, the way the reply reads them. */
export interface WorkStep {
  kind: WorkKind;
  /** Past tense, read at weight 500: "Read", "Clicked", "Stopped —". */
  verb: string;
  /** What it was done to, read at weight 400: "the page", "“Buy” · tab 2". */
  object: string;
  /** A page action that did not happen as asked. */
  failed?: true;
  unit?: Unit;
}

export type WorkRow =
  | { kind: "step"; step: WorkStep }
  /** A run of two or more looks, folded: "Explored 3 pages, 2 searches". */
  | { kind: "explored"; object: string; steps: WorkStep[] };

/** The bridge's activity phrases (`claude_proc::retrieval_status_label`),
 *  by their leading words, as the row's past tense. Longest first where one
 *  phrase starts another ("checking in with" before "checking"). */
const PHRASES: readonly [string, WorkKind, string][] = [
  ["checking in with", "consult", "Checked in with"],
  ["looking over", "read", "Looked over"],
  ["checking", "read", "Checked"],
  ["reading", "read", "Read"],
  ["extracting from", "read", "Extracted from"],
  ["fetching", "read", "Fetched"],
  ["finding", "read", "Found"],
  ["mapping", "read", "Mapped"],
  ["loading", "read", "Loaded"],
  ["following", "read", "Followed"],
  ["counting", "read", "Counted"],
  ["searching", "search", "Searched"],
  ["acting on", "act", "Acted on"],
  ["navigating", "act", "Navigated"],
  ["clicking", "act", "Clicked"],
  ["typing into", "act", "Typed into"],
  ["pressing", "act", "Pressed"],
  ["scrolling", "act", "Scrolled"],
  ["choosing", "act", "Chose"],
  ["waiting for", "act", "Waited for"],
  ["opening", "act", "Opened"],
  ["switching to", "act", "Switched to"],
  ["switching", "act", "Switched"],
  ["saving", "act", "Saved"],
];

/** A tool named by the CLI rather than narrated by the bridge ("Read…",
 *  "Grep(seat_burn)"): its kind, past tense, and object when the label
 *  carries no argument. */
const TOOLS: Record<string, [WorkKind, string, string, Unit?]> = {
  Read: ["read", "Read", "a file", "file"],
  LS: ["read", "Listed", "a folder", "file"],
  NotebookRead: ["read", "Read", "a notebook", "file"],
  Grep: ["search", "Searched", "files"],
  Glob: ["search", "Found", "files"],
  ToolSearch: ["search", "Looked up", "tools"],
  WebSearch: ["search", "Searched the web", ""],
  WebFetch: ["read", "Fetched", "a page", "page"],
  Bash: ["act", "Ran", "a command"],
};

/** The page action's own acknowledgement, written onto the turn by the
 *  backend once the action has an outcome (`browser_actions::outcome_step`):
 *  "Clicked “Buy” · tab 2", "Click failed — Target is not actionable",
 *  "Stopped — you took over the page · tab 2". */
const DONE: Record<string, string> = contract.actionOutcomes.done;
const STOPPED = contract.actionOutcomes.tookOver.split(" — ")[0];
const OUTCOME_VERBS = [...Object.values(DONE), STOPPED];
/** The bridge's phrases for the call that asks for a page action, which its
 *  outcome replaces. */
const ACTION_CALLS = new Set<string>([...Object.values(contract.actionLabels), contract.activityLabels["/v1/browser/action"]]);

function outcome(label: string): WorkStep | null {
  const failed = label.match(/^(\w+) failed — (.*)$/s);
  if (failed && failed[1].toLowerCase() in DONE) return { kind: "act", verb: `${failed[1]} failed —`, object: failed[2], failed: true };
  const verb = OUTCOME_VERBS.find((v) => label.startsWith(`${v} `));
  if (!verb) return null;
  const object = label.slice(verb.length + 1);
  // "Stopped — …" keeps its dash with the verb, so the object reads on its own.
  return object.startsWith("— ") ? { kind: "act", verb: `${verb} —`, object: object.slice(2), failed: true } : { kind: "act", verb, object };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What a look counts as when folded. */
function unitOf(kind: WorkKind, object: string): Unit | undefined {
  if (kind === "search") return "search";
  if (kind !== "read") return undefined;
  return /\bpage\b|^tab \d+$/.test(object) ? "page" : "lookup";
}

/** One activity label as a row. Every phrase the bridge writes has a verb
 *  here (pinned against contract.json); anything else reads as itself. */
export function classifyStep(label: string): WorkStep {
  const done = outcome(label);
  if (done) return done;
  const phrase = label.replace(/…$/, "").trim();
  const lower = phrase.toLowerCase();
  for (const [lead, kind, verb] of PHRASES) {
    if (lower === lead || lower.startsWith(`${lead} `)) {
      const object = phrase.slice(lead.length).trim();
      return { kind, verb, object, unit: unitOf(kind, object) };
    }
  }
  const tool = phrase.match(/^(\w+)(?:\((.*)\))?$/s);
  const known = tool && TOOLS[tool[1]];
  if (tool && known) {
    const [kind, verb, object, unit] = known;
    return { kind, verb, object: tool[2]?.trim() || object, unit: unit ?? unitOf(kind, object) };
  }
  if (tool) return { kind: "act", verb: "Used", object: tool[2] ? `${tool[1]} · ${tool[2]}` : tool[1] };
  return { kind: "act", verb: capital(phrase), object: "" };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const UNITS: readonly [Unit, string, string][] = [
  ["page", "page", "pages"],
  ["file", "file", "files"],
  ["search", "search", "searches"],
  ["lookup", "lookup", "lookups"],
];

/** "3 pages, 2 searches" for a folded run. */
function exploredObject(steps: readonly WorkStep[]): string {
  return UNITS.map(([unit, one, many]) => {
    const n = steps.filter((s) => (s.unit ?? "lookup") === unit).length;
    return n ? count(n, one, many) : "";
  }).filter(Boolean).join(", ");
}

const looks = (s: WorkStep) => s.kind === "read" || s.kind === "search";

/** A turn's steps as rows (BC-34). A page action's outcome takes the place
 *  of the call that asked for it, so one action is one row. A run of two or
 *  more reads and searches folds into one "Explored" row; an action, a
 *  consult, or a lone look stays a row of its own, and nothing that changed
 *  a page is ever folded away. */
export function workRows(steps: readonly Pick<Activity, "label">[]): WorkRow[] {
  const merged: WorkStep[] = [];
  let asked = false;
  for (const { label } of steps) {
    const done = outcome(label);
    if (done && asked) merged[merged.length - 1] = done;
    else merged.push(done ?? classifyStep(label));
    asked = !done && ACTION_CALLS.has(label);
  }
  const rows: WorkRow[] = [];
  let run: WorkStep[] = [];
  const flush = () => {
    if (run.length === 1) rows.push({ kind: "step", step: run[0] });
    else if (run.length > 1) rows.push({ kind: "explored", object: exploredObject(run), steps: run });
    run = [];
  };
  for (const step of merged) {
    if (looks(step)) run.push(step);
    else {
      flush();
      rows.push({ kind: "step", step });
    }
  }
  flush();
  return rows;
}

// --- the live line ----------------------------------------------------------

/** A page action in flight on the turn's page, from the action route's
 *  acknowledgement (`browser-action`): its kind and the tab it is on. */
export interface PageAction {
  kind: string;
  tab: number | null;
}

/** A finished step's verb, as the live line says it while it runs. */
const PRESENT: Record<string, string> = {
  Read: "Reading", Listed: "Listing", Searched: "Searching", Found: "Finding", "Looked up": "Looking up",
  "Searched the web": "Searching the web", Fetched: "Fetching", Ran: "Running", Used: "Using",
};

/** The turn's one live line names the step running now, in the present tense
 *  ("Reading the page", "Clicking · tab 2"): a page action by its kind and
 *  tab once the action route has it, any other step by its label. */
export function liveStepLabel(label: string, action: PageAction | null = null): string {
  const running = action && (contract.actionLabels as Record<string, string>)[action.kind];
  if (running) return `${capital(running.replace(/…$/, ""))}${action.tab ? ` · tab ${action.tab}` : ""}`;
  const step = classifyStep(label);
  const verb = PRESENT[step.verb];
  if (verb) return step.object ? `${verb} ${step.object}` : verb;
  return capital(label.replace(/…$/, "").trim());
}

/** Splits a live turn's tool steps into the finished ones (drawn as rows)
 *  and the one running now (drawn as the live line), so a step becomes its
 *  past-tense row only once something has come after it: another step, an
 *  outcome, a thought, or text (`wroteSince`: the reply has written more
 *  since the step was first seen). */
export function liveSteps(activity: readonly Activity[], wroteSince: (step: Activity) => boolean): { finished: Activity[]; running: Activity | null } {
  const tools = activity.filter((a) => a.kind === "tool");
  const last = activity[activity.length - 1];
  const running = last && last.kind === "tool" && !wroteSince(last) && !outcome(last.label) ? last : null;
  return { finished: running ? tools.slice(0, -1) : tools, running };
}

// --- the user's card: context that rides the message -------------------------

/** Context attached in the composer. It rides the message as text the agent
 *  reads (`body`), and the user's card shows it again as a chip, after the
 *  send and after a reload (BC-40). */
export type TurnChip =
  | { kind: "quote"; label: string; body: string }
  | { kind: "element"; label: string; body: string }
  | { kind: "screenshot" | "image"; label: string; body: string; path: string; width: number; height: number };

const ELEMENT_HEAD = "Inspect this element:";
const ATTACHMENT = /^\[(Screenshot|Image) · (.+?): (\/.+?), (\d+)×(\d+) — read the file to see it\]$/;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The line a screenshot or an image rides as: its path, so the agent can
 *  read the file, and its size, so the card reserves its box before paint. */
export function attachmentBody(kind: "screenshot" | "image", label: string, path: string, width: number, height: number): string {
  return `[${kind === "screenshot" ? "Screenshot" : "Image"} · ${label}: ${path}, ${Math.round(width)}×${Math.round(height)} — read the file to see it]`;
}

/** The message a composer sends: its chips' bodies first, then the text. */
export function composeTurn(chips: readonly TurnChip[], text: string): string {
  return [...chips.map((c) => c.body), text.trim()].filter(Boolean).join("\n\n");
}

function elementLabel(json: string): string {
  try {
    const v = JSON.parse(json) as { tag?: unknown; accessibleName?: unknown };
    const tag = typeof v.tag === "string" && v.tag ? `<${v.tag}> ` : "";
    const name = typeof v.accessibleName === "string" ? v.accessibleName.replace(/\s+/g, " ").trim() : "";
    return clip(`${tag}${name || "element"}`, 48);
  } catch {
    return "Element";
  }
}

/** A message read back into the chips it was composed from and its text —
 *  `composeTurn`'s inverse. Only LEADING context is a chip: a quote the user
 *  writes mid-message stays theirs. */
export function userTurnParts(body: string): { chips: TurnChip[]; text: string } {
  const chips: TurnChip[] = [];
  let rest = body.replace(/^\s+/, "");
  for (;;) {
    const lines = rest.split("\n");
    if (lines[0].startsWith(">")) {
      const n = lines.findIndex((l) => !l.startsWith(">"));
      const quote = lines.slice(0, n < 0 ? undefined : n);
      const passage = quote.map((l) => l.replace(/^> ?/, "")).join(" ").replace(/\s+/g, " ").trim();
      chips.push({ kind: "quote", label: clip(passage, 60), body: quote.join("\n") });
      rest = n < 0 ? "" : lines.slice(n).join("\n");
    } else if (rest.startsWith(`${ELEMENT_HEAD}\n\n\`\`\`json\n`)) {
      const end = rest.indexOf("\n```", ELEMENT_HEAD.length + 10);
      if (end < 0) break;
      const fenced = rest.slice(0, end + 4);
      chips.push({ kind: "element", label: elementLabel(fenced.slice(ELEMENT_HEAD.length + 10, end)), body: fenced });
      rest = rest.slice(end + 4);
    } else {
      const m = lines[0].match(ATTACHMENT);
      if (!m) break;
      chips.push({ kind: m[1] === "Screenshot" ? "screenshot" : "image", label: m[2], body: lines[0], path: m[3], width: Number(m[4]), height: Number(m[5]) });
      rest = lines.slice(1).join("\n");
    }
    rest = rest.replace(/^\s+/, "");
  }
  return { chips, text: rest.trim() };
}

// --- following the thread ---------------------------------------------------

/** How close to the bottom still counts as reading the end (BC-38). */
export const FOLLOW_WITHIN_PX = 48;

/** Whether the thread keeps the newest line in view: only while the reader
 *  is at the bottom. Scrolling up stops it; ↓, End or a send resumes it. */
export function follows(scroller: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_WITHIN_PX;
}

/** Where a reply the reader has been following parks once it is taller than
 *  the view: at its start, so a long answer is read from the top rather than
 *  chased to its end (BC-38). Null while it still fits, or when the reader
 *  has scrolled away themselves. */
export function parkAt(i: { following: boolean; replyTop: number; replyHeight: number; viewHeight: number; margin?: number }): number | null {
  const margin = i.margin ?? 12;
  return i.following && i.replyHeight > i.viewHeight - margin ? Math.max(0, i.replyTop - margin) : null;
}
