// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// When a hands-free turn is over, and what talking over a reply means.
//
// The clock is the mic's own: one `dictation-level` window is 50 ms of audio,
// so every wait below is measured in audio heard, never in timers that drift
// behind a busy UI thread. Silence is real silence (vad.ts), not "the
// transcript stopped growing".
//
// **The user's turn ends** after
// - 700 ms of silence when what they said sounds finished;
// - 2.5 s when it trails off mid-thought ("…and", "…the", "um", a comma);
// - 6 s, the cap, after "hold on" — or when words stop changing although the
//   mic never goes quiet (a room the floor can't tell from a voice);
// - 250 ms after "send now";
// - 2.5 s after the words stop changing, when the mic is too quiet ever to
//   hear a voice in them.
// It waits up to 300 ms more for the transcript to catch up with the audio,
// so the words it judges include the last one.
// An optional scorer (a small end-of-turn model, `turn_scorer` in Rust) can
// move the first case: asked after 250 ms of silence, a sure "finished"
// (≥ 0.95) ends the turn at 600 ms; at 700 ms an unsure one (< 0.5) holds it,
// asked again every 250 ms up to the 2.5 s of a mid-thought pause. A scorer
// that fails, or is slower than `SCORE_WAIT_MS`, leaves the plain rule.
//
// **After the turn ends** the floor is the agent's, and how far the mic keeps
// listening depends on where the reply plays (`listenThrough`):
// - speaking again within 1.5 s, before the reply is heard, is the same turn
//   carrying on: `resume`, and the next `end` is its rest;
// - two words over a running reply interrupt it, or "stop" or "wait" alone:
//   `barge`;
// - fewer, then silence (a "yeah", a cough heard as a word): `drop`;
// - on speakers the mic hears the reply itself, so from its first sound until
//   the floor comes back everything is ignored.

import type { OutputRoute } from "./dictationTypes";
import { LEVEL_MS, VoiceActivity, looksUnfinished, type Level } from "./vad";

/** Silence that ends a turn that sounds finished… */
export const END_SILENCE_MS = 700;
/** …one that sounds mid-thought, and the longest a scorer may hold one. */
export const UNFINISHED_SILENCE_MS = 2500;
/** "Hold on", and a transcript that stops changing under a mic that never
 *  goes quiet. */
export const CAP_MS = 6000;
/** "Send now" ends the turn as soon as they stop. */
export const SEND_NOW_SILENCE_MS = 250;
/** A turn ends only once the transcript has caught up with the audio, or
 *  this long after the rule's time: the recognizer writes the last word
 *  0.27 s after the voice stops (p90 0.47 s, now and then over 0.7 s), and
 *  until it has, the words being judged may lack the one that trails off. */
export const CATCH_UP_MS = 300;
/** Speaking again this soon after a turn ended, before its reply is heard,
 *  carries that turn on. */
export const RESUME_MS = 1500;
/** Loud windows in a row that count as speaking again: long enough to be a
 *  voice, not a click (150 ms). */
const RESUME_RUN = 3;
/** Words over a running reply that interrupt it — or one of these alone. */
export const BARGE_WORDS = 2;
const STOP_WORD = /^\W*(?:stop|wait|pause|quiet|hold on|hang on)\W*$/i;

/** The scorer is first asked after this much silence… */
export const SCORE_AFTER_MS = 250;
/** …and when at least this sure it is finished, ends the turn here, once the
 *  transcript has caught up: no sooner, or a trailing "and" not yet written
 *  could not hold the turn (the recognizer wrote the last word 0.27 s after
 *  the voice stopped on the dictation test set, p90 0.47 s)… */
export const SCORE_SURE = 0.95;
export const EARLY_END_MS = 600;
/** …and from `END_SILENCE_MS` on, asked every `SCORE_EVERY_MS`, ends it at
 *  this, holding it until `UNFINISHED_SILENCE_MS` otherwise. */
export const SCORE_DONE = 0.5;
export const SCORE_EVERY_MS = 250;
/** An answer slower than this (in audio) is not waited for. */
export const SCORE_WAIT_MS = 200;

