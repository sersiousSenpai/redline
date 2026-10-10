// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// End of turn on level traces of real speech: the shared dictation test set's
// 50 repo-heavy phrases (system voices and two studio presets), metered as
// dictation.rs meters a capture, with the live recognizer's own word timings,
// each phrase cut once mid-clause, and the end-of-turn model's recorded
// answers for both the whole phrase and the cut (fixtures/endpoint-levels.json).
// Each phrase is spoken through the scenarios hands-free must survive — a
// finished sentence, a pause mid-thought of 0.4–2 s, a trailing "and", comma
// or "um", a cough, "hold on", "send now" — into a model of the live
// recognizer (a word not yet written when a turn is cut is lost with it) and
// of a reply that starts to sound 1.6 s after a turn ends. A cut-off is a
// phrase that does not arrive whole, as one turn. The bar: at most 5% of them.
//
// The recognizer's timing is measured: the same clips fed in real time to
// SFSpeechRecognizer set up as dictation.rs sets it up. Its first words came
// 0.84 s into the audio (p50; 0.52 s after the first word ended, p90 0.65 s);
// a word followed by a pause was written 0.27 s after the voice stopped (p50;
// p90 0.43 s, at most 0.48 s); words mid-speech lag more (p50 0.39 s, p90
// 0.74 s), as the recognizer writes them in bursts.
import { describe, expect, it } from "vitest";

import fixture from "./fixtures/endpoint-levels.json";
import { Endpointer, type ListenThrough } from "./endpoint";
import { LEVEL_MS, looksUnfinished, type Level } from "./vad";

interface Clip {
  id: string;
  text: string;
  words: [string, number][];
  rms: string;
  peak: string;
  cut: { word: number; ms: number };
  scores: { finished: Record<string, number>; cut: Record<string, number> };
}

const decode = (b64: string) => Array.from(new Int8Array(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer));
const levels = (rms: string, peak: string): Level[] => {
  const p = decode(peak);
  return decode(rms).map((r, i) => ({ rms: r, peak: p[i] }));
};
const CLIPS = (fixture.clips as unknown as Clip[]).map((c) => ({ ...c, levels: levels(c.rms, c.peak) }));
const ROOM = levels(fixture.room.rms, fixture.room.peak);

/** When the reply starts to sound after a turn ends, and for how long. */
const REPLY_AFTER_MS = 1600;
const REPLY_MS = 2500;
/** How long after it is said the live recognizer writes a word: the first of
 *  a capture, one followed by a pause, one mid-speech (measured; see above). */
const FIRST_LAGS = [420, 480, 520, 520, 560, 650];
const PAUSE_LAGS = [150, 220, 270, 270, 300, 350, 400, 430, 480];
const SPEECH_LAGS = [150, 250, 390, 390, 450, 550, 740, 900];

/** A small deterministic hash, for lags and room jitter that don't change
 *  from run to run. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface Word {
  text: string;
  /** When it ends on the timeline, ms. */
  end: number;
  /** Part of the phrase (not a filler or a command). */
  phrase: boolean;
}

/** One scenario's timeline: windows, the words in them, and which scores a
 *  scorer would give during each stretch. */
class Trace {
  frames: Level[] = [];
  words: Word[] = [];
  /** Where each spoken stretch ends, and which recorded scores apply after it. */
  stretches: { end: number; scores: Record<string, number> }[] = [];
  /** A pause no turn may end in: after "hold on", or words that trail off. */
  waits: [number, number] | null = null;
  constructor(readonly key: string) {}

  /** Whether a word ending at `ms` is followed by a pause of at least
   *  300 ms (allowing for its timing being a window or two early): the
   *  recognizer catches up with every word before it. */
  pausesAfter(ms: number): boolean {
    const from = Math.ceil((ms + 100) / LEVEL_MS);
    const after = this.frames.slice(from, from + 300 / LEVEL_MS);
    return after.length > 0 && after.every((f) => f.rms < -45);
  }

  /** A pause that must be waited out. */
  waitOut(ms: number) {
    this.waits = [this.ms, this.ms + ms];
    return this.room(ms);
  }

