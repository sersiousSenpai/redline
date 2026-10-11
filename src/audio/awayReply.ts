// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The reply to a turn the hold key sent with the voice panel closed: spoken,
// and followed on the Discuss pill's caption (voiceCaption.ts), as
// voice-ux-design §5.1 has it. The pill springs open while the agent thinks
// and says its answer; the full text waits in the panel behind the pill's dot.
//
// It speaks through a SpeechQueue and a driver of its own in the user's engine
// (`savedEngineDriver`): the studio voice, which stands Kokoro and then the
// system voice in for itself, Kokoro, or the system voice. A driver of its own
// draws generations of its own, so the voice panel stopping, or a chat's
// read-aloud, never cuts this reply off, nor it them.
//
// One turn at a time, by its id: the events that come before `voice_send`
// answers are held until it says which turn it started, so the tail of a reply
// that turn interrupted is never spoken. The caption shows what the agent is
// doing until the first sentence is said, then each sentence as it is said;
// once the turn has ended and the last one has been said, `done` for
// `LINGER_MS`, and then the caption goes. Esc stops the reply — the speech,
// and the turn if it is still running — and the caption goes at once. A new
// hold of the key hushes it, and the panel opening on its conversation takes
// it over.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { Activity } from "../lib/turnMeter";
import { browserSpeechDriver, loadVoicePrefs, SpeechQueue, type SpeechDriver, type SpeechState } from "./speech";
import { sameTurn, type TurnId } from "./turnState";
import { savedEngineDriver, warmEngine } from "./useReadAloud";
import { voiceCaption } from "./voiceCaption";
import { splitReply, spokenPause } from "./voiceStream";

/** How long the caption stays once the reply has been said. */
export const LINGER_MS = 2000;

interface TurnEvent {
  sessionId: string;
  generation: number;
  /** Null on a `voice-error` about the child itself. */
  turn?: number | null;
}

type AwayEvent =
  | { kind: "meter"; e: TurnEvent & { activity?: Activity | null } }
  | { kind: "delta"; e: TurnEvent & { text: string } }
  | { kind: "done"; e: TurnEvent & { body?: string } }
  | { kind: "interrupted"; e: TurnEvent }
  /** The turn failed, or the child under it did (`voice-exit`). */
  | { kind: "error"; e: TurnEvent };

export interface AwayDeps {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(event: string, fn: (e: { payload: T }) => void) => Promise<() => void>;
  /** A driver of its own in the user's engine (`savedEngineDriver`). */
  driver: () => Promise<{ engine: string; driver: SpeechDriver | null }>;
  /** Intent to hear `engine` (`warmEngine`). */
  warm: (engine: string) => void;
  /** A studio voice surface opened or closed (studioTts.ts). */
  surface: (surface: string, open: boolean) => void;
  /** Where Esc is heard. */
  win: Pick<Window, "addEventListener">;
}

interface Following {
  key: string;
  /** The turn `voice_send` started, once it has said. */
  id: TurnId | null;
  /** Its events from before then. */
  held: AwayEvent[];
  /** The reply so far, raw. */
  raw: string;
  /** How much of its spoken part went to the queue. */
  spokenLen: number;
  ended: boolean;
  /** The sentence being, or last, said. */
  said: string;
}

/** `driver`, telling `onSentence` which sentence is being said: the oldest
 *  one handed to it that hasn't finished (null once none is). */
function narrated(driver: SpeechDriver, onSentence: (text: string | null) => void): SpeechDriver {
  let pending: string[] = [];
  return {
    speak(text, opts, onDone) {
      const mine = pending;
      mine.push(text);
      if (mine.length === 1) onSentence(text);
      driver.speak(text, opts, () => {
        // A sentence from before a cancel finishing late is not news.
        if (mine === pending) {
          mine.shift();
          onSentence(mine[0] ?? null);
        }
        onDone();
      });
    },
    cancel() {
      pending = [];
      driver.cancel();
    },
    pause: () => driver.pause(),
    resume: () => driver.resume(),
    beginTurn: () => driver.beginTurn?.(),
    flush: () => driver.flush?.(),
    heard: () => driver.heard?.() ?? null,
  };
}

export class AwayReply {
  private queue: SpeechQueue | null = null;
  private engine = "";
  private turn: Following | null = null;
  private ready: Promise<void> = Promise.resolve();
  private wired: Promise<void> | null = null;
  private linger: ReturnType<typeof setTimeout> | undefined;
  /** The studio voice surface held open while a reply is followed. */
  private surface: string | null = null;

  constructor(private readonly deps: AwayDeps) {}

  /** A turn to `key` is about to be sent: hush a reply still being said, and
   *  listen for this one's. Resolves once its events can't be missed. */
  async expect(key: string): Promise<void> {
    this.hush();
    const t: Following = { key, id: null, held: [], raw: "", spokenLen: 0, ended: false, said: "" };
    this.turn = t;
    // After the last turn's: two turns never make two queues.
    this.ready = this.ready.then(() => this.prepare(t)).catch(() => {});
    await (this.wired ??= this.wire());
  }

  /** `voice_send` said which turn it started (null: it couldn't say, so the
   *  first one heard from is taken). */
  sent(key: string, id: TurnId | null): void {
    const t = this.turn;
    if (!t || t.key !== key || t.id) return;
    const first = t.held.find((ev) => ev.e.turn != null)?.e;
    t.id = id ?? (first ? { generation: first.generation, turn: first.turn! } : null);
    const held = t.held;
    t.held = [];
    for (const ev of held) this.event(ev);
  }

  /** The send failed: nothing is coming. */
  drop(key: string): void {
    if (this.turn?.key === key) this.close(this.turn);
  }

