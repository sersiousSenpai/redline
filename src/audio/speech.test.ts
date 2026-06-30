// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it, vi } from "vitest";
import {
  SpeechQueue,
  takeSentences,
  takeFirstChunk,
  clampRate,
  type SpeechDriver,
} from "./speech";

describe("takeSentences", () => {
  it("emits complete sentences and keeps the trailing partial", () => {
    const { sentences, rest } = takeSentences(
      "Hello there. How are you? I am fi",
    );
    expect(sentences).toEqual(["Hello there.", "How are you?"]);
    expect(rest).toBe(" I am fi");
  });

  it("does not split a period that has no following whitespace yet", () => {
    // The period may be mid-stream (e.g. "1." about to become "1.5"), so it
    // only counts as a boundary once whitespace or EOL confirms it.
    const { sentences, rest } = takeSentences("version 1.");
    expect(sentences).toEqual([]);
    expect(rest).toBe("version 1.");
  });

  it("treats newlines as boundaries so a heading is its own unit", () => {
    const { sentences, rest } = takeSentences("# Plan\nFirst step");
    expect(sentences).toEqual(["# Plan"]);
    expect(rest).toBe("First step");
  });

  it("absorbs trailing closing punctuation", () => {
    // Trailing space confirms the final sentence is complete; without it the
    // last token is held back (it might continue in the next stream chunk).
    const { sentences } = takeSentences('He said "go." Then left. ');
    expect(sentences).toEqual(['He said "go."', "Then left."]);
  });
});

describe("takeFirstChunk", () => {
  it("waits while there's too little to say naturally", () => {
    expect(takeFirstChunk("Yes, ok")).toBeNull();
  });

  it("starts at the first clause once there's enough", () => {
    const r = takeFirstChunk("Yes — checked the actual code, and all three");
    expect(r).not.toBeNull();
    expect(r!.chunk).toBe("Yes — checked the actual code,");
    expect(r!.rest).toBe(" and all three");
  });

  it("prefers a complete sentence when one is ready", () => {
    const r = takeFirstChunk("All done. More to come");
    expect(r!.chunk).toBe("All done.");
    expect(r!.rest).toBe(" More to come");
  });

  it("hard-cuts very long run-ons with no break", () => {
    const long = "word ".repeat(40); // 200 chars, no punctuation
    const r = takeFirstChunk(long);
    expect(r).not.toBeNull();
    expect(r!.chunk.length).toBeLessThanOrEqual(110);
  });
});

describe("SpeechQueue primeTurn", () => {
  it("speaks an early clause first, then resumes sentence splitting", () => {
    const { driver, spoken } = fakeDriver();
    const q = new SpeechQueue({ driver, prefs: { voiceURI: null, rate: 1 } });
    q.primeTurn();
    q.enqueue("Yes — checked the actual code, and it all landed. Next bit");
    // First clause spoken immediately, then the completed sentence.
    expect(spoken).toEqual([
      "Yes — checked the actual code,",
      "and it all landed.",
    ]);
  });
});

describe("clampRate", () => {
  it("bounds to 0.5–2.0 and defaults non-finite to 1", () => {
    expect(clampRate(0.1)).toBe(0.5);
    expect(clampRate(5)).toBe(2);
    expect(clampRate(Number.NaN)).toBe(1);
    expect(clampRate(1.234)).toBe(1.23);
  });
});

/** A driver that records spoken text in order and finishes each utterance
 *  synchronously, so queue ordering/state is deterministic in tests. */
function fakeDriver() {
  const spoken: string[] = [];
  const driver: SpeechDriver = {
    speak: (text, _opts, onDone) => {
      spoken.push(text);
      onDone();
    },
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return { driver, spoken };
}

describe("SpeechQueue", () => {
  it("speaks streamed sentences in arrival order, holding partial text", () => {
    const { driver, spoken } = fakeDriver();
    const q = new SpeechQueue({ driver, prefs: { voiceURI: null, rate: 1 } });
    q.enqueue("First sentence. Second sen");
    expect(spoken).toEqual(["First sentence."]);
    q.enqueue("tence. Third.");
    // "Second sentence." now completes; "Third." has no trailing space yet.
    expect(spoken).toEqual(["First sentence.", "Second sentence."]);
    q.flush();
    expect(spoken).toEqual(["First sentence.", "Second sentence.", "Third."]);
  });

  it("cancel clears the buffer and stops the driver", () => {
    const { driver, spoken } = fakeDriver();
    const q = new SpeechQueue({ driver, prefs: { voiceURI: null, rate: 1 } });
    q.enqueue("Partial without terminator");
    q.cancel();
    expect(driver.cancel).toHaveBeenCalled();
    q.flush(); // buffer was cleared, so nothing new is spoken
    expect(spoken).toEqual([]);
    expect(q.getState()).toBe("idle");
  });

  it("reports speaking then idle as utterances drain", () => {
    const states: string[] = [];
    const { driver } = fakeDriver();
    const q = new SpeechQueue({
      driver,
      prefs: { voiceURI: null, rate: 1 },
      onState: (s) => states.push(s),
    });
    q.enqueue("Done. "); // trailing space completes the sentence
    expect(states).toEqual(["speaking", "idle"]);
  });
});
