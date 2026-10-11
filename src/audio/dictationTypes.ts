// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The native dictation contract (src-tauri/src/dictation.rs and
// dictation_whisper.rs), as types and one timing constant, so importing it
// costs next to nothing.
//
// Commands:
// - `dictation_start({ owner?, kind?, vocab?, preroll? })` → `DictationGrant`.
//   `owner` names the surface capturing (callers that pass none share
//   "default"); `kind` is "hold" (push-to-talk: takes the mic from anyone, who
//   then hears `dictation-preempted`) or "open" (the default: refused while
//   another owner holds the mic); `vocab` is the ranked list from `buildVocab`
//   (vocab.ts); `preroll: false` starts without the pre-roll — pass it while
//   Redline is speaking or has just stopped (`PREROLL_CLEAR_MS`), or the
//   capture begins with the end of Redline's own voice.
// - `dictation_stop({ owner? })` → the final text, from Whisper when it is
//   installed, else Apple. "" from an owner that no longer holds the mic.
//   Await it before starting the same owner again: a start that reaches the
//   mic before the stop does is the holder's repeat press, a no-op.
// - `dictation_cycle({ owner? })` → the utterance so far; the mic stays open.
// - `dictation_kill_all({ owner? })`: with an owner, cancels that owner's
//   capture (text discarded); without, closes every capture and the warm mic.
// - `dictation_status()` → `DictationStatus`. The output route changes as
//   headphones come and go: ask per turn.
// - `dictation_set_engine({ engine, whisperModel? })`,
//   `whisper_install({ model? })` (progress on `whisper-setup`).
//
// Events, each naming its capture's `owner`: `dictation-partial` and
// `dictation-final` (`DictationText`), `dictation-error`, `dictation-level`
// (`DictationLevel`, 20 a second of audio while capturing),
// `dictation-preempted`.
//
// After a capture the mic stays warm for 5 s (not on a Bluetooth headset's
// mic), and a capture started while it is warm begins with up to 300 ms heard
// before the press: never the last capture's own end.

import type { DictationError } from "./utterance";

/** How long after Redline's voice goes quiet the pre-roll can still hold its
 *  end: the 300 ms ring, plus the time the sound takes to leave the speakers. */
export const PREROLL_CLEAR_MS = 500;

export type DictationOwner = string;

export interface DictationGrant {
  /** The caller holds the mic: it just took it, or already had it. */
  granted: boolean;
  /** Who holds the mic after the call. */
  holder: DictationOwner;
  /** Whom this start took the mic from. */
  preempted?: DictationOwner;
}

export interface DictationText {
  owner: DictationOwner;
  text: string;
}

export interface DictationErrorEvent extends DictationError {
  owner: DictationOwner;
}

/** One 50 ms window of a capture's audio. */
export interface DictationLevel {
  owner: DictationOwner;
  /** dBFS, −100 for digital silence. */
  rms: number;
  peak: number;
  /** Where the window ends, in ms from the capture's start. */
  ms: number;
}

export interface DictationPreempted {
  /** The owner that lost the mic. */
  owner: DictationOwner;
  /** The push-to-talk that took it. */
  by: DictationOwner;
  /** What the lost capture had heard so far. */
  text: string;
}

export type DictationEngine = "auto" | "apple" | "whisper";
export type WhisperModelId = "base" | "turbo";

export interface WhisperModelStatus {
  id: WhisperModelId;
  present: boolean;
  /** The published file size. */
  bytes: number;
  /** Bytes an interrupted download left to resume from. */
  partial: number;
}

export interface OutputRoute {
  /** Only "headphones" means the mic won't hear what Redline plays. */
  kind: "headphones" | "speakers" | "unknown";
  transport: string;
}

export interface DictationStatus {
  holder: DictationOwner | null;
  engine: DictationEngine;
  whisperModel: WhisperModelId;
  /** The model a capture would run now; null when none is installed. */
  whisperActive: WhisperModelId | null;
  whisperModels: WhisperModelStatus[];
  outputRoute: OutputRoute;
}
