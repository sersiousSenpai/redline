// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Dictation everywhere: one controller for the hold-to-dictate key and every
// composer's mic button. A lazy chunk, installed after the first actionable
// frame (App) or by the first mic press.
//
// A dictation is one capture under the `dictation` owner (dictationBroker.ts):
//   1. the key goes down (voiceHotkey.ts) or a mic button is pressed: the
//      target is resolved where the cursor is (dictationTarget.ts), and the
//      strip shows the waveform and the words as they come (DictationStrip);
//   2. the key comes up (or the button is pressed again): the final
//      transcript, unless it was no speech at all, goes through the spoken
//      commands (voiceIntents.ts) and the rule cleanup (dictationCleanup.ts)
//      into the target — or, with nothing that takes text focused, becomes a
//      turn in the plan's or the Drafter's conversation: through the voice
//      panel's own push-to-talk when it is open, otherwise sent in the
//      background, the Discuss pill showing that a reply is coming. Turns are
//      never cleaned up. Nothing moves focus, and nothing opens the panel.
//   3. Esc cancels; another key's gesture taking the mic keeps the words
//      heard so far.

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { DictationStrip, STRIP_BARS, levelHeight, strip } from "../components/DictationStrip";
import { setDictationLive } from "../lib/useDictation";
import { quietFor } from "./audible";
import { broker as appBroker, type DictationBroker } from "./dictationBroker";
import { cleanupDictation } from "./dictationCleanup";
import {
  canSend,
  placeText,
  resolveTarget,
  submitAfter,
  targetElement,
  targetFor,
  type DictationTarget,
  type Placed,
} from "./dictationTarget";
import { PREROLL_CLEAR_MS, type DictationErrorEvent } from "./dictationTypes";
import { isBenignDictationError, isNonSpeech } from "./utterance";
import { setVoiceAway } from "./voiceAway";
import { APP_KEYS, VoiceHotkey, type KeySource } from "./voiceHotkey";
import { readIntents } from "./voiceIntents";
import { buildVocab, loadVocabStore, type VocabStore } from "./vocab";

/** The owner every dictation captures as (the key, a mic button). */
export const DICTATION_OWNER = "dictation";

/** The conversation a dictation with no text box to go to becomes a turn in:
 *  the open plan's, or the Drafter's. */
export interface TalkContext {
  key: string;
  markdown: () => string;
  cwd: string | null;
}

/** The open voice panel: it takes a turn as its own push-to-talk, so the
 *  turn interrupts a reply in place and the answer is spoken. */
export interface TurnTaker {
  start(since: number): void;
  stop(): void;
  cancel(): void;
}

interface Session {
  mode: "hold" | "lock";
  since: number;
  target: DictationTarget;
  /** The voice panel took it. */
  taker: TurnTaker | null;
  /** A turn sent in the background. */
  talk: TalkContext | null;
  vocab: string[];
  /** The live recognizer heard words. */
  heard: boolean;
  /** Whether the mic was had. */
  started: Promise<boolean>;
  /** Finished, cancelled or taken: later events are stale. */
  over: boolean;
}

export interface HostDeps {
  broker: DictationBroker;
  doc: Document;
  conversation: () => TalkContext | null;
  taker: () => TurnTaker | null;
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

export class DictationHost {
  readonly hotkey: VoiceHotkey;
  private session: Session | null = null;
  /** The last dictation written, for "scratch that" and "undo". */
  private last: Placed | null = null;
  private store: VocabStore = { words: [], pairs: [] };
  private levels: number[] = [];

  constructor(private readonly deps: HostDeps) {
    this.hotkey = new VoiceHotkey({
      start: (mode, since, source) => this.start(mode, since, source),
      finish: () => void this.finish(),
      cancel: () => this.cancel(),
    });
    deps.broker.attach(DICTATION_OWNER, {
      partial: (text) => this.partial(text),
      level: (l) => this.level(l.rms),
      error: (e) => this.failed(e),
      // Another gesture took the mic (the voice panel's talk button): what
      // this capture heard is still written.
      preempted: (_by, text) => void this.finish(text),
    });
    void this.refreshStore();
  }

  /** Whether a dictation is under way. */
  busy(): boolean {
    return this.session !== null;
  }

