// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The studio voice's driver against a scripted `tts_studio` (each speak's
// Channel is held, and the test sends its frames in the 12-byte-header format
// tts_studio.rs writes), stand-ins that record what they are asked to read,
// and an AudioContext whose clock is the fake timers' and which ends each
// source when its scheduled time is up (a suspended one's clock stands still).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpeechDriver } from "./speech";

type Args = Record<string, unknown>;
interface Speak {
  args: { text: string; generation: number; voice?: string; instruct?: string; interval?: number };
  channel: { onmessage: (data: ArrayBuffer) => void };
}
const { rust, handlers, standins } = vi.hoisted(() => ({
  rust: {
    calls: [] as Array<[string, Args]>,
    speaks: [] as Speak[],
    cancels: [] as number[],
    status: { installed: true, state: "ready", reason: null as string | null, pressure: 1 },
    refuse: null as string | null,
    kokoro: true,
  },
  handlers: new Map<string, Set<(e: { payload: unknown }) => void>>(),
  standins: [] as Array<{ who: string; voice?: string; text: string; done: () => void }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (data: ArrayBuffer) => void = () => {};
  },
  invoke: vi.fn(async (cmd: string, args: Args = {}) => {
    rust.calls.push([cmd, args]);
    if (cmd === "tts_cancel") {
      rust.cancels.push(args.generation as number);
      return null;
    }
    if (cmd === "tts_get_settings") return { kokoroVoice: "af_heart" };
    if (cmd !== "tts_studio") return null;
    if (args.op === "status") return { ...rust.status, kokoro: rust.kokoro };
    if (args.op === "speak") {
      if (rust.refuse) throw rust.refuse;
      rust.speaks.push({ args: args.args as Speak["args"], channel: args.onAudio as Speak["channel"] });
    }
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => {
    const set = handlers.get(name) ?? new Set();
    set.add(fn);
    handlers.set(name, set);
    return () => set.delete(fn);
  }),
}));
const standin = (who: string, voice?: string): SpeechDriver => ({
  speak: (text, _o, done) => standins.push({ who, voice, text, done }),
  cancel: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
});
vi.mock("./cloudTts", async (original) => ({
  ...(await original<typeof import("./cloudTts")>()),
  cloudTtsDriver: vi.fn((_onError: unknown, voice?: string) => standin("kokoro", voice)),
}));
vi.mock("./speech", async (original) => ({
  ...(await original<typeof import("./speech")>()),
  browserSpeechDriver: vi.fn(() => standin("system")),
}));

