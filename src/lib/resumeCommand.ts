// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** Single-quote shell escaping: close the quote, emit an escaped literal
 *  quote, reopen. Safe for POSIX shells (the embedded PTY runs zsh). */
const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Marker the resumed session writes into its plan file on restore. Redline
 *  already holds the authoritative plan, so it re-presents that on restore and
 *  ignores the submitted body — Claude need not fetch or retype the plan. Must
 *  stay in sync with `REDLINE_RESTORE_SENTINEL` in `src-tauri/src/lib.rs`. */
export const REDLINE_RESTORE_SENTINEL = "<!-- REDLINE_RESTORE -->";

/** A resumed session lands *outside* plan mode and without the plan body in
 *  context — but Redline already holds the current plan, so restore is just
 *  re-establishing the held ExitPlanMode. Claude does the irreducible minimum:
 *  EnterPlanMode, drop a one-line marker in the plan file, ExitPlanMode. No
 *  daemon fetch, no retyping the (potentially huge) plan body. The redline
 *  skill's "Restoring a reopened plan" section documents the same sequence. */
const restorePrompt = () =>
  "This plan was reopened in Redline for continued review. You are not in plan " +
  "mode and your plan body is not in this context — but Redline already holds " +
  "your current plan and will re-present it, so do NOT fetch or retype it. Just " +
  `call EnterPlanMode, write exactly \`${REDLINE_RESTORE_SENTINEL}\` as your ` +
  "plan file's contents, and call ExitPlanMode. Redline restores the held plan " +
  "and ignores what you submit.";

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

/** The "Restore plan session" command. `--permission-mode plan` signals plan
 *  intent, but does not by itself yield an immediately-exitable plan-mode state
 *  on resume (Claude Code v2.1.178 still reports "You are not in plan mode"), so
 *  the prompt has Claude call EnterPlanMode explicitly. Used both by the
 *  embedded terminal (with a trailing \r appended by the caller) and the
 *  copy-to-clipboard fallback. */
export function buildResumeCommand(sessionId: string, now: Date): string {
  const prompt = `${restorePrompt()} (Restore requested ${restoreStamp(now)}.)`;
  return `claude --resume ${shq(sessionId)} --permission-mode plan ${shq(prompt)}`;
}
