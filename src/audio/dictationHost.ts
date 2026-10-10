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
//   3. Kept words then get the AI polish where their composer asks for it
//      (dictationPolish.ts), and for a while any word the user corrects is
//      learned (vocabLearn.ts).
//   4. Esc cancels; another gesture taking the mic — the voice panel's, or
//      another composer's mic button — keeps the words heard so far, and so
//      does a composer that closes mid-capture (lib/dictationComposer.ts).

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { DictationStrip, STRIP_BARS, levelHeight, strip, type StripAnchor, type StripState } from "../components/DictationStrip";
import { composerGone, setDictationLive } from "../lib/dictationComposer";
import { quietFor } from "./audible";
import { broker as appBroker, type DictationBroker } from "./dictationBroker";
import { cleanupDictation, fitToContext, spokenBreaks } from "./dictationCleanup";
import { cleanupChild, polished, polishEnabled, POLISH_SETTLE_MS, wantsPolish, type PolishEngine } from "./dictationPolish";
import {
  canSend,
  composerAt,
  placeText,
  resolveTarget,
  submitAfter,
  targetElement,
  targetFor,
  type Composer,
  type DictationTarget,
  type Placed,
} from "./dictationTarget";
import { PREROLL_CLEAR_MS, type DictationErrorEvent } from "./dictationTypes";
import { isBenignDictationError, isNonSpeech } from "./utterance";
import { setVoiceAway } from "./voiceAway";
import { APP_KEYS, VoiceHotkey, type KeySource } from "./voiceHotkey";
import { readIntents } from "./voiceIntents";
import { buildVocab, learnPair, loadVocabStore, memoryVocab, onVocabStore, updateVocabStore, type VocabStore } from "./vocab";
import { watchCorrections, type Correction, type CorrectionWatch } from "./vocabLearn";

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
  /** The conversation it shows (its voice key). */
  key: string;
  start(since: number): void;
  stop(): void;
  cancel(): void;
}

interface Session {
  mode: "hold" | "lock";
  since: number;
  target: DictationTarget;
  /** The composer the words go into, as it registered. */
  composer: Composer | null;
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
  polish: PolishEngine;
}

/** How long the memory index's names are reused before they are read again. */
const MEMORY_FRESH_MS = 10 * 60_000;
/** How long a conversation a background turn woke stays up for the next
 *  one once its reply is done: then its child is let go, as closing its
 *  panel lets it go (its memory stays, and the next turn resumes it). */
export const BACKGROUND_WARM_MS = 2 * 60_000;

