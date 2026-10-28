// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The front door's pure core: what a keystroke means and the slug proposed to
// a first-run user who has no project at all. House style — every decision
// the surface makes lives here so it can be tested without a DOM;
// FrontDoor.tsx only renders and App.tsx only wires.
//
// What is NOT here: anything about *launching*. Project resolution, prompt
// composition, the readiness gate and the pending-launch shape all moved to
// `lib/launch.ts` when the Drafter and the browser became doors too — they are
// shared property. The composer keybindings below are not, and stay.

/** Where the composer's sentence lives: a shared draft (hooks/useSharedDraft)
 *  that the composer subscribes to and App only reads when something is sent,
 *  so a keystroke re-renders the composer and never the shell around it. The
 *  key predates the move, so a half-typed prompt survives the upgrade too. */
export const FRONT_DOOR_TEXT_KEY = "redline.frontDoor.text";

/** Where the composer sends its text. A sticky setting, not a one-off: you
 *  pick it in `Plan ▾` and it stays picked, so a session spent shaping long
 *  briefs doesn't mean reaching for a modifier on every one.
 *
 *  `chat` is the third: an unbound conversation, for the half-formed idea that
 *  is not yet a plan and not yet a document.
 *
 *  `browser` is the door tab's fourth (W1): the sentence opens as an address
 *  or a search in the browser the tab converts into. Offered only by a door
 *  pane with that destination among its Open targets. */
export type LaunchDestination = "plan" | "drafter" | "chat" | "browser";

export type SubmitAction = LaunchDestination | "newline" | "ignore";

export interface SubmitKeyInfo {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** Mid-IME composition: Enter commits the candidate, it never submits. */
  isComposing?: boolean;
}

/** What the modifier reaches for: the plan, always.
 *
 *  ⌘⏎ is "I have written the thing out, just build it" — it launches the
 *  plan in the door's selected project, exactly as ⏎ does on the plan route.
 *  It used to open the Drafter from the plan route (the other of two
 *  destinations), which put a finished brief into a Draft and, with it, the
 *  Drafter's own project in place of the one the chip showed. A modifier must
 *  never move the sentence somewhere the reviewer did not choose. */
export function fallbackDestination(_d: LaunchDestination): LaunchDestination {
  return "plan";
}

/** What ⏎ does in the composer.
 *
 *  ⏎ sends to the SELECTED destination and ⌘⏎/^⏎ launches the plan
 *  (`fallbackDestination`), so on the plan route the two keys agree and from
 *  any other route the build is one keystroke away. ⇧⏎ is always a newline;
 *  the composer is multi-line and any other binding breaks typing. A
 *  composition-in-flight Enter belongs to the IME. */
export function submitAction(
  e: SubmitKeyInfo,
  destination: LaunchDestination = "plan",
): SubmitAction {
  if (e.key !== "Enter") return "ignore";
  if (e.isComposing) return "ignore";
  if (e.metaKey || e.ctrlKey) return fallbackDestination(destination);
  if (e.shiftKey) return "newline";
  return destination;
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

/** Chat mode is one-shot when planning; IME/Shift retain normal editing. */
export function chatSubmitAction(event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey?: boolean; isComposing?: boolean }, mode: "chat" | "plan"): "chat" | "plan" | "newline" | null {
  if (event.isComposing || event.key !== "Enter") return null;
  if (event.shiftKey) return "newline";
  return event.metaKey || event.ctrlKey ? "plan" : mode;
}