export type EndReason = "silence" | "unfinished" | "scored" | "cap" | "send-now";

/** How likely it is the speaker has finished, 0–1; null when it can't say. */
export type Scorer = () => number | null | Promise<number | null>;

export interface EndpointerEvents {
  /** The user's turn is over. `text` is what they said, a spoken command
   *  taken off; `resumed` when it carries on the turn before. */
  end(text: string, reason: EndReason, resumed: boolean): void;
  /** They spoke again right after their turn ended, before its reply was
   *  heard: what follows is the rest of that turn. */
  resume(): void;
  /** They talked over a running reply. */
  barge(): void;
  /** Words while the agent had the floor that never became an interruption. */
  drop(): void;
}

/** How far the mic listens once the user's turn ends, by where the reply
 *  plays: through the reply on wired headphones (the mic can't hear it);
 *  until it starts on speakers; not past the turn on Bluetooth, whose mic
 *  holds the headset in call quality for as long as it is open. */
export type ListenThrough = "reply" | "thinking" | "turn";

export function listenThrough(route: OutputRoute | null | undefined): ListenThrough {
  if (route?.transport === "bluetooth") return "turn";
  return route?.kind === "headphones" ? "reply" : "thinking";
}

const SEND_NOW = /[\s,;:—–-]*\bsend (?:it |that )?now[\s.!?]*$/i;
const HOLD_ON = /[\s,;:—–-]*\b(?:hold on|hang on|wait a (?:sec|second|moment|minute)|one (?:sec|second|moment)|let me think)[\s.,!?…]*$/i;

/** A spoken command at the end of `text`: "send now", or "hold on" and its
 *  kin. */
export function endCommand(text: string): "send" | "hold" | null {
  if (SEND_NOW.test(text)) return "send";
  if (HOLD_ON.test(text)) return "hold";
  return null;
}

/** `text` without a trailing spoken command. */
export function stripCommand(text: string): string {
  return text.replace(SEND_NOW, "").replace(HOLD_ON, "").trim();
}

const words = (text: string) => text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)?.length ?? 0;

interface Ask {
  /** The pause it was asked in, and how much silence it had heard. */
  pause: number;
  silence: number;
  /** The audio clock when asked. */
  at: number;
  /** The answer: undefined while it is on its way. */
  p?: number | null;
}

export class Endpointer {
  private readonly on: EndpointerEvents;
  private readonly vad = new VoiceActivity();
  private scorer: Scorer | null = null;
  /** Audio heard so far, ms. */
  private t = 0;
  /** The current utterance: its words, when they last changed, when it was
   *  last a voice (null: nothing yet), and which stretch of silence this is. */
  private text = "";
  private textAt = 0;
  private lastVoice: number | null = null;
  private pause = 0;
  private resumed = false;
  /** Whose turn it is, and when the user's last one ended. */
  private floor: "user" | "agent" = "user";
  private endedAt = -Infinity;
  /** The reply is sounding; whether the mic still listens to the user then. */
  private audible = false;
  private through: ListenThrough = "thinking";
  private ask: Ask | null = null;

  constructor(on: EndpointerEvents) {
    this.on = on;
  }

  /** A fresh capture: nothing heard yet, and the floor is the user's. The
   *  room's level carries over. */
  reset(): void {
    this.clear();
    this.floor = "user";
    this.endedAt = -Infinity;
  }

  setScorer(scorer: Scorer | null): void {
    this.scorer = scorer;
  }

  setListenThrough(through: ListenThrough): void {
    this.through = through;
  }

  /** The reply started or stopped sounding. One that sounds while the floor
   *  is the user's (read-aloud, a replay, a typed turn's reply) takes it:
   *  where the mic would hear it, what they have said so far goes out as
   *  their turn first; with nothing said, there's no turn of theirs to carry
   *  on. */
  agentAudible(audible: boolean): void {
    this.audible = audible;
    if (audible && this.floor === "user") {
      if (words(this.text) === 0 && !this.resumed) {
        this.floor = "agent";
        this.endedAt = -Infinity;
      } else if (this.through !== "reply") {
        this.finish("send-now");
      }
    }
    if (audible && this.deaf()) this.clear();
  }