  get ms() {
    return this.frames.length * LEVEL_MS;
  }

  room(ms: number) {
    for (let i = 0; i < ms / LEVEL_MS; i++) {
      const r = ROOM[this.frames.length % ROOM.length];
      const jitter = (hash(`${this.key}${this.frames.length}`) % 5) - 2;
      this.frames.push({ rms: r.rms + jitter, peak: r.peak + jitter });
    }
    return this;
  }

  /** A stretch of `clip` from `from` to `to` ms — the whole phrase, or the
   *  part before its cut, or the rest — with its words. */
  speech(clip: (typeof CLIPS)[number], from: number, to: number, scores: Record<string, number>, mark?: string) {
    const a = Math.round(from / LEVEL_MS);
    const b = Math.min(clip.levels.length, Math.round(to / LEVEL_MS));
    const start = this.ms;
    const last = clip.words.length - 1;
    const [lo, hi] = from > 0 ? [clip.cut.word + 1, last] : b < clip.levels.length ? [0, clip.cut.word] : [0, last];
    for (let i = lo; i <= hi; i++) {
      const [text, end] = clip.words[i];
      const at = Math.min(Math.max(start + end - a * LEVEL_MS, start + LEVEL_MS), start + (b - a) * LEVEL_MS);
      this.words.push({ text: mark && i === clip.cut.word ? `${text}${mark}` : text, end: at, phrase: true });
    }
    this.frames.push(...clip.levels.slice(a, b));
    this.stretches.push({ end: this.ms, scores });
    return this;
  }

  /** A voiced burst: a filler or a command (`word`), or a cough (none). */
  burst(ms: number, rms: number, word?: string) {
    for (let i = 0; i < ms / LEVEL_MS; i++) this.frames.push({ rms, peak: rms + 12 });
    if (word) this.words.push({ text: word, end: this.ms, phrase: false });
    return this;
  }
}

interface Outcome {
  turns: string[][];
  /** Turns that ended in a pause that had to be waited out. */
  endsInWait: number;
  /** End times, ms after the last phrase word's audio ended, and after the
   *  last word of any kind (a command) ended. */
  endDelays: number[];
  sinceLastWord: number[];
  premature: number;
  resumes: number;
}

