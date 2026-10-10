// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! A reply's steps line: the tools its turn used, folded to one line above
//! the text (`ReplyBlock`), and the list it expands to.
//!
//! The steps are the turn's `tool` activity, kept with the row's meter when
//! the turn settles — by the reducer from the live ring, and by
//! `meter::settle` into the stored meter — so the list a reply expands to is
//! the same before and after a relaunch.
//!
//! The fold only ever hides LOOKING: a run of reads and searches becomes one
//! "Explored" row. A tool that did something stays a row of its own, and
//! nothing that is not a tool step is in the list at all — offers, "Continue
//! as…", receipts and code live in the reply itself, never behind this fold.

import { formatDuration, type Activity, type TurnMeter } from "./turnMeter";

/** Steps kept per reply — the same cap `meter::settle` keeps (`STEPS_KEEP`),
 *  and the live ring's (`ACTIVITY_KEEP`), so neither side keeps more. */
export const STEPS_KEEP = 40;

/** The turn's tool calls, oldest first, newest `STEPS_KEEP`. */
export function toolSteps(activity: readonly Activity[] | null | undefined): Activity[] {
  return (activity ?? []).filter((entry) => entry.kind === "tool").slice(-STEPS_KEEP);
}

/** The tool's own name from a step label: `Grep(seat_burn)` and `Grep…` are
 *  both "Grep"; a phrase ("searching your memory…") is the phrase. */
function stepName(label: string): string {
  return label.replace(/[…(].*$/s, "").trim();
}

const SEARCH = new Set(["Grep", "Glob", "WebSearch", "ToolSearch"]);
const READ = new Set(["Read", "LS", "NotebookRead", "WebFetch"]);

/** "search", "read", or null for a step that acted. The bridge's retrieval
 *  phrases (`claude_proc::retrieval_status_label`) read as their verb says. */
function looks(label: string): "search" | "read" | null {
  const name = stepName(label);
  if (SEARCH.has(name) || /^searching\b/.test(name)) return "search";
  if (READ.has(name) || /^(reading|fetching|opening|following|counting)\b/.test(name)) return "read";
  return null;
}

export interface StepRow {
  label: string;
  /** The folded steps' own labels, for the row's tooltip. */
  folded?: string[];
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The expanded list: each run of reads and searches folded into one
 *  "Explored" row, every other step as it was labelled. */
export function foldSteps(steps: readonly Activity[]): StepRow[] {
  const rows: StepRow[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const searches = run.filter((label) => looks(label) === "search").length;
    const reads = run.length - searches;
    const parts = [reads ? count(reads, "read", "reads") : "", searches ? count(searches, "search", "searches") : ""];
    rows.push({ label: `Explored · ${parts.filter(Boolean).join(", ")}`, folded: run });
    run = [];
  };
  for (const step of steps) {
    if (looks(step.label)) run.push(step.label);
    else {
      flush();
      rows.push({ label: step.label });
    }
  }
  flush();
  return rows;
}

/** Whether a reply has a steps line. One condition for both phases — the
 *  live turn's meter and the settled row's are the same meter at the swap —
 *  so the line never arrives or leaves when the reply settles. */
export function hasSteps(meter: TurnMeter | null | undefined): boolean {
  return (meter?.toolCalls ?? 0) > 0;
}

/** The steps line's text: what it is doing now while live ("Used 2 tools ·
 *  Grep(seat_burn)"), what it took once settled ("Used 2 tools · 12.4s"). */
export function stepsLabel(
  phase: "live" | "settled",
  meter: TurnMeter,
  activity?: readonly Activity[] | null,
): string {
  const used = `Used ${count(meter.toolCalls, "tool", "tools")}`;
  const detail =
    phase === "live"
      ? (toolSteps(activity).pop()?.label ?? meter.lastToolLabel)
      : formatDuration(meter.durationMs);
  return detail ? `${used} · ${detail}` : used;
}
