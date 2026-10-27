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
 *  `run` is the fourth: no plan at all — the sentence goes straight to an
 *  agent that builds it (`--permission-mode auto` on Claude, no approvals and
 *  no sandbox on Codex). Offered only where `runSupported` says the harness's
 *  non-plan flags are verified. */
/** `browser` is the door tab's fifth (W1): the sentence opens as an address
 *  or a search in the browser the tab converts into. Offered only by a door
 *  pane with that destination among its Open targets. */
export type LaunchDestination = "plan" | "drafter" | "chat" | "run" | "browser";

export type SubmitAction = LaunchDestination | "newline" | "ignore";

export interface SubmitKeyInfo {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** Mid-IME composition: Enter commits the candidate, it never submits. */
  isComposing?: boolean;
}

/** What the modifier reaches for.
 *
 *  With two destinations "the other one" was total; with three it isn't, and
 *  an involution over three values cannot exist. The rule that replaces it is
 *  the one the two-destination version already implemented in the only cases
 *  that existed: **plan is the fallback, unless you are already on plan.**
 *  So ⌘⏎ still opens the Drafter from the plan route and still plans from the
 *  Drafter route — byte-for-byte today's behavior — and chat gets the sane
 *  answer, ⌘⏎ = plan, because "I have written the thing out, just build it" is
 *  the move you want one key away from a half-formed thought. `run` falls back
 *  to plan for the opposite reason: the one key away from "just do it" should
 *  be "show me first". */
export function fallbackDestination(d: LaunchDestination): LaunchDestination {
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