export class DictationHost {
  readonly hotkey: VoiceHotkey;
  private session: Session | null = null;
  /** The last dictation written, for "scratch that" and "undo". */
  private last: Placed | null = null;
  /** Watching the last dictation's words for the user's corrections. */
  private watch: CorrectionWatch | null = null;
  private store: VocabStore = { words: [], pairs: [] };
  private memory: string[] = [];
  private memoryAt = -Infinity;
  private levels: number[] = [];
  /** Conversations a background turn woke, each with its timer to sleep. */
  private woken = new Map<string, ReturnType<typeof setTimeout>>();

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
    // The composer the words were going into closed (the compact card,
    // tapped away): the capture stands down, and its words are kept.
    composerGone.add((frame) => {
      const s = this.session;
      if (s && !s.over && s.composer?.frame === frame) void this.finish();
    });
    onVocabStore((store) => (this.store = store));
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
      this.session = { mode, since, target, composer: null, taker, talk: null, vocab: [], heard: false, started: Promise.resolve(true), over: false };
      taker.start(since);
      return;
    }
    const talk = this.deps.conversation();
    const vocab = buildVocab({ plan: talk?.markdown(), store: this.store, memory: this.memory });
    const turn = target.kind === "turn";
    const s: Session = {
      mode,
      since,
      target,
      composer: composerAt(targetElement(target)),
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
      owner: DICTATION_OWNER,
      phase: "listening",
      text: "",
      levels: [],
      anchor: this.anchorFor(target, s.composer),
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
    this.show({ phase: "placing", hint: "" });
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
      await this.place(s, text);
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
    this.show(null);
    this.end(s);
  }

  /** A composer's mic button: lock the mic open into its field, or finish.
   *  Pressed while another composer's capture runs, the newest press wins:
   *  that capture stands down, its words written where they were going.
   *  While a capture is being placed, a press does nothing. */
  toggleInto(el: HTMLElement): void {
    const s = this.session;
    if (s) {
      if (s.taker || s.over) return;
      const again = targetElement(s.target) === el;
      void this.finish().then(() => {
        if (!again) this.toggleInto(el);
      });
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
    this.show({ text });
  }

  private level(rms: number): void {
    if (!this.session || this.session.over) return;
    this.levels = [...this.levels.slice(1 - STRIP_BARS), levelHeight(rms)];
    this.show({ levels: this.levels });
  }

  /** Change the strip — only while it is this host's, or nobody's: the voice
   *  panel's own push-to-talk shows its capture there too. */
  private show(next: Partial<StripState> | null): void {
    const shown = strip.get();
    if (shown && shown.owner !== DICTATION_OWNER) return;
    if (!next) strip.set(null);
    else if (next.phase === "notice") strip.set({ owner: DICTATION_OWNER, phase: "notice", text: "", levels: [], anchor: null, hint: "", ...next });
    else if (shown) strip.update(next);
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

  private async place(s: Session, said: string): Promise<void> {
    const heldMs = s.mode === "hold" ? Date.now() - s.since : null;
    const text = said.trim();
    // A tap, a cough, a breath: the transcriber's filler is not words.
    if (isNonSpeech({ text: spokenBreaks(said).trim(), heldMs, heard: s.heard })) return this.notice("Didn't catch that");
    if (s.target.kind === "turn") {
      if (s.talk) return this.sendTurn(s.talk, text);
      return this.nowhere(text, "No text box to type into");
    }
    const el = targetElement(s.target);
    // The composer closed under the capture: its words are kept if it keeps
    // them (the door's draft), else offered for copying.
    const keep = el && !el.isConnected ? s.composer?.spec.keep : undefined;
    if (el && !el.isConnected && !keep) return this.nowhere(text, "The text box closed");
    // Breaks the recognizer wrote itself go through as the commands they are.
    const intents = readIntents(spokenBreaks(said).trim(), { canSend: !keep && canSend(s.target) });
    // "Scratch that" and "undo" act on the last dictation into this field.
    for (const edit of intents.edits) if (this.last && this.last.el === el) this.last.takeBack(edit === "undo");
    const cleaned = cleanupDictation(intents.text, { vocab: s.vocab, pairs: this.store.pairs });
    if (keep) {
      if (cleaned) keep((draft) => draft + fitToContext(cleaned, draft));
      return this.notice("Kept in the draft");
    }
    if (cleaned) {
      const placed = placeText(s.target, cleaned);
      if (placed) {
        this.last = placed;
        // Sent at once by "send it": nothing left to polish or correct.
        if (!intents.send) this.follow(s, placed);
      }
    }
    this.show(null);
    if (intents.send) await submitAfter(s.target);
  }

  /** After words land: learn what the user corrects in them, and polish
   *  them where their composer asks for it. */
  private follow(s: Session, placed: Placed): void {
    this.watch?.stop();
    const watch = placed.around ? watchCorrections(placed.around, (c) => this.learn(c)) : null;
    this.watch = watch;
    if (!placed.replace || !s.composer?.spec.polish || !polishEnabled() || !wantsPolish(placed.text())) return;
    const words = placed.text();
    const at = Date.now();
    void this.deps.polish.polish(words.trim(), s.vocab).then(
      async (reply) => {
        const around = placed.around;
        const after = around ? around.value().slice(around.span()[1]) : "";
        const next = polished(words, reply, s.vocab, after);
        if (!next) return;
        const wait = at + POLISH_SETTLE_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        // Only over the words as written: not over the user's, nor over
        // what "scratch that" left.
        if (placed.text() === words && placed.replace!(next)) watch?.rebase();
      },
      // The words stay as the rules wrote them.
      () => {},
    );
  }

  private learn(c: Correction): void {
    void updateVocabStore((store) => learnPair(store, c.heard, c.meant, Date.now())).catch(() => {});
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
      this.sleepLater(talk.key);
    } catch (e) {
      this.nowhere(text, `Couldn't reach the discussion (${String(e)})`);
    }
  }

  /** Let a conversation a background turn woke go once its reply is done
   *  and nothing has used it for `BACKGROUND_WARM_MS` — never while its
   *  panel is open (closing the panel lets it go). Without this, every
   *  plan talked to with the panel closed kept a child running until quit. */
  private sleepLater(key: string): void {
    clearTimeout(this.woken.get(key));
    this.woken.set(
      key,
      setTimeout(() => {
        this.woken.delete(key);
        if (this.deps.taker()?.key === key) return;
        void this.deps
          .invoke<{ inFlight: boolean }>("voice_session_status", { sessionId: key })
          .then((status) => {
            if (status.inFlight) this.sleepLater(key);
            else if (this.deps.taker()?.key !== key) return this.deps.invoke("voice_session_stop", { sessionId: key });
          })
          .catch(() => {});
      }, BACKGROUND_WARM_MS),
    );
  }

  /** Words that found no home are never lost: offered for copying. */
  private nowhere(text: string, why: string): void {
    this.show({ phase: "notice", text: `${why} — “${text}”`, anchor: null, copy: text });
  }

  private notice(text: string): void {
    this.show({ phase: "notice", text, anchor: strip.get()?.anchor ?? null });
  }

  private end(s: Session): void {
    s.over = true;
    if (this.session !== s) return;
    this.session = null;
    setDictationLive(null);
    if (strip.get()?.phase !== "notice") this.show(null);
    this.hotkey.dispatch({ type: "settled" });
    void this.refreshStore();
  }

  private anchorFor(t: DictationTarget, composer: Composer | null): StripAnchor | null {
    // A document: the line the caret is on, across the page's width.
    if (t.kind === "rich") {
      const { editor, el } = t;
      const frame = composer?.frame ?? el;
      return {
        rect() {
          if (editor.isDestroyed || !frame.isConnected) return null;
          const page = frame.getBoundingClientRect();
          const at = editor.view.coordsAtPos(editor.state.selection.from);
          return new DOMRect(page.left, at.top, page.width, at.bottom - at.top);
        },
      };
    }
    const el = targetElement(t);
    if (el) return composer?.frame ?? el.closest(".xterm") ?? el;
    const doc = this.deps.doc;
    if (t.kind === "page") {
      return doc.querySelector("[data-browser-chat-composer]") ?? doc.querySelector('input[aria-label="Address or search"]');
    }
    return doc.querySelector(".rl-discuss-pill");
  }

  private async refreshStore(): Promise<void> {
    this.store = await loadVocabStore();
    // The memory index's names, read again now and then: its titles change
    // as the user plans, not between two dictations.
    const now = Date.now();
    if (now - this.memoryAt < MEMORY_FRESH_MS) return;
    this.memoryAt = now;
    try {
      const nodes = await this.deps.invoke<{ title: string }[] | null>("classmem_tree");
      this.memory = memoryVocab((nodes ?? []).map((n) => n.title));
    } catch {
      // No memory index: the plan and the user's words are enough.
    }
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
    polish: cleanupChild,
  });
  host = h;
  h.hotkey.attach(window);
  // A web page in the browser pane hears the key itself and says so.
  void listen<{ label: string; kind: string; value?: unknown }>("browser-page-event", ({ payload }) => {
    if (payload.kind === "voice" && typeof payload.value === "string") h.hotkey.page(payload.label, payload.value);
  }).catch(() => {});
  mountStrip();
  return h;
}

let stripMounted = false;

/** Put the strip on the page, once: in a status region that the front door's
 *  sweep leaves live, so a screen reader hears what the strip says. The voice
 *  panel shows its own capture there too. */
export function mountStrip(): void {
  if (stripMounted) return;
  stripMounted = true;
  const root = document.createElement("div");
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  document.body.appendChild(root);
  createRoot(root).render(createElement(DictationStrip));
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
