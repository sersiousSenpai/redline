// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";

// Every composer that takes dictation registers here, and says how: whether
// "send it" submits it, whether its kept words get the AI polish, where its
// words go if it closes mid-capture. The capture itself — the one owner of the
// mic, the live strip, the cleanup, writing into the field — is the dictation
// host's (src/audio/dictationHost.ts), a lazy chunk shared with the
// hold-to-dictate key: it reads this registry for the composer around the
// caret when a capture starts, and writes the words in as if typed (the
// field's own onChange). A press on a composer's mic button locks the mic open
// into its field. This module is on the boot path (the Front Door and the
// comment composers register), so it holds only the registry, which field a
// capture is writing into, and the way to load the host.

export interface ComposerSpec {
  /** A chat composer: "send it" submits it, as its own Enter does. */
  send?: boolean;
  /** Its kept words get the AI polish once they are in. */
  polish?: boolean;
  /** What is said here is a turn in its conversation (the voice panel), sent
   *  on release and never written into a field. */
  turn?: boolean;
  /** Its box takes what is said with nothing focused, as it takes what is
   *  typed then (the Front Door's, while it shows). */
  fallback?: boolean;
  /** It closed while a capture was writing into it: the words are added to
   *  this draft (its shared one: the door's, a reply's) instead of being
   *  offered for copying. Called with the change to make to it. */
  keep?: (add: (draft: string) => string) => void;
}

/** A registered composer: its frame (what the strip sits on, and where its
 *  fields are), how it takes dictation, and the field its mic writes into
 *  (by default the first one in the frame). The dictation target
 *  (src/audio/dictationTarget.ts) reads these. */
export interface ComposerEntry {
  frame: HTMLElement;
  spec: RefObject<ComposerSpec>;
  field?: RefObject<HTMLElement | null>;
}

/** Every composer on screen, by frame. */
export const composers = new Map<HTMLElement, ComposerEntry>();
/** Told when a composer goes (the host stands its capture down). */
export const composerGone = new Set<(frame: HTMLElement) => void>();

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
  /** A capture is writing into this composer. */
  listening: boolean;
  /** Start dictating into the field (mic open until pressed again), or
   *  finish. */
  toggle: () => void;
}

/** Register the composer whose frame is `frame` (its fields are the ones
 *  inside it; `field` is the one its mic button writes into). */
export function useDictationComposer(
  frame: RefObject<HTMLElement | null>,
  spec: ComposerSpec,
  field?: RefObject<HTMLElement | null>,
): Dictation {
  const specRef = useRef(spec);
  specRef.current = spec;
  const entry = useRef<ComposerEntry | null>(null);
  // After every commit: the frame can be swapped for another element.
  useLayoutEffect(() => {
    const el = frame.current;
    if (entry.current?.frame === el) return;
    drop(entry.current);
    entry.current = el ? { frame: el, spec: specRef, field } : null;
    if (entry.current) composers.set(el!, entry.current);
  });
  useLayoutEffect(() => () => drop(entry.current), []);
  const current = useSyncExternalStore(subscribe, getLive, getLive);
  return {
    listening: !!current && !!frame.current?.contains(current),
    toggle: () => {
      const el = field?.current ?? frame.current?.querySelector<HTMLElement>("textarea, input");
      if (el) void loadDictation().then((m) => m.toggleInto(el));
    },
  };
}

function drop(e: ComposerEntry | null): void {
  if (!e || composers.get(e.frame) !== e) return;
  composers.delete(e.frame);
  for (const fn of composerGone) fn(e.frame);
}
