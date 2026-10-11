// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The Discuss pill's caption: what a voice turn taken with the panel closed is
// doing, for the pill to spring open into (voice-ux-design §5.1) — hearing you
// (the waveform and your words), thinking (what the agent is doing), speaking
// (the sentence being said), then done, for the moment before it shrinks back.
// The dictation host writes the hearing, and the reply it sent (awayReply.ts)
// the rest. States of the one pill, never a segment of it: a click anywhere on
// the caption is a click on the pill.
//
// Module state, like voiceAway.ts: the pill sits in the boot chunk, and its
// caption and both writers are lazy. The pill subscribes only to whether
// there is a caption for it, so the mic's 20 Hz levels re-render the caption
// alone.

import { useSyncExternalStore } from "react";

import type { Activity } from "../lib/turnMeter";

export type CaptionPhase = "hearing" | "thinking" | "speaking" | "done";

export interface VoiceCaption {
  /** The voice key of the conversation the turn goes to. */
  key: string;
  phase: CaptionPhase;
  /** Hearing: the words heard so far. Speaking, and done: the sentence being
   *  (or last) said. */
  text: string;
  /** Hearing: the latest levels as bar heights, 0–1, oldest first. */
  levels: number[];
  /** Thinking: what the agent is doing, from `voice-meter`. */
  activity: Activity | null;
  /** When the turn was sent: the thinking caption's clock. */
  since: number;
}

let caption: VoiceCaption | null = null;
const listeners = new Set<() => void>();

export const voiceCaption = {
  get: (): VoiceCaption | null => caption,
  set(next: VoiceCaption | null): void {
    caption = next;
    for (const l of listeners) l();
  },
  /** Change the caption of conversation `key`, if it is still showing. */
  update(key: string, patch: Partial<Omit<VoiceCaption, "key">>): void {
    if (caption?.key === key) voiceCaption.set({ ...caption, ...patch });
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** A fresh caption for a turn to `key`. */
export function captionFor(key: string, phase: CaptionPhase, since: number): VoiceCaption {
  return { key, phase, text: "", levels: [], activity: null, since };
}

/** Whether the pill opening on `voiceKey` (any conversation's, when it
 *  names none) has a caption to show. */
export function useCaptioned(voiceKey?: string): boolean {
  const mine = () => !!caption && (voiceKey === undefined || caption.key === voiceKey);
  return useSyncExternalStore(voiceCaption.subscribe, mine, mine);
}

export function useVoiceCaption(): VoiceCaption | null {
  return useSyncExternalStore(voiceCaption.subscribe, voiceCaption.get, voiceCaption.get);
}
