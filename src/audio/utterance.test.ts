// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { MIN_UTTERANCE_MS, isBenignDictationError, isNonSpeech, offerAnswer } from "./utterance";

const held = (text: string, heard = true, heldMs: number | null = 900) => ({ text, heard, heldMs });

describe("isNonSpeech", () => {
  it("drops a hold too short to carry a word", () => {
    expect(isNonSpeech(held("Focus on rollout.", true, MIN_UTTERANCE_MS - 1))).toBe(true);
    expect(isNonSpeech(held("Focus on rollout.", true, MIN_UTTERANCE_MS))).toBe(false);
  });

  it("drops nothing at all, and a transcriber's own note", () => {
    expect(isNonSpeech(held("   "))).toBe(true);
    expect(isNonSpeech(held("…"))).toBe(true);
    expect(isNonSpeech(held("[BLANK_AUDIO]"))).toBe(true);
    expect(isNonSpeech(held("(upbeat music)"))).toBe(true);
  });

  it("drops the stock phrases Whisper writes over silence when nothing was heard live", () => {
    for (const t of ["you", "You.", "Thank you.", "Thanks for watching!", "Thank you for watching."]) {
      expect(isNonSpeech(held(t, false)), t).toBe(true);
    }
    // …and a word or two nobody heard live is the same silence.
    expect(isNonSpeech(held("Okay.", false))).toBe(true);
  });

  it("keeps real words, including a thank-you the live recognizer heard too", () => {
    expect(isNonSpeech(held("Thank you.", true))).toBe(false);
    expect(isNonSpeech(held("Is the replay safe on remount?", false))).toBe(false);
    expect(isNonSpeech(held("Yes.", true, null))).toBe(false);
  });
});

describe("offerAnswer", () => {
  it("hears a yes", () => {
    for (const t of ["Yes.", "yeah", "Sure, please.", "Add it.", "Okay, add them all as feedback.", "go ahead", "Yes add that"]) {
      expect(offerAnswer(t), t).toBe("yes");
    }
  });

  it("hears a no", () => {
    for (const t of ["No.", "Nope", "skip it", "No thanks.", "Don’t add it.", "never mind", "Leave it."]) {
      expect(offerAnswer(t), t).toBe("no");
    }
  });

  it("leaves anything longer to the agent", () => {
    expect(offerAnswer("Yes, but make the timeout configurable first.")).toBeNull();
    expect(offerAnswer("Add a section about rollback.")).toBeNull();
    expect(offerAnswer("No, I meant the other one.")).toBeNull();
  });
});

describe("isBenignDictationError", () => {
  it("knows the recognizer's 'no (more) speech' errors from real failures", () => {
    expect(isBenignDictationError({ error: "No speech detected", domain: "kAFAssistantErrorDomain", code: 1110 })).toBe(true);
    expect(isBenignDictationError({ error: "x", domain: "kAFAssistantErrorDomain", code: 216 })).toBe(true);
    expect(isBenignDictationError({ error: "Request was canceled", domain: "kLSRErrorDomain", code: 301 })).toBe(true);
    expect(isBenignDictationError({ error: "Siri and Dictation are disabled", domain: "kAFAssistantErrorDomain", code: 1700 })).toBe(false);
    expect(isBenignDictationError({ error: "microphone permission denied" })).toBe(false);
  });
});
