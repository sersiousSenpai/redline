// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A voice turn that outlives its panel. Closing the panel mid-reply leaves the
// turn running (the deferred stop spares a streaming turn) and the reply is
// persisted when it lands — but with the panel gone, nothing on screen said
// so. The panel leaves a note here as it unmounts; the Discuss pill reads it
// and shows a state, never a new segment: a quiet working mark while the turn
// runs, then a dot once a reply is waiting. Opening the panel clears it.
//
// Module state, not React context: the pill sits in the boot chunk and the
// panel in a lazy one, and this is the whole of what they share.

import { useSyncExternalStore } from "react";

export type AwayState = "thinking" | "waiting";

export interface VoiceAway {
  /** The voice key the turn belongs to. */
  key: string;
  state: AwayState;
}

let away: VoiceAway | null = null;
const listeners = new Set<() => void>();

export function getVoiceAway(): VoiceAway | null {
  return away;
}

export function setVoiceAway(next: VoiceAway | null): void {
  if (next?.key === away?.key && next?.state === away?.state) return;
  away = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useVoiceAway(): VoiceAway | null {
  return useSyncExternalStore(subscribe, getVoiceAway, getVoiceAway);
}