/** Play `trace` into an endpointer the way the voice panel wires it. */
function play(trace: Trace, through: ListenThrough, withScorer: boolean): Outcome {
  let now = 0;
  let mic = true;
  let taskStart = 0;
  let written = 0;
  let lastPartial = "";
  let replyAt = Infinity;
  let replyEnd = Infinity;
  const lost = new Set<number>();
  const turns: string[][] = [];
  const out: Outcome = { turns, endsInWait: 0, endDelays: [], sinceLastWord: [], premature: 0, resumes: 0 };
  const lastPhraseEnd = Math.max(...trace.words.filter((w) => w.phrase).map((w) => w.end));
  const lastWordEnd = Math.max(...trace.words.map((w) => w.end));

  const settles = trace.words.map((w) => trace.pausesAfter(w.end));
  const ownLag = (i: number) => {
    const w = trace.words[i];
    const lags = i === trace.words.findIndex((x) => x.end > taskStart) ? FIRST_LAGS : settles[i] ? PAUSE_LAGS : SPEECH_LAGS;
    return w.end + lags[hash(`${trace.key}:${i}`) % lags.length];
  };
  // A pause lets the recognizer catch up: every word before it is written
  // by the time the last word before the pause is.
  const writtenAt = (i: number) => {
    const settler = settles.findIndex((x, j) => j >= i && x);
    return settler < 0 ? ownLag(i) : Math.min(ownLag(i), ownLag(settler));
  };
  const taskWords = () => {
    const ws: string[] = [];
    for (let i = 0; i < trace.words.length; i++) {
      const w = trace.words[i];
      if (w.end <= taskStart || lost.has(i)) continue;
      if (writtenAt(i) > now) break;
      ws.push(w.text);
    }
    return ws;
  };
  const cycle = () => {
    // A new recognition task: whatever was said and not yet written is gone.
    trace.words.forEach((w, i) => {
      if (w.end > taskStart && w.end <= now && writtenAt(i) > now) lost.add(i);
    });
    taskStart = now;
    written = 0;
    lastPartial = "";
  };
  const closeMic = () => {
    mic = false;
    cycle();
  };

  const ep = new Endpointer({
    end(text, _reason, resumed) {
      const said = text.split(/\s+/).filter(Boolean);
      if (resumed && turns.length) turns[turns.length - 1].push(...said);
      else turns.push(said);
      if (trace.waits && now > trace.waits[0] && now <= trace.waits[1]) out.endsInWait += 1;
      if (now < lastPhraseEnd) out.premature += 1;
      else out.endDelays.push(now - lastPhraseEnd);
      if (now >= lastWordEnd) out.sinceLastWord.push(now - lastWordEnd);
      cycle();
      replyAt = now + REPLY_AFTER_MS;
      replyEnd = replyAt + REPLY_MS;
      if (!ep.listening) closeMic();
    },
    resume() {
      out.resumes += 1;
      replyAt = replyEnd = Infinity;
    },
    barge() {
      replyAt = replyEnd = Infinity;
      ep.agentAudible(false);
    },
    drop() {
      cycle();
    },
  });
  ep.setListenThrough(through);
  if (withScorer) {
    // The model's recorded answers, for the pauses it was asked about: the
    // one after the cut, and the one after the whole phrase. Any other pause
    // (a gap between two words, a cough) it has no answer for.
    ep.setScorer(() => {
      const stretch = [...trace.stretches].reverse().find((s) => s.end <= now);
      if (!stretch) return null;
      const since = trace.frames.slice(stretch.end / LEVEL_MS, now / LEVEL_MS);
      if (since.some((f) => f.rms > -45)) return null;
      const silence = now - stretch.end;
      const keys = Object.keys(stretch.scores).map(Number).sort((a, b) => a - b);
      const at = keys.filter((k) => k <= silence).pop() ?? keys[0];
      return stretch.scores[String(at)];
    });
  }

  for (const frame of trace.frames) {
    now += LEVEL_MS;
    if (now >= replyAt && replyAt !== -1) {
      replyAt = -1;
      ep.agentAudible(true);
      if (!ep.listening) closeMic();
    }
    if (now >= replyEnd) {
      replyEnd = Infinity;
      ep.agentAudible(false);
      ep.replyOver();
      if (!mic) {
        mic = true;
        ep.reset();
        cycle();
      }
    }
    if (!mic) {
      // Said while the mic was closed: never heard.
      trace.words.forEach((w, i) => {
        if (w.end > now - LEVEL_MS && w.end <= now) lost.add(i);
      });
      continue;
    }
    ep.level(frame);
    const ws = taskWords();
    if (ws.length !== written || ws.join(" ") !== lastPartial) {
      written = ws.length;
      lastPartial = ws.join(" ");
      ep.partial(lastPartial);
    }
  }
  return out;
}

/** Whether every word of the phrase arrived, in order, in one turn. */
function whole(trace: Trace, out: Outcome): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  const tokens = (ts: string[]) => ts.flatMap((t) => t.split(/\s+/)).map(norm).filter(Boolean);
  const want = tokens(trace.words.filter((w) => w.phrase).map((w) => w.text));
  return out.turns.some((turn) => {
    let i = 0;
    for (const w of tokens(turn)) if (i < want.length && w === want[i]) i += 1;
    return i === want.length;
  });
}

type Kind =
  | "finished"
  | "pause 0.4 s"
  | "pause 0.9 s"
  | "pause 1.4 s"
  | "pause 2 s"
  | "trailing and/the"
  | "trailing comma"
  | "um"
  | "cough before"
  | "cough in a pause"
  | "hold on"
  | "send now";