// --- a Web Audio context on the fake clock -------------------------------------
class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  when = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private ctx: FakeCtx) {}
  connect() {}
  start(when: number) {
    this.when = when;
    this.ctx.starts.push({ at: when, dur: this.buffer!.duration });
    this.ctx.live.add(this);
    if (this.ctx.state === "running") this.arm();
  }
  arm() {
    const ms = (this.when + this.buffer!.duration - this.ctx.currentTime) * 1000;
    this.timer = setTimeout(() => {
      this.ctx.live.delete(this);
      this.onended?.();
    }, Math.max(0, Math.round(ms)));
  }
  disarm() {
    clearTimeout(this.timer);
  }
  stop() {
    this.disarm();
    if (this.ctx.live.delete(this)) setTimeout(() => this.onended?.(), 0);
  }
}
class FakeCtx {
  static all: FakeCtx[] = [];
  state: AudioContextState = "running";
  destination = {};
  starts: { at: number; dur: number }[] = [];
  live = new Set<FakeSource>();
  sampleRate: number;
  private base = Date.now();
  private frozenAt: number | null = null;
  private pausedMs = 0;
  constructor(o?: { sampleRate?: number }) {
    this.sampleRate = o?.sampleRate ?? 48000;
    FakeCtx.all.push(this);
  }
  get currentTime() {
    return ((this.frozenAt ?? Date.now()) - this.base - this.pausedMs) / 1000;
  }
  createBuffer(_channels: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { duration: length / rate, length, getChannelData: () => data };
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  async suspend() {
    if (this.frozenAt !== null) return;
    this.frozenAt = Date.now();
    this.state = "suspended";
    for (const s of this.live) s.disarm();
  }
  async resume() {
    if (this.frozenAt === null) return;
    this.pausedMs += Date.now() - this.frozenAt;
    this.frozenAt = null;
    this.state = "running";
    for (const s of this.live) s.arm();
  }
  async close() {
    this.state = "closed";
  }
}
const ctx = () => FakeCtx.all[FakeCtx.all.length - 1];

// --- frames as tts_studio.rs writes them ---------------------------------------
function frame(generation: number, flags: number, body: Uint8Array, seq = 0): ArrayBuffer {
  const buf = new ArrayBuffer(12 + body.length);
  const head = new DataView(buf);
  head.setUint32(0, generation >>> 0, true);
  head.setUint32(4, seq, true);
  head.setUint16(8, flags, true);
  new Uint8Array(buf, 12).set(body);
  return buf;
}
/** `seconds` of audio for speak number `i`. */
const audio = (i: number, seconds = 0.1, generation = rust.speaks[i].args.generation) =>
  rust.speaks[i].channel.onmessage(
    frame(generation, 0, new Uint8Array(new Int16Array(Math.round(seconds * 24000)).fill(900).buffer)),
  );
/** Speak number `i`'s last frame, carrying its outcome. */
const end = (i: number, outcome: object = { type: "end", stats: { caps_hit: 0 } }, flags = 1) =>
  rust.speaks[i].channel.onmessage(
    frame(rust.speaks[i].args.generation, flags, new TextEncoder().encode(JSON.stringify(outcome))),
  );
const failWith = (i: number, code: string) => end(i, { type: "error", code }, 1 | 4);

const opts = { rate: 1, voiceURI: null };
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const emit = (name: string, payload: unknown) => {
  for (const fn of handlers.get(name) ?? []) fn({ payload });
};
const named = (cmd: string, op?: string) =>
  rust.calls.filter(([c, a]) => c === cmd && (op === undefined || a.op === op));
const LONG = (n: number) => `Sentence number ${n} is long enough to stand alone.`;

let studio: typeof import("./studioTts");
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", FakeCtx);
  vi.resetModules();
  Object.assign(rust, {
    calls: [],
    speaks: [],
    cancels: [],
    status: { installed: true, state: "ready", reason: null, pressure: 1 },
    refuse: null,
    kokoro: true,
  });
  handlers.clear();
  standins.length = 0;
  FakeCtx.all.length = 0;
  studio = await import("./studioTts");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A driver whose sidecar status has been read, with what it reports. */
async function driver(o: Parameters<typeof studio.studioTtsDriver>[0] = {}) {
  const notes: (string | null)[] = [];
  const d = studio.studioTtsDriver({ onFallback: (n) => notes.push(n), ...o });
  await advance(0);
  return { d, notes };
}

describe("studioTtsDriver: one timeline", () => {
  it("schedules a piece's frames back to back, cushioned only where the timeline ran dry", async () => {
    const { d } = await driver();
    d.speak(LONG(1), opts, () => {});
    expect(rust.speaks).toHaveLength(1);
    audio(0);
    audio(0);
    await advance(20);
    audio(0); // still ahead of the clock: no gap
    const [a, b, c] = ctx().starts;
    expect(a.at).toBeCloseTo(0.1); // dry at the start: the 100 ms cushion
    expect(b.at).toBeCloseTo(a.at + a.dur);
    expect(c.at).toBeCloseTo(b.at + b.dur);
    end(0);
    await advance(1000); // everything played: the timeline is dry again
    d.speak(LONG(2), opts, () => {});
    audio(1);
    const last = ctx().starts[3];
    expect(last.at).toBeCloseTo(ctx().currentTime + studio.JITTER_S, 2);
  });

  it("finishes a piece when its last frame has come and its last audio has played", async () => {
    const { d } = await driver();
    const done: string[] = [];
    d.speak(LONG(1), opts, () => done.push("one"));
    audio(0, 0.3);
    end(0);
    await advance(300);
    expect(done).toEqual([]); // the cushion plus 0.3 s of audio
    await advance(150);
    expect(done).toEqual(["one"]);
  });

  it("finishes a piece with nothing speakable in it at once", async () => {
    const { d, notes } = await driver();
    const done: string[] = [];
    d.speak("```code only```, really nothing", opts, () => done.push("code"));
    failWith(0, "empty_text");
    await advance(0);
    expect(done).toEqual(["code"]);
    expect(standins).toEqual([]);
    expect(notes).toEqual([null]);
  });

  it("drops frames of another generation, and anything that arrives after Stop", async () => {
    const { d } = await driver();
    const done: string[] = [];
    d.speak(LONG(1), opts, () => done.push("one"));
    const generation = rust.speaks[0].args.generation;
    audio(0, 0.1, generation + 1); // not this piece's generation
    expect(ctx()?.starts ?? []).toEqual([]);
    audio(0);
    d.cancel();
    expect(rust.cancels).toEqual([generation]);
    audio(0);
    end(0);
    await advance(1000);
    expect(FakeCtx.all.map((c) => c.starts.length)).toEqual([1]);
    expect(done).toEqual([]); // a cancelled sentence never reports in
    // The next reply gets a new generation (and a fresh context).
    d.speak(LONG(2), opts, () => {});
    expect(rust.speaks[1].args.generation).not.toBe(generation);
  });
});

describe("studioTtsDriver: flow control", () => {
  it("keeps at most READ_AHEAD pieces at the sidecar beyond the one playing", async () => {
    const { d } = await driver();
    for (let n = 1; n <= 6; n++) d.speak(LONG(n), opts, () => {});
    expect(rust.speaks.map((s) => s.args.text)).toEqual([LONG(1), LONG(2), LONG(3)]);
    audio(0, 0.2);
    end(0);
    await advance(100);
    expect(rust.speaks).toHaveLength(3); // the first is still playing
    await advance(250);
    expect(rust.speaks.map((s) => s.args.text)).toEqual([LONG(1), LONG(2), LONG(3), LONG(4)]);
  });

  it("streams the reply's first piece in the smaller chunks, and only that one", async () => {
    const { d } = await driver();
    d.speak(LONG(1), opts, () => {});
    d.speak(LONG(2), opts, () => {});
    expect(rust.speaks.map((s) => s.args.interval)).toEqual([0.16, undefined]);
    d.beginTurn!();
    d.speak(LONG(3), opts, () => {});
    expect(rust.speaks[2].args.interval).toBe(0.16);
  });
});

describe("studioTtsDriver: short pieces", () => {
  it("joins a short piece to the next sentence, and finishes each sentence in turn", async () => {
    const { d } = await driver();
    const done: string[] = [];
    d.speak("Sure.", opts, () => done.push("sure"));
    await advance(100);
    expect(rust.speaks).toEqual([]);
    d.speak("The risk is a double apply.", opts, () => done.push("risk"));
    expect(rust.speaks.map((s) => s.args.text)).toEqual(["Sure. The risk is a double apply."]);
    audio(0, 0.3);
    expect(done).toEqual(["sure"]); // it is sounding
    end(0);
    await advance(450);
    expect(done).toEqual(["sure", "risk"]);
  });

  it("sends a short piece alone after 250 ms, and at once when the reply's text is all in", async () => {
    const { d } = await driver();
    d.speak("Okay.", opts, () => {});
    await advance(249);
    expect(rust.speaks).toEqual([]);
    await advance(1);
    expect(rust.speaks.map((s) => s.args.text)).toEqual(["Okay."]);
    d.speak("Got it.", opts, () => {});
    d.flush!();
    expect(rust.speaks.map((s) => s.args.text)).toEqual(["Okay.", "Got it."]);
  });
});

describe("studioTtsDriver: tone", () => {
  it("speaks a reply's tone as its tested instruction, and the saved style when it has none", async () => {
    const { d } = await driver({ style: "brisk" });
    d.speak(LONG(1), { ...opts, tone: "calm, warm" }, () => {});
    d.speak(LONG(2), { ...opts, tone: "serious" }, () => {}); // untested: the style
    d.speak(LONG(3), opts, () => {});
    expect(rust.speaks.map((s) => s.args.instruct)).toEqual([
      studio.STUDIO_TONES.calm.instruct,
      studio.STUDIO_TONES.brisk.instruct,
      studio.STUDIO_TONES.brisk.instruct,
    ]);
  });

  it("teaches the agent exactly the tested tone words", () => {
    // The ear rules in voice.rs list the tones; a word missing here would
    // read plainly, one missing there would never be asked for.
    const rules = readFileSync("src-tauri/src/voice.rs", "utf8");
    const line = /⟦tone: calm⟧ \(([^)]*)\)/.exec(rules)?.[1] ?? "";
    expect(line.split(/,? or |, /).sort()).toEqual(Object.keys(studio.STUDIO_TONES).sort());
  });
});