  /** A reply the user didn't speak started (a typed turn, a starter): the
   *  floor is the agent's, with no turn of theirs to carry on. */
  replyStarted(): void {
    if (this.floor === "user" && this.lastVoice === null) {
      this.floor = "agent";
      this.endedAt = -Infinity;
    }
  }

  /** The reply is over and nothing is left to hear: the floor is theirs. */
  replyOver(): void {
    this.floor = "user";
  }

  /** "Send now" from a tap: the turn ends at once if they have said
   *  anything — heard, if not yet written (the turn goes out as the
   *  recognizer's final transcript, which has it). */
  sendNow(): void {
    if (this.floor === "user" && (words(this.text) > 0 || this.lastVoice !== null)) this.finish("send-now");
  }

  /** Whether the mic should still be open: false once the reply plays on
   *  speakers, or once the turn is over on a Bluetooth headset. */
  get listening(): boolean {
    if (this.floor === "user") return true;
    if (this.through === "turn") return false;
    return !(this.audible && this.through === "thinking");
  }

  /** One `dictation-level` window. */
  level(level: Level): void {
    this.t += LEVEL_MS;
    if (this.deaf()) return;
    if (!this.vad.push(level)) {
      this.check();
      return;
    }
    if (this.lastVoice === null || this.t - this.lastVoice > LEVEL_MS) this.pause += 1;
    this.lastVoice = this.t;
    if (this.floor === "agent" && !this.audible && this.vad.run >= RESUME_RUN) {
      const onset = this.t - (this.vad.run - 1) * LEVEL_MS;
      if (onset - this.endedAt <= RESUME_MS) {
        this.floor = "user";
        this.resumed = true;
        this.on.resume();
        return;
      }
    }
    // Words that stopped changing under a voice that never stops.
    if (this.floor === "user" && words(this.text) > 0 && this.t - this.textAt >= CAP_MS) {
      this.finish("cap");
    }
  }

  /** The live transcript of the current utterance. */
  partial(text: string): void {
    if (this.deaf()) return;
    // The agent's floor, and no voice since: the recognizer rewriting the
    // turn that just ended (a full stop, a capital) before the next starts,
    // never someone talking over the reply.
    if (this.floor === "agent" && this.lastVoice === null) return;
    const next = text.trim();
    if (next === this.text) return;
    this.text = next;
    this.textAt = this.t;
    if (this.floor === "agent" && (words(next) >= BARGE_WORDS || STOP_WORD.test(next))) {
      this.floor = "user";
      this.on.barge();
      return;
    }
    // Words that land after the silence has run its course end the turn now.
    this.check();
  }

  /** What the mic hears now is the reply, not the user. */
  private deaf(): boolean {
    return this.floor === "agent" && !this.listening;
  }

  private clear(): void {
    this.text = "";
    this.textAt = this.t;
    this.lastVoice = null;
    this.resumed = false;
    this.ask = null;
  }

  private finish(reason: EndReason): void {
    const text = stripCommand(this.text);
    const resumed = this.resumed;
    this.clear();
    this.floor = "agent";
    this.endedAt = this.t;
    this.on.end(text, reason, resumed);
  }

