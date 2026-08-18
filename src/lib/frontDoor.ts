// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The front door's pure core: what a keystroke means, its starter chips, and
// the slug proposed to a first-run user who has no project at all. House style
// — every decision the surface makes lives here so it can be tested without a
// DOM; FrontDoor.tsx only renders and App.tsx only wires.
//
// What is NOT here: anything about *launching*. Project resolution, prompt
// composition, the readiness gate and the pending-launch shape all moved to
// `lib/launch.ts` when the Drafter and the browser became doors too — they are
// shared property. The composer keybindings and chip templater below are not,
// and stay.

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
