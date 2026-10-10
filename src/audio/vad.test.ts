// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { VoiceActivity, looksUnfinished } from "./vad";

/** `n` windows at `rms` dBFS (peak a typical 11 dB above). */
const windows = (n: number, rms: number) =>
  Array.from({ length: n }, () => ({ rms, peak: Math.min(0, rms + 11) }));

function run(vad: VoiceActivity, levels: { rms: number; peak: number }[]): boolean[] {
  return levels.map((l) => vad.push(l));
}

describe("VoiceActivity", () => {
  it("never hears a voice in a quiet room, nor in digital silence", () => {
    const vad = new VoiceActivity();
    expect(run(vad, windows(40, -100))).not.toContain(true);
    expect(run(vad, windows(100, -62))).not.toContain(true);
  });

  it("hears speech from its second loud window on, and its pauses as silence", () => {
    const vad = new VoiceActivity();
    run(vad, windows(20, -62));
    expect(run(vad, windows(4, -28))).toEqual([false, true, true, true]);
    expect(run(vad, windows(3, -61))).toEqual([false, false, false]);
  });

  it("does not take a lone click for a voice", () => {
    const vad = new VoiceActivity();
    run(vad, windows(20, -62));
    expect(run(vad, [...windows(1, -20), ...windows(5, -62), ...windows(1, -18)])).not.toContain(true);
  });

  it("learns a fan's hum as the room within a few seconds, and still hears speech over it", () => {
    const vad = new VoiceActivity();
    run(vad, windows(20, -62));
    // The fan comes on: loud enough to read as a voice at first…
    const fan = run(vad, windows(400, -46));
    expect(fan[5]).toBe(true);
    // …and as the room once the floor has climbed to it.
    expect(fan.slice(-100)).not.toContain(true);
    expect(vad.noiseFloor).toBeGreaterThan(-48);
    expect(run(vad, windows(4, -30)).slice(1)).toEqual([true, true, true]);
  });

  it("keeps hearing a long sentence: the floor never climbs into it", () => {
    const vad = new VoiceActivity();
    run(vad, windows(20, -62));
    // Six seconds of speech with a short dip every half second.
    const sentence = Array.from({ length: 12 }, () => [...windows(8, -27), ...windows(2, -45)]).flat();
    const heard = run(vad, sentence);
    expect(heard.filter((v, i) => sentence[i].rms === -27 && !v).length).toBeLessThanOrEqual(12);
    expect(vad.noiseFloor).toBeLessThan(-50);
  });
});

describe("looksUnfinished", () => {
  it("is mid-thought on a conjunction, an article, a filler or a trailing comma", () => {
    for (const text of [
      "rename the panel and",
      "move it into the",
      "check the build um",
      "Rename the panel,",
      "first we should, uh",
      "the problem is",
      "open the Drafter and then",
      "Open the drafter and start a...",
      "Whisper hallucinates when the…",
      "I think we need to",
    ]) {
      expect(looksUnfinished(text), text).toBe(true);
    }
  });

  it("does not trust a full stop the recognizer put after a dangling word", () => {
    expect(looksUnfinished("The Kokoro sidecar in the.")).toBe(true);
    expect(looksUnfinished("Rename the panel and.")).toBe(true);
  });

  it("is finished on a content word, a question, or words that often end a request", () => {
    for (const text of [
      "rename VoicePanel to TalkPanel",
      "Rename the panel.",
      "what is this used for?",
      "where does it come from?",
      "do it",
      "fix that",
      "turn it on",
      "I think so",
      "",
      'say "hello"',
    ]) {
      expect(looksUnfinished(text), text).toBe(false);
    }
  });
});