  private check(): void {
    if (this.lastVoice === null) {
      // Words, and never a voice: a mic too quiet for its level to tell them
      // from the room. The words alone end the turn, once they have stopped
      // changing for as long as a pause mid-thought may run.
      if (this.floor === "user" && words(this.text) > 0 && this.t - this.textAt >= UNFINISHED_SILENCE_MS) {
        this.finish("silence");
      }
      return;
    }
    const silent = this.t - this.lastVoice;
    if (words(this.text) === 0) {
      // Breath, a cough, a tap — or words the recognizer hasn't written yet
      // (its first text comes about 0.9 s into the audio): only a long
      // silence makes it noise. A turn that was carrying on still ends then,
      // so the one it carried on is answered.
      if (silent >= UNFINISHED_SILENCE_MS) {
        if (this.floor === "user" && this.resumed) this.finish("silence");
        else this.clear();
      }
      return;
    }
    if (this.floor === "agent") {
      // Words under the reply that never became an interruption.
      if (silent >= END_SILENCE_MS) {
        this.clear();
        this.on.drop();
      }
      return;
    }
    const command = endCommand(this.text);
    if (command === "send") {
      if (silent >= SEND_NOW_SILENCE_MS) this.finish("send-now");
    } else if (command === "hold") {
      if (silent >= CAP_MS) this.finish("cap");
    } else if (looksUnfinished(this.text)) {
      if (silent >= UNFINISHED_SILENCE_MS) this.finish("unfinished");
    } else {
      if (this.scorer && this.shouldAsk(silent)) this.request(silent);
      const done = this.decide(silent);
      if (done) this.finish(done);
    }
  }

  /** This pause's question to the scorer, if it has asked one. */
  private current(): Ask | null {
    return this.ask?.pause === this.pause ? this.ask : null;
  }

  /** Whether to ask the scorer now: once at `SCORE_AFTER_MS`, again at
   *  `END_SILENCE_MS` unless already sure, then every `SCORE_EVERY_MS` while
   *  it says "not finished". Never while an answer is on its way, nor again
   *  after it failed. */
  private shouldAsk(silent: number): boolean {
    if (silent < SCORE_AFTER_MS) return false;
    const ask = this.current();
    if (!ask) return true;
    if (ask.p === undefined || ask.p === null || silent < END_SILENCE_MS) return false;
    if (ask.silence < END_SILENCE_MS) return ask.p < SCORE_SURE;
    return ask.p < SCORE_DONE && silent - ask.silence >= SCORE_EVERY_MS;
  }

  /** Whether a finished-sounding pause has run long enough, and why. */
  private decide(silent: number): EndReason | null {
    if (!this.scorer) return this.plain(silent);
    if (silent >= UNFINISHED_SILENCE_MS) return "unfinished";
    const ask = this.current();
    if (!ask || ask.p === null) return this.plain(silent);
    if (ask.p === undefined) {
      // Not back yet: past the plain rule's time, it waits only so long.
      return this.t - ask.at >= SCORE_WAIT_MS ? this.plain(silent) : null;
    }
    if (ask.p >= SCORE_SURE) return silent >= EARLY_END_MS && this.caughtUp() ? "scored" : this.plain(silent);
    return ask.silence >= END_SILENCE_MS && ask.p >= SCORE_DONE ? "scored" : null;
  }

  /** The plain rule: `END_SILENCE_MS`, once the transcript has caught up. */
  private plain(silent: number): EndReason | null {
    if (silent < END_SILENCE_MS) return null;
    return this.caughtUp() || silent >= END_SILENCE_MS + CATCH_UP_MS ? "silence" : null;
  }

  /** Whether the transcript has changed since the voice stopped (or as it
   *  stopped): the recognizer has written the last word. */
  private caughtUp(): boolean {
    return this.lastVoice !== null && this.textAt >= this.lastVoice - LEVEL_MS;
  }

  /** Ask the scorer about the pause so far. An answer that is a promise is
   *  judged when it lands — unless the pause is over by then. */
  private request(silent: number): void {
    const scorer = this.scorer;
    if (!scorer) return;
    const ask: Ask = { pause: this.pause, silence: silent, at: this.t };
    this.ask = ask;
    let answer: number | null | Promise<number | null>;
    try {
      answer = scorer();
    } catch {
      answer = null;
    }
    const settle = (p: number | null) => {
      ask.p = typeof p === "number" && Number.isFinite(p) ? p : null;
    };
    if (!(answer instanceof Promise)) {
      settle(answer);
      return;
    }
    answer.then(settle, () => settle(null)).then(() => {
      if (this.ask === ask && this.floor === "user") this.check();
    });
  }
}
