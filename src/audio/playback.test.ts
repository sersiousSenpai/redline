// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, describe, expect, it, vi } from "vitest";

import { Playback, stallMs, type Clip } from "./playback";
import { SpeechQueue, type SpeechDriver } from "./speech";

/** A driver that plays nothing: each clip ends when the test says so. */
function fakeDriver() {
  const pending: { text: string; done: () => void }[] = [];
  const driver: SpeechDriver = {
    speak: (text, _opts, onDone) => pending.push({ text, done: onDone }),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  /** End the oldest clip still playing. */
  const finish = () => pending.shift()?.done();
  return { driver, pending, finish };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Playback", () => {
  it("knows which clip is sounding, in order", () => {
    const started: string[] = [];
    const idle = vi.fn();
    const p = new Playback({ onClipStart: (c) => started.push(c.text), onIdle: idle });
    const { driver, finish } = fakeDriver();
    const d = p.wrap(driver);
    const opts = { rate: 1, voiceURI: null };
    d.speak("One.", opts, () => {});
    d.speak("Two.", opts, () => {});
    expect(p.current()?.text).toBe("One.");
    expect(started).toEqual(["One."]);
    finish();
    expect(p.current()?.text).toBe("Two.");
    expect(started).toEqual(["One.", "Two."]);
    finish();
    expect(p.busy()).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("hands a section mark to the clip it follows", () => {
    const starts: Clip[] = [];
    const p = new Playback({ onClipStart: (c) => starts.push(c) });
    const queue = new SpeechQueue({ driver: p.wrap(fakeDriver().driver) });
    const text = "The risk is a double apply. Gate it on the turn id.";
    // The marker sat right after "apply." — offset 27.
    p.narrate(text, [{ at: 27, anchorId: "A.2", kind: "point" }]);
    queue.enqueue(text);
    queue.flush();
    expect(starts[0].text).toBe("The risk is a double apply.");
    expect(starts[0].marks.map((m) => m.anchorId)).toEqual(["A.2"]);
  });

  it("points at once for a mark that arrives after its sentence started sounding", () => {
    // A streamed reply's first clause goes out at its period, before the
    // marker after it has streamed in.
    const points: string[] = [];
    const p = new Playback({ onPoint: (ms) => points.push(...ms.map((m) => m.anchorId)) });
    const { driver, finish } = fakeDriver();
    const d = p.wrap(driver);
    const opts = { rate: 1, voiceURI: null };
    p.narrate("The risk is a double apply.");
    d.speak("The risk is a double apply.", opts, () => {});
    // Its marker streams in while it is already sounding: point now.
    p.narrate("", [{ at: 0, anchorId: "A.2", kind: "point" }]);
    expect(points).toEqual(["A.2"]);
    // The next sentence is cut while the first still plays; its marker waits
    // with it.
    p.narrate(" Gate it.");
    d.speak("Gate it.", opts, () => {});
    p.narrate("", [{ at: 0, anchorId: "B", kind: "point" }]);
    expect(points).toEqual(["A.2"]);
    finish();
    expect(points).toEqual(["A.2", "B"]);
  });

  it("drops a cancelled clip's late end instead of ending the next reply early", () => {
    const p = new Playback();
    const { driver, pending } = fakeDriver();
    const states: string[] = [];
    const queue = new SpeechQueue({ driver: p.wrap(driver), onState: (s) => states.push(s) });
    queue.enqueue("Old reply sentence.\n");
    const stale = pending[0];
    queue.cancel();
    queue.enqueue("New reply first.\nNew reply second.\n");
    // The cancelled clip reports in late.
    stale.done();
    expect(queue.getState()).toBe("speaking");
    expect(p.current()?.text).toBe("New reply first.");
  });

  it("flags a clip that never ends, and not while paused", () => {
    vi.useFakeTimers();
    const stall = vi.fn();
    const p = new Playback({ onStall: stall });
    const d = p.wrap(fakeDriver().driver);
    d.speak("A short line.", { rate: 1, voiceURI: null }, () => {});
    d.pause();
    vi.advanceTimersByTime(60_000);
    expect(stall).not.toHaveBeenCalled();
    d.resume();
    vi.advanceTimersByTime(stallMs("A short line.", 1) + 1);
    expect(stall).toHaveBeenCalledTimes(1);
  });

  it("knows what was heard: exactly where the driver keeps a timeline, else the whole clip", () => {
    const p = new Playback();
    const { driver, finish } = fakeDriver();
    const opts = { rate: 1, voiceURI: null };
    // A driver that can't tell: the clip sounding is the best guess.
    const plain = p.wrap(driver);
    plain.speak("One sentence.", opts, () => {});
    expect(p.heard()).toBe("One sentence.");
    finish();
    expect(p.heard()).toBeNull();
    // One that can: its words, or the clip before when none of this one yet.
    let heard = "";
    const timed = p.wrap({ ...driver, heard: () => heard });
    timed.speak("First clip.", opts, () => {});
    timed.speak("The second clip is longer.", opts, () => {});
    expect(p.heard()).toBe("");
    heard = "First";
    expect(p.heard()).toBe("First");
    heard = "";
    finish();
    expect(p.heard()).toBe("First clip.");
    heard = "The second";
    expect(p.heard()).toBe("The second");
    // A new run of speech starts from nothing heard.
    finish();
    timed.speak("Next reply.", opts, () => {});
    heard = "";
    expect(p.heard()).toBe("");
  });

  it("passes the reply's start, its end of text and its timeline through", () => {
    const begin = vi.fn();
    const flush = vi.fn();
    const p = new Playback();
    const d = p.wrap({ ...fakeDriver().driver, beginTurn: begin, flush, heard: () => "x" });
    const q = new SpeechQueue({ driver: d });
    q.primeTurn();
    q.flush();
    expect(begin).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(d.heard!()).toBe("x");
  });

  it("forgets everything on cancel and says it is idle", () => {
    const idle = vi.fn();
    const p = new Playback({ onIdle: idle });
    const d = p.wrap(fakeDriver().driver);
    d.speak("Something.", { rate: 1, voiceURI: null }, () => {});
    d.cancel();
    expect(p.busy()).toBe(false);
    expect(p.current()).toBeNull();
    expect(idle).toHaveBeenCalledTimes(1);
  });
});
