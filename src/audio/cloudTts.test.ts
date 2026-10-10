// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The Rust-synth speech driver against a fake Rust side and a fake Web Audio
// context. The Rust side is modelled as Kokoro behaves: one request at a time,
// first come first served (the tokio Mutex is fair), with `tts_cancel`
// dropping a queued request when its turn comes. The context models WebKit: a
// suspended context's clock stands still, so a started source never ends, and
// a source stopped while suspended reports 'ended' only on resume.
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLIP_GRACE_MS, cloudTtsDriver, playVoiceSample, READ_AHEAD } from "./cloudTts";
import { SpeechQueue, type SpeechState } from "./speech";

// --- the Rust side -----------------------------------------------------------
interface SynthArgs {
  text: string;
  generation: number;
  speed: number;
  voice?: string;
}
type Pending = SynthArgs & { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const rust = {
  calls: [] as SynthArgs[],
  cancels: [] as number[],
  queue: [] as Pending[],
  busy: false,
  synthMs: 40,
  /** Kokoro renders the requested speed; the cloud engines answer at 1. */
  rendersSpeed: true,
  fail: null as string | null,
};

function pump() {
  if (rust.busy) return;
  const r = rust.queue.shift();
  if (!r) return;
  // Re-checked when the request's turn comes, as `synth_kokoro` does.
  if (rust.cancels.includes(r.generation)) {
    r.reject("cancelled");
    pump();
    return;
  }
  rust.busy = true;
  setTimeout(() => {
    rust.busy = false;
    if (rust.fail) r.reject(rust.fail);
    else
      r.resolve({
        audioBase64: btoa(r.text),
        mime: "audio/wav",
        speed: rust.rendersSpeed ? r.speed : 1,
      });
    pump();
  }, rust.synthMs);
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: SynthArgs) => {
    if (cmd === "tts_cancel") {
      rust.cancels.push(args.generation);
      return;
    }
    if (cmd !== "tts_synth") throw new Error(`unexpected ${cmd}`);
    rust.calls.push({ ...args });
    if (rust.cancels.includes(args.generation)) throw "cancelled";
    return new Promise((resolve, reject) => {
      rust.queue.push({ ...args, resolve, reject });
      pump();
    });
  }),
}));

// --- a WebKit-like AudioContext ----------------------------------------------
const log: { what: "start" | "end"; tag: string; at: number }[] = [];
const started = () => log.filter((e) => e.what === "start").map((e) => e.tag);
const finished = () => log.filter((e) => e.what === "end").map((e) => e.tag);
let startThrows = 0;
let neverEnds = false;
/** Every clip the context has decoded, held weakly: which ones is the driver
 *  still keeping alive? (`WeakRef` is ES2021; the app's lib stops at ES2020.) */
const { WeakRef: Weak } = globalThis as unknown as {
  WeakRef: new (target: object) => { deref(): object | undefined };
};
const decoded: InstanceType<typeof Weak>[] = [];

class FakeSource {
  buffer: { tag: string } | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private left = 0;
  private armedAt = 0;
  private silent = false;
  constructor(private ctx: FakeCtx) {}
  connect() {}
  start(_when: number, _offset: number, duration: number) {
    if (startThrows > 0) {
      startThrows -= 1;
      throw new RangeError("start failed");
    }
    this.silent = neverEnds;
    log.push({ what: "start", tag: this.buffer!.tag, at: Date.now() });
    this.left = (duration / this.playbackRate.value) * 1000;
    this.ctx.live.add(this);
    if (this.ctx.state === "running") this.arm();
  }
  arm() {
    if (this.silent) return;
    this.armedAt = Date.now();
    this.timer = setTimeout(() => {
      this.ctx.live.delete(this);
      log.push({ what: "end", tag: this.buffer!.tag, at: Date.now() });
      this.onended?.();
    }, this.left);
  }
  freeze() {
    clearTimeout(this.timer);
    this.left -= Date.now() - this.armedAt;
  }
  stop() {
    clearTimeout(this.timer);
    this.ctx.live.delete(this);
    if (this.ctx.state === "running") setTimeout(() => this.onended?.(), 0);
    else this.ctx.endedOnResume.push(this);
  }
}

