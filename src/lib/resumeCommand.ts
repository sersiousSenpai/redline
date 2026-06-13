// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** Single-quote shell escaping: close the quote, emit an escaped literal
 *  quote, reopen. Safe for POSIX shells (the embedded PTY runs zsh). */
const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

const RESTORE_PROMPT =
  "The reviewer reopened this plan in Redline for continued review. " +
  "You are already in plan mode — call ExitPlanMode to re-present your " +
  "current plan for review (no changes needed unless you have them).";

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

/** The "Restore plan session" command. `--permission-mode plan` starts the
 *  resumed conversation in plan mode, so its ExitPlanMode call succeeds
 *  immediately instead of erroring with "You are not in plan mode" and
 *  recovering through an EnterPlanMode round-trip. Used both by the embedded
 *  terminal (with a trailing \r appended by the caller) and the
 *  copy-to-clipboard fallback. */
export function buildResumeCommand(sessionId: string, now: Date): string {
  const prompt = `${RESTORE_PROMPT} (Restore requested ${restoreStamp(now)}.)`;
  return `claude --resume ${shq(sessionId)} --permission-mode plan ${shq(prompt)}`;
}
