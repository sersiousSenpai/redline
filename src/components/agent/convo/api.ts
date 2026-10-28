// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The conversation mirror's commands, one wrapper each. Names and argument
//! shapes are the contract with `src-tauri/src/convo` (see ./types.ts).
//! `terminalId` is the PTY id — the same id the terminal dock's tab carries
//! and the CLI sees as `REDLINE_TERMINAL_ID`.

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AskAnswer,
  ConvoBatch,
  ConvoMode,
  ConvoPage,
  ConvoSnapshot,
  SubmitResult,
  SwitchResult,
} from "./types";

/** Start mirroring a terminal's conversation: the recent tail now, then
 *  coalesced batches through `onBatch` until `convoUnsubscribe`. A hook only
 *  arms permission/question cards while some subscription is live. */
export async function convoSubscribe(
  terminalId: string,
  onBatch: (batch: ConvoBatch) => void,
): Promise<ConvoSnapshot> {
  const channel = new Channel<ConvoBatch>();
  channel.onmessage = onBatch;
  return invoke<ConvoSnapshot>("convo_subscribe", { terminalId, onBatch: channel });
}

export function convoUnsubscribe(terminalId: string, subscriptionId: string): Promise<void> {
  return invoke("convo_unsubscribe", { terminalId, subscriptionId });
}

/** Older events, before `(epoch, offset)` (the oldest held). */
export function convoPage(terminalId: string, epoch: number, beforeOffset: number): Promise<ConvoPage> {
  return invoke<ConvoPage>("convo_page", { terminalId, epoch, beforeOffset });
}

/** Announce a send before it is typed, so the stage can show the bubble at
 *  once and reconcile it with the transcript (`delivered` / `undelivered`). */
export function convoExpect(terminalId: string, nonce: string, text: string): Promise<void> {
  return invoke("convo_expect", { terminalId, nonce, text });
}

/** Type `text` into the PTY and press Return: bracketed paste for long or
 *  multi-line text, control characters stripped. */
export function ptySubmit(terminalId: string, text: string): Promise<SubmitResult> {
  return invoke<SubmitResult>("pty_submit", { terminalId, text });
}

/** Stop: one Esc, guarded so two quick presses never open the rewind menu. */
export function ptyInterrupt(terminalId: string): Promise<void> {
  return invoke("pty_interrupt", { terminalId });
}

/** Stop from the Agent pane (its Stop button, Esc in it): the Esc goes to
 *  the PTY, and the attention daemon is told the same thing the dock tells
 *  it when Esc is pressed in a terminal tile (`term_attention_interrupted`):
 *  no hook reports an interrupt, so the terminal's working / needs-you
 *  would otherwise outlive the turn in every row and dot that reads it.
 *  One path for both, never a second. */
export async function interruptTerminal(terminalId: string): Promise<void> {
  await ptyInterrupt(terminalId);
  await invoke("term_attention_interrupted", { terminalId }).catch(() => {});
}

export function answerAsk(askId: string, answer: AskAnswer): Promise<void> {
  return invoke("convo_answer_ask", { askId, answer });
}

/** Bind a terminal to a known session before its CLI starts: Restore calls
 *  it with the restore terminal so the stage shows the conversation's
 *  history while `claude --resume` boots. `false` = no transcript found. */
export function convoPrebind(terminalId: string, sessionId: string): Promise<boolean> {
  return invoke<boolean>("convo_prebind", { terminalId, sessionId });
}

/** Mid-session `/plan`-style mode switch while the CLI is idle. */
export function convoSetMode(terminalId: string, mode: ConvoMode): Promise<SwitchResult> {
  return invoke<SwitchResult>("convo_set_mode", { terminalId, mode });
}

/** Mid-session `/model <id>` and/or `/effort <level>` while idle. */
export function convoSetModel(
  terminalId: string,
  model: string | null,
  effort: string | null,
): Promise<SwitchResult> {
  return invoke<SwitchResult>("convo_set_model", { terminalId, model, effort });
}