class FakeCtx {
  static all: FakeCtx[] = [];
  state: AudioContextState = "running";
  live = new Set<FakeSource>();
  endedOnResume: FakeSource[] = [];
  sources: FakeSource[] = [];
  destination = {};
  constructor() {
    FakeCtx.all.push(this);
  }
  createBufferSource() {
    const s = new FakeSource(this);
    this.sources.push(s);
    return s;
  }
  // 10 ms of audible audio per character.
  async decodeAudioData(ab: ArrayBuffer) {
    const tag = new TextDecoder().decode(new Uint8Array(ab));
    const data = new Float32Array(Math.max(2, tag.length * 10)).fill(0.5);
    const audio = { tag, sampleRate: 1000, getChannelData: () => data };
    decoded.push(new Weak(audio));
    return audio;
  }
  async suspend() {
    this.state = "suspended";
    for (const s of this.live) s.freeze();
  }
  async resume() {
    this.state = "running";
    for (const s of this.live) s.arm();
    for (const s of this.endedOnResume.splice(0)) setTimeout(() => s.onended?.(), 0);
  }
}

const opts = { rate: 1, voiceURI: null };
const prefs = { voiceURI: null, rate: 1 };
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", FakeCtx);
  Object.assign(rust, {
    calls: [],
    cancels: [],
    queue: [],
    busy: false,
    synthMs: 40,
    rendersSpeed: true,
    fail: null,
  });
  log.length = 0;
  decoded.length = 0;
  FakeCtx.all.length = 0;
  startThrows = 0;
  neverEnds = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A SpeechQueue on a fresh driver, logging its state changes with times. */
function queue() {
  const states: { s: SpeechState; at: number }[] = [];
  const q = new SpeechQueue({
    driver: cloudTtsDriver(),
    prefs,
    onState: (s) => states.push({ s, at: Date.now() }),
  });
  return { q, states };
}

describe("cloudTtsDriver: nothing wedges", () => {
  it("pause → Stop → the next reply plays and finishes", async () => {
    const { q } = queue();
    q.enqueue("Reply one sentence. ");
    await advance(60); // synthesized and playing
    q.pause(); // ⏸ mid-sentence
    await advance(10);
    q.cancel(); // then Stop
    q.enqueue("Reply two sentence. ");
    await advance(1000);
    expect(FakeCtx.all[FakeCtx.all.length - 1].state).toBe("running");
    expect(started()).toEqual(["Reply one sentence.", "Reply two sentence."]);
    expect(finished()).toContain("Reply two sentence.");
    expect(q.getState()).toBe("idle"); // hands-free can re-arm
  });

  it("a throw from play() costs that sentence, never the queue", async () => {
    const d = cloudTtsDriver();
    const done: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    startThrows = 1;
    d.speak("Bad clip.", opts, () => done.push("bad"));
    await advance(200);
    d.speak("Next reply.", opts, () => done.push("next"));
    await advance(500);
    expect(started()).toEqual(["Next reply."]);
    expect(done).toEqual(["bad", "next"]);
    expect(error).toHaveBeenCalledWith("[tts] playback failed:", expect.any(RangeError));
  });

  it("a clip whose 'ended' never fires is let go after its length plus the grace", async () => {
    const d = cloudTtsDriver();
    const done: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    neverEnds = true;
    d.speak("Stuck clip.", opts, () => done.push("stuck")); // ~110 ms of audio
    await advance(45); // synthesized and started
    neverEnds = false;
    d.speak("Next.", opts, () => done.push("next"));
    await advance(110 + CLIP_GRACE_MS - 100);
    expect(done).toEqual([]);
    await advance(150);
    expect(done[0]).toBe("stuck");
    expect(started()).toEqual(["Stuck clip.", "Next."]);
    expect(warn).toHaveBeenCalled();
    await advance(500);
    expect(done).toEqual(["stuck", "next"]);
  });

  it("⏸ before the first clip has its audio holds that clip too", async () => {
    // A fresh driver has no context until its first clip decodes, so there
    // was nothing for ⏸ to suspend: the clip then played under "paused".
    const d = cloudTtsDriver();
    const done: string[] = [];
    d.speak("Held from the start.", opts, () => done.push("clip"));
    await advance(10); // still synthesizing
    d.pause();
    await advance(5000);
    expect(finished()).toEqual([]);
    d.resume();
    await advance(1000);
    expect(finished()).toEqual(["Held from the start."]);
    expect(done).toEqual(["clip"]);
  });

  it("paused time doesn't count against the watchdog", async () => {
    const d = cloudTtsDriver();
    const done: string[] = [];
    d.speak("A clip long enough to pause in.", opts, () => done.push("clip")); // ~310 ms
    await advance(100);
    d.pause();
    await advance(5000);
    expect(done).toEqual([]);
    d.resume();
    await advance(400);
    expect(done).toEqual(["clip"]);
    expect(finished()).toEqual(["A clip long enough to pause in."]); // it really ended
  });
});

