// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** Single-quote shell escaping: close the quote, emit an escaped literal
 *  quote, reopen. Safe for POSIX shells (the embedded PTY runs zsh). Exported
 *  so other terminal-launch builders (e.g. `planLaunchCommand`) escape arguments
 *  the exact same way — never hand-roll quoting. */
export const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Bare marker the resumed session writes into its plan file on restore. Redline
 *  already holds the authoritative plan, so it re-presents that on restore and
 *  ignores the submitted body — Claude need not fetch or retype the plan. */
export const REDLINE_RESTORE_SENTINEL = "<!-- REDLINE_RESTORE -->";

/** The marker the resume command actually has Claude write: the bare sentinel
 *  with the *held plan's* session id appended. The daemon rebinds the restore to
 *  this id, so it works even when the ExitPlanMode handshake lands under a
 *  different session — `claude --resume` forks a new id, and a resume command
 *  pasted into an already-running Claude REPL runs under that REPL's own id.
 *  Must stay in sync with `REDLINE_RESTORE_PREFIX` / `restore_target_id` in
 *  `src-tauri/src/lib.rs`. */
export function restoreSentinel(sessionId: string): string {
  return `<!-- REDLINE_RESTORE:${sessionId} -->`;
}

/** The restore handshake, as the resumed session is asked to perform it.
 *
 *  Restore is only ever re-establishing the held ExitPlanMode: Redline already
 *  holds the current plan and re-presents its own copy, so the body submitted
 *  here is a marker, never the plan. That makes every step of this a pure cost,
 *  and each one is a model round trip against a resumed session's full context
 *  — measured at 4-6 seconds apiece on a 1.7 MB transcript.
 *
 *  So there are two versions. When Redline has already written the marker into
 *  the session's plan file (`primed` — see `prime_plan_file`), the whole
 *  handshake is ONE tool call. Otherwise the model writes the marker itself,
 *  the way it always did.
 *
 *  `EnterPlanMode` is gone from both: `--permission-mode plan` puts a RESUMED
 *  session in plan mode on Claude Code 2.1.222, verified by asking one. The
 *  fallback sentence costs nothing on a build where that stops being true.
 *  The redline skill's "Restoring a reopened plan" section documents the same
 *  sequence. */
const restorePrompt = (sessionId: string, primed: boolean) => {
  const head =
    "This plan was reopened in Redline for continued review. Redline already " +
    "holds your current plan and will re-present it, so do NOT fetch, read or " +
    "retype it, and do not explore the codebase. ";
  const body = primed
    ? "Your plan file has already been written for you — it contains exactly " +
      `\`${restoreSentinel(sessionId)}\`. Call ExitPlanMode now, as your very ` +
      "first action, with no other tool calls and no preamble. (If your plan " +
      "file somehow does not contain that line, write it there first.)"
    : "Write exactly " +
      `\`${restoreSentinel(sessionId)}\` as your plan file's contents, then ` +
      "call ExitPlanMode. Nothing else — no preamble, no other tool calls.";
  const tail =
    " Redline restores the held plan and ignores what you submit. (If you are " +
    "not in plan mode, call EnterPlanMode first.)";
  return head + body + tail;
};

/** Local "YYYY-MM-DD HH:MM" stamp appended to the restore prompt. Every
 *  restore lands the same prompt in the same conversation, and the resume
 *  screen replays prior user messages — without a stamp, earlier restores
 *  render as exact duplicates of the new one and read as a double-send. */
const restoreStamp = (now: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
    `${p(now.getHours())}:${p(now.getMinutes())}`
  );
};

/** The "Restore plan session" command. `--permission-mode plan` lands a resumed
 *  session in plan mode on 2.1.222 — it did not on 2.1.178, which is why the
 *  prompt used to open with an explicit EnterPlanMode; that step is now a
 *  one-clause fallback rather than a guaranteed round trip. Used both by the
 *  embedded terminal (with a trailing \r appended by the caller) and the
 *  copy-to-clipboard fallback.
 *
 *  `projectPath` pins the command to the plan's project directory. Claude scopes
 *  resumable sessions *per project*: `claude --resume <id>` run from any other
 *  cwd fails with "No conversation found" and interactive Claude falls back to a
 *  *fresh* session — which then writes the restore sentinel under an id Redline
 *  never held, surfacing as a phantom new plan showing literal sentinel text
 *  instead of the restored plan. The embedded terminal opens in this dir already
 *  (the cd is a harmless no-op there); it is the load-bearing fix for the
 *  copy-to-clipboard path, which the user may paste into a terminal sitting
 *  anywhere. */
/** Appended when the reviewer un-approved an Orchestrate: the resumed
 *  session's context still holds the ORCHESTRATE_STAND_DOWN deny ("this
 *  session's work is done"), and without this sentence a resumed claude would
 *  obey the stale stand-down instead of the restore. */
const RESCINDED_SENTENCE =
  " An earlier Redline stand-down in your context is void — the reviewer " +
  "rescinded that approval, and this plan is back in review.";

export function buildResumeCommand(
  sessionId: string,
  now: Date,
  projectPath?: string | null,
  rescinded?: boolean,
  /** Redline wrote the marker into the plan file already, so the handshake is
   *  a single ExitPlanMode. Resolved by `prepare_restore`. */
  primed?: boolean,
): string {
  const prompt =
    `${restorePrompt(sessionId, !!primed)} (Restore requested ${restoreStamp(now)}.)` +
    (rescinded ? RESCINDED_SENTENCE : "");
  const resume = `claude --resume ${shq(sessionId)} --permission-mode plan ${shq(prompt)}`;
  return projectPath ? `cd ${shq(projectPath)} && ${resume}` : resume;
}
