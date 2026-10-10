// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The one way into the microphone. Every capture belongs to an owner — a
// string naming the surface capturing, passed through to dictation.rs, which
// enforces that one owner holds the mic at a time and echoes the owner on
// every event (dictationTypes.ts has the native contract). The broker is the
// frontend half of that rule:
//
// - **Routing.** An owner `attach`es its handlers once; each event reaches
//   only the owner it names. A listener that heard every capture's partials
//   (as each surface's own hook used to) would paint another surface's words.
// - **Who wins.** A direct gesture — a held key, a press of a mic button —
//   starts as `hold` and takes the mic from whoever has it; that owner hears
//   `preempted` with what its capture had heard, so no words are lost. An
//   automatic start (hands-free listening again) is `open`, and is refused
//   while anyone else holds the mic.
// - **Order.** A start waits for the same owner's stop to land first:
//   reaching the mic before it would read as the holder's repeated press.
// - **Cleanup.** Detaching an owner (its surface unmounting) cancels its
//   capture, and only its own: never anyone else's, never the warm mic.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  DictationErrorEvent,
  DictationGrant,
  DictationLevel,
  DictationOwner,
  DictationPreempted,
  DictationText,
} from "./dictationTypes";

export interface CaptureHandlers {
  partial?: (text: string) => void;
  level?: (level: DictationLevel) => void;
  error?: (e: DictationErrorEvent) => void;
  /** Another owner's gesture took the mic; `text` is what this capture had
   *  heard by then. */
  preempted?: (by: DictationOwner, text: string) => void;
}

export interface StartOptions {
  /** "hold" for a direct gesture (takes the mic), "open" for an automatic
   *  start (yields). */
  kind: "hold" | "open";
  /** The ranked vocabulary (vocab.ts). */
  vocab?: string[];
  /** False while Redline's own voice is in the warm mic's pre-roll. */
  preroll?: boolean;
}

interface Bridge {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(event: string, fn: (e: { payload: T }) => void) => Promise<UnlistenFn>;
}

export class DictationBroker {
  private routes = new Map<DictationOwner, CaptureHandlers>();
  private holder: DictationOwner | null = null;
  private stopping = new Map<DictationOwner, Promise<string>>();
  private wired: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly bridge: Bridge = { invoke, listen }) {}

  /** Who holds the mic, as far as this window knows. */
  current(): DictationOwner | null {
    return this.holder;
  }

  /** Called whenever the holder changes. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Route `owner`'s events to `handlers`. The returned detach also cancels
   *  the owner's capture if it is live. */
  attach(owner: DictationOwner, handlers: CaptureHandlers): () => void {
    this.routes.set(owner, handlers);
    void this.wire();
    return () => {
      if (this.routes.get(owner) === handlers) this.routes.delete(owner);
      if (this.holder === owner) this.cancel(owner);
    };
  }

  /** Begin a capture for `owner`. Resolves with the grant: `granted: false`
   *  when an open start met another owner's capture. */
  async start(owner: DictationOwner, opts: StartOptions): Promise<DictationGrant> {
    await this.wire();
    await this.stopping.get(owner)?.catch(() => "");
    const grant = await this.bridge.invoke<DictationGrant | null>("dictation_start", { owner, ...opts });
    // An older backend answers nothing: it started. The owner it took the
    // mic from hears so from `dictation-preempted`, with its words.
    const granted = grant?.granted ?? true;
    if (granted) this.setHolder(owner);
    return grant ?? { granted: true, holder: owner };
  }

  /** End `owner`'s capture and get its final transcript ("" when it no
   *  longer held the mic). */
  stop(owner: DictationOwner): Promise<string> {
    if (this.holder === owner) this.setHolder(null);
    const done = this.bridge
      .invoke<string>("dictation_stop", { owner })
      .then((text) => text ?? "")
      .finally(() => {
        if (this.stopping.get(owner) === done) this.stopping.delete(owner);
      });
    this.stopping.set(owner, done);
    return done;
  }

  /** Drop `owner`'s capture, text and all. The mic stays warm. */
  cancel(owner: DictationOwner): void {
    if (this.holder === owner) this.setHolder(null);
    void this.bridge.invoke("dictation_kill_all", { owner }).catch(() => {});
  }

  private setHolder(owner: DictationOwner | null): void {
    if (this.holder === owner) return;
    this.holder = owner;
    for (const fn of this.listeners) fn();
  }

  /** Subscribe to the native events once, for every owner. */
  private wire(): Promise<void> {
    this.wired ??= Promise.all([
      this.bridge.listen<DictationText>("dictation-partial", ({ payload }) =>
        this.routes.get(payload.owner)?.partial?.(payload.text),
      ),
      this.bridge.listen<DictationLevel>("dictation-level", ({ payload }) =>
        this.routes.get(payload.owner)?.level?.(payload),
      ),
      this.bridge.listen<DictationErrorEvent>("dictation-error", ({ payload }) =>
        this.routes.get(payload.owner)?.error?.(payload),
      ),
      this.bridge.listen<DictationPreempted>("dictation-preempted", ({ payload }) => {
        if (this.holder === payload.owner) this.setHolder(payload.by);
        this.routes.get(payload.owner)?.preempted?.(payload.by, payload.text);
      }),
    ]).then(
      () => {},
      () => {
        // Outside the app (a test without the event bridge): nothing to hear.
      },
    );
    return this.wired;
  }
}

/** The app's one broker. */
export const broker = new DictationBroker();
