// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The CLI's own "Ready to code?" prompt, read off its terminal.
//!
//! ExitPlanMode asks the person before it builds. Redline answers that ask
//! at its source (the review hook's allow carries the call's own input, which
//! is what the CLI takes as the person's answer), but a CLI that shows the
//! prompt anyway — an older daemon, an approval from somewhere else, a
//! restore whose hook was not ours — waits in its terminal while the Agent
//! pane said only "Claude is asking in the terminal". This reads that exact
//! prompt from the terminal's recent output, so the pane can put the "Ready
//! to build this plan?" card up and answer it with the same keys a person
//! would press.
//!
//! The raw output is a TUI's: cursor moves between words come out as nothing
//! once escapes are stripped ("Wouldyouliketoproceed?"), so matching ignores
//! whitespace, and labels are read back in their own words where they are
//! known.

/** One choice the prompt offers, in its order. */
export interface ProceedOption {
  /** 1-based, as the prompt numbers it. */
  n: number;
  label: string;
  /** Approves the plan (and builds), rather than sending it back. */
  approves: boolean;
}

export interface ProceedPrompt {
  options: ProceedOption[];
  /** Which option the prompt's cursor (❯) is on, 1-based. */
  selected: number;
}

const QUESTION = "wouldyouliketoproceed?";
/** The labels this CLI has been seen to show, by their squashed form. */
const KNOWN: Record<string, string> = {
  "yes,andusautomode": "Yes, and use auto mode",
  "yes,anduseautomode": "Yes, and use auto mode",
  "yes,manuallyapproveedits": "Yes, manually approve edits",
  "yes,andmanuallyapproveedits": "Yes, and manually approve edits",
  "yes,andauto-acceptedits": "Yes, and auto-accept edits",
  "yes,andbypasspermissions": "Yes, and bypass permissions",
  "tellclaudewhattochange": "Tell Claude what to change",
  "no,keepplanning": "No, keep planning",
};

const squash = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** ANSI escapes (CSI, OSC, single-char) out; what is left is the text. */
export function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r/g, "\n");
}

/** The prompt, if the terminal's recent output ends on it; null otherwise
 *  (anything after it — the turn going on, another prompt — means it was
 *  answered). */
export function parseProceedPrompt(output: string): ProceedPrompt | null {
  const text = stripAnsi(output);
  const flat = squash(text);
  const at = flat.lastIndexOf(QUESTION);
  if (at < 0) return null;
  const after = flat.slice(at + QUESTION.length);
  // The options, numbered 1..n, each up to the next number or the footer.
  const options: ProceedOption[] = [];
  let selected = 1;
  const re = /(❯|›|>)?(\d)\.(.+?)(?=(?:❯|›|>)?\d\.|shift\+tab|ctrl\+g|$)/g;
  for (const m of after.matchAll(re)) {
    const n = Number(m[2]);
    if (n !== options.length + 1) break;
    const key = m[3];
    const label = KNOWN[key] ?? `Option ${n}`;
    if (m[1]) selected = n;
    options.push({ n, label, approves: key.startsWith("yes") });
  }
  if (options.length < 2 || !options.some((o) => o.approves)) return null;
  // Text past the footer that is not the footer's own is the CLI moving on.
  const tail = after.slice(after.lastIndexOf(options.length + ".") + 2);
  if (/(⏺|●|✻|✶|✽|✢|·{3})/.test(tail.replace(/·\s*~?\//g, ""))) return null;
  return { options, selected };
}

/** The keys that choose option `n` from a cursor on `selected`: arrows to
 *  it, then Enter — what a person presses, whatever the CLI's digit
 *  shortcuts do. */
export function keysFor(prompt: ProceedPrompt, n: number): string {
  const steps = n - prompt.selected;
  const arrow = steps > 0 ? "\x1b[B" : "\x1b[A";
  return arrow.repeat(Math.abs(steps)) + "\r";
}

// ── The CLI's own permission prompt ─────────────────────────────────────────
//
// The same safety net for a tool's permission. A card for it normally comes
// through the PermissionRequest hook, armed only for a bound, subscribed
// terminal (`convo::open_ask`); a permission the hook handed to the TUI — no
// pane was watching that terminal when it fired, as after the last walk's
// Restore — waits in the terminal as "Do you want to create notes.txt?" with
// numbered choices. Read off the terminal, it becomes the same kind of card,
// answered with the keys a person would press.

/** A permission prompt: its question in the CLI's words (null when the
 *  spaces were cursor moves and cannot be read back), and its choices. */
export interface PermissionPrompt extends ProceedPrompt {
  question: string | null;
}

const PERMISSION_MARK = "doyouwantto";
/** Choices the permission prompt has been seen to offer, by the squashed
 *  start of their words; anything else is "Option n". */
const PERMISSION_LABELS: readonly [string, string][] = [
  ["yes,allowalleditsduringthissession", "Yes, allow all edits during this session"],
  ["yes,anddon'taskagain", "Yes, and don't ask again"],
  ["yes,anddontaskagain", "Yes, and don't ask again"],
  ["yes,allow", "Yes, allow"],
  ["no,andtellclaudewhattododifferently", "No, and tell Claude what to do differently"],
  ["no", "No"],
  ["yes", "Yes"],
];

function permissionLabel(key: string, n: number): string {
  return PERMISSION_LABELS.find(([prefix]) => key.startsWith(prefix))?.[1] ?? `Option ${n}`;
}

/** The permission prompt, if the terminal's recent output ends on one;
 *  null otherwise (anything after it means it was answered, and a plan's
 *  proceed prompt after it is `parseProceedPrompt`'s). */
export function parsePermissionPrompt(output: string): PermissionPrompt | null {
  const text = stripAnsi(output);
  const flat = squash(text);
  const at = flat.lastIndexOf(PERMISSION_MARK);
  if (at < 0 || flat.lastIndexOf(QUESTION) > at) return null;
  const ask = flat.indexOf("?", at);
  if (ask < 0) return null;
  const after = flat.slice(ask + 1);
  const options: PermissionPrompt["options"] = [];
  let selected = 1;
  const re = /(❯|›|>)?(\d)\.(.+?)(?=(?:❯|›|>)?\d\.|esctocancel|$)/g;
  for (const m of after.matchAll(re)) {
    const n = Number(m[2]);
    if (n !== options.length + 1) break;
    const key = m[3];
    if (m[1]) selected = n;
    options.push({ n, label: permissionLabel(key, n), approves: key.startsWith("yes") });
  }
  if (options.length < 2 || !options.some((o) => o.approves) || options.every((o) => o.approves)) return null;
  const tail = after.slice(after.lastIndexOf(options.length + ".") + 2);
  if (/(⏺|●|✻|✶|✽|✢|·{3})/.test(tail)) return null;
  // The question in its own words, when the terminal kept its spaces.
  const said = [...text.matchAll(/Do you want to [^?\n]*\?/g)].pop()?.[0] ?? null;
  return { options, selected, question: said };
}