describe("studioTtsDriver: what was heard", () => {
  it("places the cut in the piece by the timeline", async () => {
    const { d } = await driver();
    d.speak("one two three four five six seven eight", opts, () => {});
    expect(d.heard!()).toBe("");
    audio(0, 0.5);
    audio(0, 0.5);
    end(0);
    await advance(100 + 500); // the cushion, then half of its second of audio
    expect(d.heard!()).toBe("one two three four");
    await advance(450);
    expect(d.heard!()).toBe("one two three four five six seven");
  });

  it("holds audio that arrives under ⏸ before any has played", async () => {
    const { d } = await driver();
    d.speak(LONG(1), opts, () => {});
    d.pause();
    audio(0, 0.2);
    end(0);
    expect(ctx().state).toBe("suspended");
    await advance(5000);
    expect(ctx().live.size).toBe(1);
  });

  it("holds the clock, and the stuck-audio watchdog, while paused", async () => {
    const { d } = await driver();
    const done: string[] = [];
    d.speak(LONG(1), opts, () => done.push("one"));
    audio(0, 0.5);
    end(0);
    await advance(200);
    d.pause();
    await advance(10_000);
    expect(done).toEqual([]);
    d.resume();
    await advance(500);
    expect(done).toEqual(["one"]);
  });
});

