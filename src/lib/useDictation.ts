// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useSyncExternalStore, type RefObject } from "react";

// A composer's mic button, and nothing more. The capture itself — the one
// owner of the mic, the live strip, the cleanup, writing into the field — is
// the dictation host's (src/audio/dictationHost.ts), a lazy chunk shared with
// the hold-to-dictate key: a press here locks the mic open into this
// composer's field, and the words arrive as if typed (the field's own
// onChange). This module is on the boot path (the Front Door has a mic), so
// it holds only which field is being dictated into, and the way to load the
// host.

let live: Element | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getLive = () => live;

/** The host says which field a capture is writing into (null: none). */
export function setDictationLive(el: Element | null): void {
  if (el === live) return;
  live = el;
  for (const l of listeners) l();
}

let host: Promise<typeof import("../audio/dictationHost")> | null = null;
export function loadDictation(): Promise<typeof import("../audio/dictationHost")> {
  return (host ??= import("../audio/dictationHost"));
}

export interface Dictation {
  /** A capture is writing into this composer's field. */
  listening: boolean;
  /** Start dictating into the field (mic open until pressed again), or
   *  finish. */
  toggle: () => void;
}

export function useDictation(field: RefObject<HTMLElement | null>): Dictation {
  const current = useSyncExternalStore(subscribe, getLive, getLive);
  return {
    listening: !!current && current === field.current,
    toggle: () => {
      const el = field.current;
      if (el) void loadDictation().then((m) => m.toggleInto(el));
    },
  };
}