function scenarios(clip: (typeof CLIPS)[number]): [Kind, Trace][] {
  const full = clip.levels.length * LEVEL_MS;
  const { finished, cut } = clip.scores;
  const t = (kind: string) => new Trace(`${clip.id}/${kind}`);
  const split = (kind: string, pauseMs: number) =>
    t(kind).room(800).speech(clip, 0, clip.cut.ms, cut).room(pauseMs).speech(clip, clip.cut.ms, full, finished).room(3500);
  const list: [Kind, Trace][] = [
    ["finished", t("finished").room(800).speech(clip, 0, full, finished).room(3500)],
    ["pause 0.4 s", split("p400", 400)],
    ["pause 0.9 s", split("p900", 900)],
    ["pause 1.4 s", split("p1400", 1400)],
    ["pause 2 s", split("p2000", 2000)],
    [
      "trailing comma",
      t("comma").room(800).speech(clip, 0, clip.cut.ms, cut, ",").waitOut(1400).speech(clip, clip.cut.ms, full, finished).room(3500),
    ],
    [
      "um",
      t("um").room(800).speech(clip, 0, clip.cut.ms, cut).burst(350, -30, "um").waitOut(1200).speech(clip, clip.cut.ms, full, finished).room(3500),
    ],
    ["cough before", t("cough").room(600).burst(300, -18).room(700).speech(clip, 0, full, finished).room(3500)],
    [
      "cough in a pause",
      t("cough2").room(800).speech(clip, 0, clip.cut.ms, cut, ",").room(500).burst(250, -18).room(900).speech(clip, clip.cut.ms, full, finished).room(3500),
    ],
    [
      "hold on",
      t("hold").room(800).speech(clip, 0, clip.cut.ms, cut).burst(500, -27, "hold on").waitOut(4000).speech(clip, clip.cut.ms, full, finished).room(6500),
    ],
    ["send now", t("send").room(800).speech(clip, 0, full, finished).burst(600, -27, "send now").room(2500)],
  ];
  // A cut right after a word that leaves the sentence hanging, if it has one.
  const dangling = clip.words.findIndex((_, i) => i >= 1 && i < clip.words.length - 1 && looksUnfinished(clip.words.slice(0, i + 1).map((w) => w[0]).join(" ")));
  if (dangling >= 0 && dangling !== clip.cut.word) {
    const at = Math.round((clip.words[dangling][1] + 40) / LEVEL_MS) * LEVEL_MS;
    const moved = { ...clip, cut: { word: dangling, ms: at } };
    list.push(["trailing and/the", t("dangling").room(800).speech(moved, 0, at, cut).waitOut(1800).speech(moved, at, full, finished).room(3500)]);
  }
  return list;
}