  start(mode: "hold" | "lock", since: number, source: KeySource, fixed?: DictationTarget): void {
    if (this.session) return;
    const target = fixed ?? resolveTarget(this.deps.doc, source);
    const taker = target.kind === "turn" ? this.deps.taker() : null;
    if (taker) {
      this.session = { mode, since, target, taker, talk: null, vocab: [], heard: false, started: Promise.resolve(true), over: false };
      taker.start(since);
      return;
    }
    const talk = this.deps.conversation();
    const vocab = buildVocab({ plan: talk?.markdown(), store: this.store });
    const turn = target.kind === "turn";
    const s: Session = {
      mode,
      since,
      target,
      taker: null,
      talk: turn ? talk : null,
      vocab,
      heard: false,
      started: Promise.resolve(false),
      over: false,
    };
    this.session = s;
    this.levels = [];
    setDictationLive(targetElement(target));
    const verb = !turn ? "insert" : talk ? "send" : "copy";
    strip.set({
      phase: "listening",
      text: "",
      levels: [],
      anchor: this.anchorFor(target),
      hint: mode === "hold" ? `release to ${verb}` : `tap again to ${verb} · esc cancels`,
    });
    s.started = this.deps.broker
      .start(DICTATION_OWNER, {
        kind: "hold",
        vocab,
        // Redline's own voice in the warm mic's last 300 ms is not the user.
        preroll: quietFor() > PREROLL_CLEAR_MS,
      })
      .then(
        (grant) => {
          if (!grant.granted) this.fail(s, "The microphone is busy");
          return grant.granted;
        },
        (e) => {
          this.fail(s, String(e));
          return false;
        },
      );
  }

  /** The key came up, the button was pressed again, or another gesture took
   *  the mic (`taken`: what had been heard). */
  async finish(taken?: string): Promise<void> {
    const s = this.session;
    if (!s || s.over) {
      if (!s) this.hotkey.dispatch({ type: "settled" });
      return;
    }
    s.over = true;
    if (s.taker) {
      s.taker.stop();
      this.end(s);
      return;
    }
    strip.update({ phase: "placing", hint: "" });
    let text = taken ?? "";
    if (taken === undefined) {
      if (!(await s.started)) return;
      try {
        text = await this.deps.broker.stop(DICTATION_OWNER);
      } catch (e) {
        this.fail(s, String(e));
        return;
      }
    }
    try {
      await this.place(s, text.trim());
    } finally {
      this.end(s);
    }
  }

  /** Esc: nothing is written. */
  cancel(): void {
    const s = this.session;
    if (!s) return;
    s.over = true;
    if (s.taker) s.taker.cancel();
    else {
      this.deps.broker.cancel(DICTATION_OWNER);
      // A start still on its way would open the mic after this cancel.
      void s.started.then((ok) => {
        if (ok && !this.session) this.deps.broker.cancel(DICTATION_OWNER);
      });
    }
    strip.set(null);
    this.end(s);
  }

  /** A composer's mic button: lock the mic open into its field, or finish. */
  toggleInto(el: HTMLElement): void {
    const s = this.session;
    if (s) {
      if (!s.taker && targetElement(s.target) === el) void this.finish();
      return;
    }
    const target = targetFor(el);
    if (!target || target.kind === "turn" || target.kind === "page") return;
    // The key's tap now ends it, and Esc cancels it, as for a lock.
    this.hotkey.dispatch({ type: "locked", at: Date.now() });
    this.start("lock", Date.now(), APP_KEYS, target);
  }

  private partial(text: string): void {
    const s = this.session;
    if (!s || s.over || s.taker) return;
    if (text.trim()) s.heard = true;
    strip.update({ text });
  }

  private level(rms: number): void {
    if (!this.session || this.session.over) return;
    this.levels = [...this.levels.slice(1 - STRIP_BARS), levelHeight(rms)];
    strip.update({ levels: this.levels });
  }

  private failed(e: DictationErrorEvent): void {
    const s = this.session;
    if (!s || s.over || s.taker) return;
    // "No speech detected": the hold carries on to its release.
    if (isBenignDictationError(e)) return;
    s.over = true;
    // The capture a failed task leaves open would turn the next start away.
    this.deps.broker.cancel(DICTATION_OWNER);
    this.fail(s, e.error);
  }

  private fail(s: Session, message: string): void {
    s.over = true;
    this.notice(message);
    this.end(s);
  }