describe("cloudTtsDriver: a cancelled reply stays cancelled", () => {
  it("a sentence still synthesizing at cancel is never played into a later reply", async () => {
    rust.synthMs = 80;
    const { q } = queue();
    q.enqueue("A1. A2. A3. A4. ");
    await advance(5);
    q.cancel(); // barge-in while A is still synthesizing
    await advance(10);
    q.enqueue("B1. B2. ");
    await advance(10);
    q.cancel(); // and again, before B was heard
    await advance(30);
    q.enqueue("C1. C2. ");
    await advance(2000);
    expect(started()).toEqual(["C1.", "C2."]);
    expect(q.getState()).toBe("idle");
  });

  it("a stopped clip's late 'ended' doesn't report the next reply idle early", async () => {
    const { q, states } = queue();
    q.enqueue("Old one. ");
    await advance(60); // playing
    const cancelAt = Date.now();
    // replayLast / Read the plan: cancel and speak in one task.
    q.cancel();
    q.enqueue("New one. New two. ");
    await advance(2000);
    expect(started()).toEqual(["Old one.", "New one.", "New two."]);
    const after = states.filter((x) => x.at >= cancelAt).map((x) => x.s);
    expect(after).toEqual(["idle", "speaking", "idle"]);
    const ends = log.filter((e) => e.what === "end");
    const lastEnd = ends[ends.length - 1];
    expect(lastEnd.tag).toBe("New two.");
    expect(states[states.length - 1].at).toBeGreaterThanOrEqual(lastEnd.at);
  });

  it("every request carries its generation, and cancel drops the old one in Rust", async () => {
    const d = cloudTtsDriver();
    d.speak("One.", opts, () => {});
    await advance(0);
    const first = rust.calls[0].generation;
    d.cancel();
    expect(rust.cancels).toEqual([first]);
    d.speak("Two.", opts, () => {});
    await advance(0);
    expect(rust.calls[1].generation).toBeGreaterThan(first);
    d.cancel();
    d.cancel(); // nothing requested since: no call to Rust
    expect(rust.cancels).toEqual([first, rust.calls[1].generation]);
    // Two drivers never share a generation: tts_cancel is app-wide.
    const other = cloudTtsDriver();
    other.speak("Three.", opts, () => {});
    await advance(0);
    expect(new Set(rust.calls.map((c) => c.generation)).size).toBe(3);
  });

  it("a cancelled request is never reported as a failure", async () => {
    const errors: string[] = [];
    const d = cloudTtsDriver((m) => errors.push(m));
    d.speak("One. ", opts, () => {});
    d.speak("Two. ", opts, () => {});
    d.speak("Three. ", opts, () => {});
    await advance(10);
    d.cancel();
    await advance(500);
    expect(errors).toEqual([]);
    expect(started()).toEqual([]);
  });
});