function runAll(through: ListenThrough, withScorer: boolean) {
  const byKind = new Map<
    Kind,
    { n: number; cut: number; premature: number; waited: number; delays: number[]; sinceCommand: number[] }
  >();
  for (const clip of CLIPS) {
    for (const [kind, trace] of scenarios(clip)) {
      const out = play(trace, through, withScorer);
      const k = byKind.get(kind) ?? { n: 0, cut: 0, premature: 0, waited: 0, delays: [], sinceCommand: [] };
      k.n += 1;
      if (!whole(trace, out)) k.cut += 1;
      k.premature += out.premature;
      k.waited += out.endsInWait;
      k.delays.push(...out.endDelays);
      k.sinceCommand.push(...out.sinceLastWord);
      byKind.set(kind, k);
    }
  }
  return byKind;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe.each([
  ["the silence rule", false],
  ["the end-of-turn model's recorded answers", true],
])("level traces of real speech, with %s", (_name, withScorer) => {
  const results = runAll("thinking", withScorer);
  const total = [...results.values()].reduce((a, k) => a + k.n, 0);
  const cut = [...results.values()].reduce((a, k) => a + k.cut, 0);
  if (process.env.EOT_REPORT) {
    console.log(`\n${_name}: ${cut}/${total} cut off (${((100 * cut) / total).toFixed(1)}%)`);
    for (const [kind, k] of results) {
      console.log(`  ${kind.padEnd(18)} ${String(k.cut).padStart(2)}/${k.n} cut, ${k.premature} premature ends, median end ${median(k.delays) ?? "-"} ms after the last word`);
    }
  }

  it("cuts off at most 5% of phrases", () => {
    expect(cut / total).toBeLessThanOrEqual(0.05);
  });

  it("delivers every finished sentence whole, and soon", () => {
    const k = results.get("finished")!;
    expect(k.cut).toBe(0);
    expect(median(k.delays)).toBeLessThanOrEqual(withScorer ? 700 : 800);
  });

  it("never ends in the pause after a trailing conjunction, article, comma or filler", () => {
    for (const kind of ["trailing and/the", "trailing comma", "um"] as const) {
      expect(results.get(kind)!.waited, kind).toBe(0);
      expect(results.get(kind)!.cut, kind).toBe(0);
    }
  });

  it("brings a phrase cut by a pause back whole", () => {
    for (const kind of ["pause 0.4 s", "pause 0.9 s", "pause 1.4 s", "pause 2 s"] as const) {
      expect(results.get(kind)!.cut, kind).toBeLessThanOrEqual(Math.ceil(0.05 * CLIPS.length));
    }
  });

  it("is not fooled by a cough, and waits out 'hold on'", () => {
    expect(results.get("cough before")!.cut).toBe(0);
    expect(results.get("cough in a pause")!.cut).toBe(0);
    expect(results.get("hold on")!.cut).toBe(0);
    expect(results.get("hold on")!.waited).toBe(0);
  });

  it('ends at once on "send now"', () => {
    const k = results.get("send now")!;
    expect(k.cut).toBe(0);
    // 250 ms of silence after the command, or as long as the recognizer
    // takes to write it.
    expect(Math.max(...k.sinceCommand)).toBeLessThanOrEqual(Math.max(250, ...PAUSE_LAGS) + LEVEL_MS);
  });
});

describe("talking over the reply, on real speech", () => {
  /** A turn, then the reply sounding, then `user` said over it. */
  function overReply(through: ListenThrough, user: (trace: Trace) => void) {
    const clip = CLIPS[0];
    const trace = new Trace(`over/${through}`)
      .room(600)
      .speech(clip, 0, clip.levels.length * LEVEL_MS, clip.scores.finished)
      .room(REPLY_AFTER_MS + 1500);
    user(trace);
    trace.room(3000);
    const log: string[] = [];
    let now = 0;
    let replyAt = Infinity;
    let mic = true;
    // The recognizer: each word written 300 ms after it is said, from the
    // start of its task — the capture, or the cycle after a turn.
    let taskStart = 0;
    let words: string[] = [];
    const ep = new Endpointer({
      end: (text) => {
        log.push(`end:${text}`);
        taskStart = now;
        words = [];
        if (replyAt === Infinity) replyAt = now + REPLY_AFTER_MS;
      },
      resume: () => log.push("resume"),
      barge: () => log.push("barge"),
      drop: () => log.push("drop"),
    });
    ep.setListenThrough(through);
    for (const frame of trace.frames) {
      now += LEVEL_MS;
      if (now >= replyAt && replyAt > 0) {
        replyAt = -1;
        ep.agentAudible(true);
        mic = ep.listening;
      }
      if (!mic) continue;
      ep.level(frame);
      const next = trace.words.filter((w) => w.end > taskStart && w.end + 300 <= now).map((w) => w.text);
      if (next.length !== words.length) {
        words = next;
        ep.partial(words.join(" "));
      }
    }
    return log.slice(1);
  }

  const other = CLIPS[7];
  const sentence = (t: Trace) => t.speech(other, 0, other.levels.length * LEVEL_MS, other.scores.finished);
  const yeah = (t: Trace) => t.burst(300, -26, "yeah");

  it("on wired headphones, a sentence interrupts the reply and a 'yeah' does not", () => {
    expect(overReply("reply", sentence)[0]).toBe("barge");
    expect(overReply("reply", yeah)).toEqual(["drop"]);
  });

  it("on speakers, nothing said over the reply is heard: the mic is closed", () => {
    expect(overReply("thinking", sentence)).toEqual([]);
    expect(overReply("thinking", yeah)).toEqual([]);
  });
});
