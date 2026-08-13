// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The front door's pure core: what a keystroke means, where a prompt should
// launch, how attachments ride along, and the slug proposed to a first-run
// user who has no project at all. House style — every decision the surface
// makes lives here so it can be tested without a DOM; FrontDoor.tsx only
// renders and App.tsx only wires.

import type { ProjectOption } from "../components/ProjectPicker";
import { guessProjectForPlan } from "./guessProject";

/** Where the composer sends its text. A sticky setting, not a one-off: you
 *  pick it in `Plan ▾` and it stays picked, so a session spent shaping long
 *  briefs doesn't mean reaching for a modifier on every one. */
export type LaunchDestination = "plan" | "drafter";

export type SubmitAction = LaunchDestination | "newline" | "ignore";

export interface SubmitKeyInfo {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** Mid-IME composition: Enter commits the candidate, it never submits. */
  isComposing?: boolean;
}

/** The other destination — what the modifier reaches for. */
export function otherDestination(d: LaunchDestination): LaunchDestination {
  return d === "plan" ? "drafter" : "plan";
}

/** What ⏎ does in the composer.
 *
 *  ⏎ sends to the SELECTED destination and ⌘⏎/^⏎ to the other one, so both
 *  are always one keystroke away whichever is current — and with the default
 *  (`plan`) selected this is exactly the original binding: ⏎ launches, ⌘⏎
 *  opens the Drafter. ⇧⏎ is always a newline; the composer is multi-line and
 *  any other binding breaks typing. A composition-in-flight Enter belongs to
 *  the IME. */
export function submitAction(
  e: SubmitKeyInfo,
  destination: LaunchDestination = "plan",
): SubmitAction {
  if (e.key !== "Enter") return "ignore";
  if (e.isComposing) return "ignore";
  if (e.metaKey || e.ctrlKey) return otherDestination(destination);
  if (e.shiftKey) return "newline";
  return destination;
}

/** The project chip's state. `null` means untouched — resolve it from the
 *  prompt text and the workspace. `{ path }` is an explicit pick, and
 *  `{ path: null }` is an explicit "Home (~)", which must NOT be re-guessed
 *  away on the next keystroke. */
export type ProjectChoice = { path: string | null } | null;

export interface LaunchProjectInputs {
  /** Known repos: every review session's project plus each open folder. */
  projectOptions: ProjectOption[];
  /** The folder workspace currently open in the sidebar, if any. */
  openFolder: string | null;
  /** The repo the Drafter last shipped a prompt into. */
  lastDrafterProject: string | null;
}

/** Where ⏎ launches. Precedence: an explicit chip beats everything; then the
 *  repo named in the prompt itself; then the folder the user is browsing;
 *  then the last repo they drafted into; then Home. */
export function resolveLaunchProject(
  text: string,
  chip: ProjectChoice,
  opts: LaunchProjectInputs,
): string | null {
  if (chip) return chip.path;
  const guess = guessProjectForPlan(text, opts.projectOptions);
  if (guess) return guess;
  if (opts.openFolder) return opts.openFolder;
  return opts.lastDrafterProject ?? null;
}

/** The prompt as launched. Attached files ride as a plain `Context:` path
 *  list — the plan session already has `Read Grep Glob` pre-approved, so a
 *  path is all it needs; inlining the bytes would only burn its context. */
export function composePrompt(text: string, attachments: string[]): string {
  const body = text.trim();
  if (!body) return "";
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of attachments) {
    const p = raw.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
  }
  if (paths.length === 0) return body;
  return `${body}\n\nContext:\n${paths.map((p) => `- ${p}`).join("\n")}`;
}

export interface FrontDoorSuggestion {
  /** What the chip reads. */
  label: string;
  /** What clicking it puts in the composer — it fills, never launches. */
  text: string;
}

/** Starter chips. Templated on the project the door would launch into, so a
 *  user with one repo sees its name and a first-run user sees the generic
 *  form. Clicking FILLS the composer (a half-written sentence is an
 *  invitation to finish it; a launched one is a surprise). */
export function frontDoorSuggestions(
  projectName: string | null,
): FrontDoorSuggestion[] {
  const inProject = projectName ? ` in ${projectName}` : "";
  return [
    {
      label: projectName ? `Fix a bug in ${projectName}` : "Fix a bug",
      text: `Fix a bug${inProject}: `,
    },
    { label: "Add a feature", text: `Add a feature${inProject}: ` },
    {
      label: projectName ? `Explain ${projectName}` : "Explain this codebase",
      text: projectName
        ? `Explain how ${projectName} works, end to end.`
        : "Explain how this codebase works, end to end.",
    },
    { label: "Write tests", text: "Write tests for " },
  ];
}

/** Is a launched plan session still alive?
 *
 *  A launch lives in one terminal tile. Close the tile and the PTY dies with
 *  it, so no plan is ever coming and the "Planning…" card has to go — a
 *  spinner outliving its process is exactly the confident lie this surface
 *  exists to remove.
 *
 *  The rule that matters is the negative one: only a REPORTED set of live ids
 *  that omits ours proves the terminal is gone. `null` means the dock hasn't
 *  told us yet, which is ignorance, not death — treating it as death would
 *  cancel every launch during the frames before the first report. */
export function launchStillLive(
  terminalId: string | null,
  liveTerminalIds: string[] | null,
): boolean {
  if (!terminalId) return true;
  if (liveTerminalIds === null) return true;
  return liveTerminalIds.includes(terminalId);
}

/** Words that carry no identity in a project name — the leading verb, the
 *  articles, the connective tissue. Dropped wholesale so "add a dark mode
 *  toggle to the settings page" proposes `dark-mode-toggle`. */
const FILLER = new Set([
  "a",
  "add",
  "an",
  "and",
  "build",
  "can",
  "create",
  "do",
  "feature",
  "for",
  "from",
  "i",
  "implement",
  "in",
  "into",
  "it",
  "lets",
  "make",
  "me",
  "my",
  "new",
  "of",
  "on",
  "please",
  "some",
  "that",
  "the",
  "then",
  "this",
  "to",
  "want",
  "with",
  "write",
  "you",
]);

/** How many words a proposed name may carry, and its hard character cap. */
const NAME_WORDS = 3;
const NAME_MAX = 32;

/** The folder name proposed to a first-run user with no project at all:
 *  "add a dark mode toggle to the settings page" → `dark-mode-toggle`.
 *  Output is always a valid slug (the Rust side re-validates — this is a
 *  suggestion, never the security boundary). */
export function projectNameFromPrompt(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const meaningful = words.filter((w) => !FILLER.has(w));
  // Everything was filler ("please make it for me") — fall back to the raw
  // words rather than proposing nothing.
  const chosen = (meaningful.length > 0 ? meaningful : words).slice(
    0,
    NAME_WORDS,
  );
  const slug = chosen.join("-").slice(0, NAME_MAX).replace(/-+$/, "");
  return slug || "new-project";
}