describe("studioTtsDriver: the stand-in", () => {
  it("reads the whole reply when the model isn't warm at its first piece, then the next reply is studio again", async () => {
    rust.status.state = "loading";
    const { d, notes } = await driver();
    d.beginTurn!();
    d.speak("Sure.", opts, () => {});
    d.speak(LONG(1), opts, () => {});
    expect(rust.speaks).toEqual([]);
    expect(standins.map((s) => [s.who, s.voice, s.text])).toEqual([
      ["kokoro", "af_heart", "Sure."], // nothing joined for the stand-in
      ["kokoro", "af_heart", LONG(1)],
    ]);
    expect(notes).toEqual(["Studio voice warming · Kokoro reading"]);
    expect(named("tts_studio", "warm").length).toBeGreaterThan(0);
    emit("studio-status", { state: "ready", reason: null });
    for (const s of standins.splice(0)) s.done();
    d.beginTurn!();
    d.speak(LONG(2), opts, () => {});
    expect(rust.speaks.map((s) => s.args.text)).toEqual([LONG(2)]);
    expect(notes).toEqual(["Studio voice warming · Kokoro reading", null]);
  });

  it("finishes a reply that stalls, after the audio before it, and the sidecar drops the rest", async () => {
    const { d, notes } = await driver();
    const done: string[] = [];
    for (let n = 1; n <= 4; n++) d.speak(LONG(n), opts, () => done.push(`s${n}`));
    const generation = rust.speaks[0].args.generation;
    audio(0, 0.2);
    end(0);
    failWith(1, "stalled");
    expect(rust.cancels).toEqual([generation]);
    expect(notes).toEqual([null, "Studio voice stalled · Kokoro finishing"]);
    expect(standins).toEqual([]); // the first sentence is still sounding
    await advance(350);
    expect(standins.map((s) => s.text)).toEqual([LONG(2), LONG(3), LONG(4)]);
    for (const s of standins.splice(0)) s.done();
    await advance(0);
    expect(done).toEqual(["s1", "s2", "s3", "s4"]);
    expect(rust.speaks).toHaveLength(3); // nothing more went to the sidecar
  });

  it("finishes a reply with the stand-in when the sidecar never answers at all", async () => {
    const { d, notes } = await driver();
    d.speak(LONG(1), opts, () => {});
    await advance(studio.SYNTH_LIMIT_MS - 1);
    expect(standins).toEqual([]);
    await advance(1);
    expect(standins.map((s) => s.text)).toEqual([LONG(1)]);
    expect(notes[1]).toBe("Studio voice stalled · Kokoro finishing");
  });

  it("speaks again once installed, without a restart", async () => {
    rust.status = { ...rust.status, installed: false, state: "off" };
    const { d, notes } = await driver();
    d.speak(LONG(1), opts, () => {});
    expect(notes).toEqual(["Studio voice not installed · Kokoro reading"]);
    // The settings card's install ends warm.
    emit("studio-status", { state: "loading", reason: null });
    emit("studio-status", { state: "ready", reason: null });
    d.beginTurn!();
    d.speak(LONG(2), opts, () => {});
    expect(rust.speaks.map((s) => s.args.text)).toEqual([LONG(2)]);
  });

  it("takes over the rest after a second length-cap hit in one reply", async () => {
    const { d, notes } = await driver();
    for (let n = 1; n <= 4; n++) d.speak(LONG(n), opts, () => {});
    end(0, { type: "end", stats: { caps_hit: 1 } });
    expect(notes).toEqual([null]);
    end(1, { type: "end", stats: { caps_hit: 1 } });
    expect(notes).toEqual([null, "Studio voice ran on · Kokoro finishing"]);
    await advance(0);
    expect(standins.map((s) => s.text)).toEqual([LONG(3), LONG(4)]);
  });

  it("asks whether Kokoro is set up once per window, not once per chat, and starts nothing to ask", async () => {
    await driver();
    await driver();
    studio.playStudioSample("ryan", "Studio voice ready.", () => {});
    await advance(0);
    // Kokoro's own status starts a login shell and probes Pythons; the
    // studio voice's status says the same from what is on disk.
    expect(named("tts_kokoro_status")).toEqual([]);
    expect(named("tts_studio", "status")).toHaveLength(1);
    expect(named("tts_get_settings")).toHaveLength(1);
  });

  it("is the system voice where Kokoro isn't set up, and takes a refused piece", async () => {
    rust.kokoro = false;
    rust.refuse = "studio_disabled";
    const { d, notes } = await driver();
    d.speak(LONG(1), opts, () => {});
    await advance(0);
    expect(standins.map((s) => [s.who, s.text])).toEqual([["system", LONG(1)]]);
    expect(notes).toEqual([null, "Studio voice crashed twice · System voice reading"]);
    // Disabled until a restart: the next reply goes straight to the stand-in.
    rust.refuse = null;
    d.beginTurn!();
    d.speak(LONG(2), opts, () => {});
    expect(rust.speaks).toEqual([]);
    expect(standins.map((s) => s.text)).toEqual([LONG(1), LONG(2)]);
  });

  it("stays with the stand-in after a memory-pressure unload until a minute of normal pressure", async () => {
    const { d, notes } = await driver();
    emit("studio-status", { state: "unloaded", reason: "memory_pressure" });
    rust.status.pressure = 2;
    d.beginTurn!();
    d.speak(LONG(1), opts, () => {});
    expect(notes).toEqual(["Memory tight · Kokoro reading"]);
    await advance(30_000); // still warn
    rust.status = { ...rust.status, pressure: 1, state: "ready" };
    emit("studio-status", { state: "ready", reason: null });
    await advance(50_000); // normal, but not for a minute yet
    d.beginTurn!();
    d.speak(LONG(2), opts, () => {});
    expect(rust.speaks).toEqual([]);
    await advance(20_000);
    d.beginTurn!();
    d.speak(LONG(3), opts, () => {});
    expect(rust.speaks.map((s) => s.args.text)).toEqual([LONG(3)]);
    expect(notes[notes.length - 1]).toBeNull();
  });
});

describe("playStudioSample", () => {
  it("waits for the model before speaking in the voice auditioned", async () => {
    rust.status.state = "off";
    const ended: (string | undefined)[] = [];
    studio.playStudioSample("aiden", "Studio voice ready.", (e) => ended.push(e));
    await advance(0);
    expect(named("tts_studio", "warm").map(([, a]) => a.args)).toEqual([{ always: true }]);
    expect(rust.speaks).toEqual([]);
    emit("studio-status", { state: "loading", reason: null });
    expect(rust.speaks).toEqual([]);
    emit("studio-status", { state: "ready", reason: null });
    expect(rust.speaks.map((s) => [s.args.voice, s.args.text])).toEqual([["aiden", "Studio voice ready."]]);
    audio(0, 0.2);
    end(0);
    await advance(400);
    expect(ended).toEqual([undefined]);
  });

  it("reports a sample the sidecar couldn't speak", async () => {
    const ended: (string | undefined)[] = [];
    studio.playStudioSample("ryan", "Studio voice ready.", (e) => ended.push(e));
    await advance(0);
    failWith(0, "stalled");
    await advance(0);
    expect(ended).toEqual(["stalled"]);
    expect(standins).toEqual([]);
  });
});
