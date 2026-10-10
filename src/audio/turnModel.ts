// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The optional end-of-turn model (`turn_scorer.rs`): a small on-device model
// that hears whether the user has finished speaking, in a process of its own
// on the Kokoro runtime. Downloading it in voice settings turns it on for
// hands-free; it can be switched off there and stays downloaded.

import { invoke } from "@tauri-apps/api/core";

import type { Scorer } from "./endpoint";

export interface TurnModelStatus {
  /** The Kokoro runtime is installed, so the model can run. */
  runtime: boolean;
  /** The model is downloaded. */
  model: boolean;
  /** Its process is up. */
  warm: boolean;
  /** A `score`'s answer: how likely it is the speaker has finished. */
  score: number | null;
}

export type TurnModelOp = "status" | "install" | "warm" | "score" | "stop";

export const turnModel = (op: TurnModelOp) => invoke<TurnModelStatus>("turn_scorer", { op });

const OFF_KEY = "redline.voice.turnModelOff";

/** Whether hands-free may use the model (once it is downloaded). */
export function turnModelWanted(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) !== "1";
  } catch {
    return true;
  }
}

export function setTurnModelWanted(on: boolean): void {
  try {
    if (on) localStorage.removeItem(OFF_KEY);
    else localStorage.setItem(OFF_KEY, "1");
  } catch {
    /* private mode / quota — the setting is best-effort */
  }
}

/** Start the model for a hands-free conversation: the endpointer's scorer,
 *  or null when it isn't downloaded, is switched off, or won't start. */
export async function warmTurnModel(): Promise<Scorer | null> {
  if (!turnModelWanted()) return null;
  try {
    await turnModel("warm");
  } catch {
    return null;
  }
  return () => turnModel("score").then((r) => r.score, () => null);
}