describe("cloudTtsDriver: read-ahead", () => {
  const plan = (n: number) =>
    Array.from({ length: n }, (_, i) => `Plan sentence ${i}.`).join(" ") + " ";

  it(`synthesizes at most ${READ_AHEAD} sentences past the one in hand`, async () => {
    const { q } = queue();
    q.enqueue(plan(20)); // ▶ Read the plan hands over the whole plan at once
    let worst = 0;
    for (let t = 0; t < 6000; t += 5) {
      await advance(5);
      worst = Math.max(worst, rust.calls.length - finished().length);
    }
    expect(worst).toBe(1 + READ_AHEAD);
    expect(finished()).toHaveLength(20);
  });

  it("after a cancel, the next reply waits only for the request already at the engine", async () => {
    rust.synthMs = 100;
    const { q } = queue();
    q.enqueue(plan(200));
    await advance(150); // the first clip is playing; two more are requested
    q.cancel(); // "Summarize" mid-read
    const asked = Date.now();
    q.primeTurn();
    q.enqueue("Here is the short version. ");
    while (!started().includes("Here is the short version.")) await advance(5);
    const waited = log.find((e) => e.tag === "Here is the short version.")!.at - asked;
    // At most the in-flight request plus its own synthesis; before, it waited
    // behind every sentence of the plan.
    expect(waited).toBeLessThanOrEqual(2 * rust.synthMs + 10);
    expect(rust.calls.length).toBeLessThanOrEqual(1 + READ_AHEAD + 1);
  });

  it("seven ▶ Read presses then Summarize: the reply is heard at once, and nothing of the plan after it", async () => {
    // The sequence from the user's history (gaps scaled down 10×): each press
    // queued the whole plan behind the last, and the Summarize reply was
    // first heard about two and a half hours after its text.
    rust.synthMs = 100;
    const { q } = queue();
    for (const gap of [0, 1710, 2080, 1480, 420, 770, 1500]) {
      await advance(gap);
      q.cancel();
      q.enqueue(plan(200));
      q.flush();
    }
    await advance(1840);
    q.cancel(); // Summarize
    q.primeTurn();
    const asked = Date.now();
    q.enqueue("Here is the short version. ");
    q.flush();
    await advance(2000);
    const after = log.filter((e) => e.what === "start" && e.at >= asked);
    expect(after.map((e) => e.tag)).toEqual(["Here is the short version."]);
    expect(after[0].at - asked).toBeLessThanOrEqual(2 * rust.synthMs + 10);
    expect(q.getState()).toBe("idle");
  });

  it("lets go of each clip once it has played, with no cancel to wait for", async () => {
    // A long read is hundreds of clips and never a cancel: a clip kept alive
    // until the next Stop is the whole plan's decoded audio held in memory.
    const { q } = queue();
    q.enqueue(plan(12));
    await advance(6000);
    expect(finished()).toHaveLength(12);
    for (const ctx of FakeCtx.all) ctx.sources.length = 0; // the fake's own record
    vi.useRealTimers();
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      gc();
    }
    expect(decoded.filter((r) => r.deref()).length).toBeLessThanOrEqual(1);
    q.cancel();
  });
});

describe("cloudTtsDriver: speed, and failures", () => {
  it("Kokoro renders the speed itself, so the clip plays at its natural pitch", async () => {
    const d = cloudTtsDriver();
    d.speak("Faster please.", { rate: 1.5, voiceURI: null }, () => {});
    await advance(50);
    expect(rust.calls[0].speed).toBe(1.5);
    expect(FakeCtx.all[0].sources[0].playbackRate.value).toBe(1);
  });

  it("an engine without a speed parameter gets it as playbackRate", async () => {
    rust.rendersSpeed = false;
    const d = cloudTtsDriver();
    d.speak("Faster please.", { rate: 1.5, voiceURI: null }, () => {});
    await advance(50);
    expect(FakeCtx.all[0].sources[0].playbackRate.value).toBe(1.5);
  });

  it("a failing engine is noted once, and the system voice reads each sentence", async () => {
    const spoken: string[] = [];
    class Utterance {
      rate = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
    vi.stubGlobal("speechSynthesis", {
      speak: (u: Utterance) => {
        spoken.push(u.text);
        setTimeout(() => u.onend?.(), 20);
      },
      cancel: () => {},
      pause: () => {},
      resume: () => {},
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    rust.fail = "OpenAI TTS error 401: invalid key";
    const errors: string[] = [];
    const done: string[] = [];
    const d = cloudTtsDriver((m) => errors.push(m));
    for (const s of ["One.", "Two.", "Three."]) d.speak(s, opts, () => done.push(s));
    await advance(1000);
    expect(errors).toEqual(["OpenAI TTS error 401: invalid key"]);
    expect(spoken).toEqual(["One.", "Two.", "Three."]);
    expect(done).toEqual(["One.", "Two.", "Three."]);
  });
});

describe("playVoiceSample", () => {
  it("auditions a voice without saving it, and reports when it has played", async () => {
    const onEnd = vi.fn();
    playVoiceSample("am_michael+am_fenrir", 1.25, onEnd);
    await advance(0);
    expect(rust.calls[0]).toMatchObject({ voice: "am_michael+am_fenrir", speed: 1.25 });
    await advance(3000);
    expect(onEnd).toHaveBeenCalledWith();
  });

  it("stop drops the request in Rust and never reports after", async () => {
    rust.synthMs = 200;
    const onEnd = vi.fn();
    const stop = playVoiceSample("af_heart", 1, onEnd);
    await advance(10);
    stop();
    expect(rust.cancels).toEqual([rust.calls[0].generation]);
    await advance(3000);
    expect(onEnd).not.toHaveBeenCalled();
    expect(started()).toEqual([]);
  });
});