  private async place(s: Session, text: string): Promise<void> {
    const heldMs = s.mode === "hold" ? Date.now() - s.since : null;
    // A tap, a cough, a breath: the transcriber's filler is not words.
    if (isNonSpeech({ text, heldMs, heard: s.heard })) return this.notice("Didn't catch that");
    if (s.target.kind === "turn") {
      if (s.talk) return this.sendTurn(s.talk, text);
      return this.nowhere(text, "No text box to type into");
    }
    const el = targetElement(s.target);
    if (el && !el.isConnected) return this.nowhere(text, "The text box closed");
    const intents = readIntents(text, { canSend: canSend(s.target) });
    // "Scratch that" and "undo" act on the last dictation into this field.
    for (const edit of intents.edits) if (this.last && this.last.el === el) this.last.takeBack(edit === "undo");
    const cleaned = cleanupDictation(intents.text, { vocab: s.vocab, pairs: this.store.pairs });
    if (cleaned) {
      const placed = placeText(s.target, cleaned);
      if (placed) this.last = placed;
    }
    strip.set(null);
    if (intents.send) await submitAfter(s.target);
  }

  /** A turn in the conversation, the panel closed: sent as the panel would,
   *  a reply still running interrupted rather than refused. The Discuss pill
   *  shows the reply coming, then waiting. */
  private async sendTurn(talk: TalkContext, text: string): Promise<void> {
    const call = this.deps.invoke;
    const send = () => call("voice_send", { sessionId: talk.key, text, label: text });
    try {
      await call("voice_session_start", { sessionId: talk.key, planMarkdown: talk.markdown(), cwd: talk.cwd });
      try {
        await send();
      } catch (e) {
        if (!String(e).includes("still streaming")) throw e;
        await call("voice_interrupt", { sessionId: talk.key });
        for (let i = 0; i < 30; i++) {
          const status = await call<{ inFlight: boolean }>("voice_session_status", { sessionId: talk.key });
          if (!status.inFlight) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        await send();
      }
      setVoiceAway({ key: talk.key, state: "thinking" });
      this.notice("Sent to the discussion");
    } catch (e) {
      this.nowhere(text, `Couldn't reach the discussion (${String(e)})`);
    }
  }

  /** Words that found no home are never lost: offered for copying. */
  private nowhere(text: string, why: string): void {
    strip.set({ phase: "notice", text: `${why} — “${text}”`, levels: [], anchor: null, hint: "", copy: text });
  }

  private notice(text: string): void {
    const shown = strip.get();
    strip.set({ phase: "notice", text, levels: [], anchor: shown?.anchor ?? null, hint: "" });
  }

  private end(s: Session): void {
    s.over = true;
    if (this.session !== s) return;
    this.session = null;
    setDictationLive(null);
    if (strip.get()?.phase !== "notice") strip.set(null);
    this.hotkey.dispatch({ type: "settled" });
    void this.refreshStore();
  }

  private anchorFor(t: DictationTarget): Element | null {
    const el = targetElement(t);
    if (el) return el.closest("[data-dictation-anchor]") ?? el.closest(".xterm") ?? el;
    const doc = this.deps.doc;
    if (t.kind === "page") {
      return doc.querySelector("[data-browser-chat-composer]") ?? doc.querySelector('input[aria-label="Address or search"]');
    }
    return doc.querySelector(".rl-discuss-pill");
  }

  private async refreshStore(): Promise<void> {
    this.store = await loadVocabStore();
  }
}

let host: DictationHost | null = null;
let conversation: () => TalkContext | null = () => null;
let taker: TurnTaker | null = null;

function ensure(): DictationHost {
  if (host) return host;
  const h = new DictationHost({
    broker: appBroker,
    doc: document,
    conversation: () => conversation(),
    taker: () => taker,
    invoke,
  });
  host = h;
  h.hotkey.attach(window);
  // A web page in the browser pane hears the key itself and says so.
  void listen<{ label: string; kind: string; value?: unknown }>("browser-page-event", ({ payload }) => {
    if (payload.kind === "voice" && typeof payload.value === "string") h.hotkey.page(payload.label, payload.value);
  }).catch(() => {});
  // A status region: the front door's sweep leaves it live, and a screen
  // reader hears what the strip says.
  const root = document.createElement("div");
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  document.body.appendChild(root);
  createRoot(root).render(createElement(DictationStrip));
  return h;
}

/** Start listening for the key. `talk` names the conversation a dictation
 *  with nowhere to type becomes a turn in, read at the moment it starts. */
export function installDictation(talk: () => TalkContext | null): void {
  conversation = talk;
  ensure();
}

/** A composer's mic button. */
export function toggleInto(el: HTMLElement): void {
  ensure().toggleInto(el);
}

/** The voice panel, while open, takes the turns. */
export function registerTurnTaker(t: TurnTaker): () => void {
  taker = t;
  return () => {
    if (taker === t) taker = null;
  };
}