  /** A new hold of the key: stop saying the last reply, at once. */
  hush(): void {
    clearTimeout(this.linger);
    this.queue?.cancel();
    if (this.turn) this.leave();
    this.turn = null;
  }

  /** Esc: stop the reply, and the turn if it is still running. */
  stop(): void {
    const t = this.turn;
    if (!t) return;
    this.queue?.cancel();
    if (!t.ended) void this.deps.invoke("voice_interrupt", { sessionId: t.key }).catch(() => {});
    this.close(t);
  }

  /** The voice panel opened on `key`: it shows the reply, and speaks what
   *  streams from now on. */
  release(key: string): void {
    const t = this.turn;
    if (!t || t.key !== key) return;
    this.queue?.cancel();
    this.close(t);
  }

  private async prepare(t: Following): Promise<void> {
    const engine = await this.deps
      .invoke<{ engine?: string }>("tts_get_settings")
      .then((s) => s?.engine || "system")
      .catch(() => "system");
    this.deps.warm(engine);
    let q = this.queue;
    if (!q || engine !== this.engine) {
      const picked = await this.deps.driver().catch(() => ({ engine: "system", driver: null }));
      const driver = narrated(picked.driver ?? browserSpeechDriver(), (text) => this.sentence(text));
      if (q) q.setDriver(driver);
      else q = this.queue = new SpeechQueue({ driver, onState: (s) => this.state(s) });
      this.engine = picked.engine;
    }
    if (this.turn !== t) return;
    q.setPrefs(loadVoicePrefs());
    q.primeTurn();
    if (this.engine === "studio") {
      this.surface = `away:${t.key}`;
      this.deps.surface(this.surface, true);
    }
  }

  private async wire(): Promise<void> {
    const on = <T extends TurnEvent>(name: string, kind: AwayEvent["kind"]) =>
      this.deps.listen<T>(name, (e) => this.event({ kind, e: e.payload } as AwayEvent));
    await Promise.all([
      on("voice-meter", "meter"),
      on("voice-delta", "delta"),
      on("voice-done", "done"),
      on("voice-interrupted", "interrupted"),
      on("voice-error", "error"),
      on("voice-exit", "error"),
    ]);
    this.deps.win.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.repeat) return;
      const c = voiceCaption.get();
      if (this.turn && c?.key === this.turn.key && c.phase !== "hearing") this.stop();
    });
  }

  private event(ev: AwayEvent): void {
    const t = this.turn;
    if (!t || ev.e.sessionId !== t.key) return;
    if (!t.id) {
      if (t.held.length < 1000) t.held.push(ev);
      return;
    }
    const { generation, turn } = ev.e;
    if (turn == null) {
      // The child itself: one older than this turn's is not news.
      if (ev.kind === "error" && generation >= t.id.generation) this.close(t);
      return;
    }
    if (!sameTurn(t.id, { generation, turn })) return;
    void this.ready.then(() => {
      if (this.turn === t) this.apply(t, ev);
    });
  }

  private apply(t: Following, ev: AwayEvent): void {
    switch (ev.kind) {
      case "meter":
        if (voiceCaption.get()?.phase === "thinking") voiceCaption.update(t.key, { activity: ev.e.activity ?? null });
        return;
      case "delta":
        t.raw += ev.e.text;
        return this.speak(t, false);
      case "done":
        t.raw = ev.e.body || t.raw;
        this.speak(t, true);
        t.ended = true;
        return this.finish(t);
      case "interrupted":
        this.queue?.flush();
        t.ended = true;
        return this.finish(t);
      case "error":
        this.queue?.cancel();
        return this.close(t);
    }
  }

  /** Speak what is new of the reply's spoken part: never the ⟦screen⟧ detail,
   *  never a marker. The held-back tail goes once the spoken part pauses. */
  private speak(t: Following, final: boolean): void {
    const q = this.queue;
    if (!q) return;
    const reply = splitReply(t.raw);
    q.setTone(reply.tone);
    const fresh = reply.spoken.slice(t.spokenLen);
    if (fresh) {
      q.enqueue(fresh);
      t.spokenLen = reply.spoken.length;
    }
    if (final || spokenPause(t.raw)) q.flush();
  }

  private sentence(text: string | null): void {
    const t = this.turn;
    if (!t) return;
    if (text) {
      t.said = text;
      voiceCaption.update(t.key, { phase: "speaking", text });
    } else this.finish(t);
  }

  private state(s: SpeechState): void {
    if (s === "idle" && this.turn) this.finish(this.turn);
  }

  /** Once the turn has ended and nothing is left to say: done, and then gone. */
  private finish(t: Following): void {
    if (!t.ended || this.queue?.getState() === "speaking") return;
    if (voiceCaption.get()?.phase !== "done") voiceCaption.update(t.key, { phase: "done", text: t.said });
    clearTimeout(this.linger);
    this.linger = setTimeout(() => {
      if (this.turn === t) this.close(t);
    }, LINGER_MS);
  }

  private close(t: Following): void {
    clearTimeout(this.linger);
    const c = voiceCaption.get();
    if (c?.key === t.key && c.phase !== "hearing") voiceCaption.set(null);
    if (this.turn === t) {
      this.leave();
      this.turn = null;
    }
  }

  /** Let the studio voice go, as closing a voice surface does. */
  private leave(): void {
    if (this.surface) this.deps.surface(this.surface, false);
    this.surface = null;
  }
}

let shared: AwayReply | null = null;

/** The app's one background reply. */
export function awayReply(): AwayReply {
  shared ??= new AwayReply({
    invoke,
    listen,
    driver: () => savedEngineDriver({}),
    warm: warmEngine,
    surface: (surface, open) => void import("./studioTts").then((m) => m.studioSurface(surface, open)),
    win: window,
  });
  return shared;
}
