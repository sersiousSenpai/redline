// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CORRECTION_WINDOW_MS, corrections, isCorrection, watchCorrections, type AroundText } from "./vocabLearn";

describe("a correction", () => {
  const before = "Note: the civ core sidecar in tts.rs needs a timeout.";
  const span: [number, number] = [5, before.length];
  const swap = (from: string, to: string) => corrections(before, before.replace(from, to), span);

  it("is a swap of up to three dictated words", () => {
    expect(swap("civ core", "Kokoro")).toEqual([{ heard: "civ core", meant: "Kokoro" }]);
    expect(swap("sidecar", "side-car process")).toEqual([{ heard: "sidecar", meant: "side-car process" }]);
    // Punctuation around a word is not part of it.
    expect(swap("timeout.", "deadline.")).toEqual([{ heard: "timeout", meant: "deadline" }]);
  });

  it("is never typing more, deleting, or editing outside the dictation", () => {
    expect(swap("timeout.", "timeout, soon.")).toEqual([]);
    expect(swap(" civ core", "")).toEqual([]);
    expect(swap("Note:", "Notes:")).toEqual([]);
    expect(swap("the civ core sidecar in tts.rs", "it")).toEqual([]);
  });

  it("is never grammar: an ending, a sentence's capital, punctuation, an everyday word", () => {
    expect(isCorrection("timeout", "timeouts", false)).toBe(false);
    expect(isCorrection("the", "a", false)).toBe(false);
    expect(isCorrection("sidecar", "the sidecar", false)).toBe(false);
    expect(isCorrection("rename", "Rename", true)).toBe(false);
    expect(isCorrection("Kokoro", "kokoro", false)).toBe(false);
    expect(isCorrection("42", "43", false)).toBe(false);
  });

  it("is a name's capitals mid-sentence", () => {
    expect(isCorrection("tauri", "Tauri", false)).toBe(true);
    expect(isCorrection("voicepanel", "VoicePanel", true)).toBe(true);
    expect(swap("sidecar", "SideCar")).toEqual([{ heard: "sidecar", meant: "SideCar" }]);
  });

  it("is found with several edits in the field at once", () => {
    const after = before.replace("civ core", "Kokoro").replace("timeout.", "timeout soon. Also the pin.");
    expect(corrections(before, after, span)).toEqual([{ heard: "civ core", meant: "Kokoro" }]);
  });
});

describe("watching for corrections", () => {
  let value: string;
  let edit: () => void;
  const around: AroundText = {
    value: () => value,
    span: () => [0, 31],
    onEdit(fn) {
      edit = fn;
      return () => (edit = () => {});
    },
  };
  const type = (next: string) => {
    value = next;
    edit();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    value = "The civ core sidecar needs work";
  });
  afterEach(() => vi.useRealTimers());

  it("learns a swap once the typing around it pauses, and once only", () => {
    const learn = vi.fn();
    const watch = watchCorrections(around, learn);
    type("The K sidecar needs work");
    type("The Koko sidecar needs work");
    type("The Kokoro sidecar needs work");
    expect(learn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1300);
    expect(learn.mock.calls).toEqual([[{ heard: "civ core", meant: "Kokoro" }]]);
    type("The Kokoro sidecar needs work!");
    vi.advanceTimersByTime(1300);
    expect(learn).toHaveBeenCalledOnce();
    watch.stop();
  });

  it("learns at once when the words go (the composer sent and cleared)", () => {
    const learn = vi.fn();
    watchCorrections(around, learn);
    type("The Kokoro sidecar needs work");
    type("");
    expect(learn.mock.calls).toEqual([[{ heard: "civ core", meant: "Kokoro" }]]);
  });

  it("stops after the window", () => {
    const learn = vi.fn();
    watchCorrections(around, learn);
    vi.advanceTimersByTime(CORRECTION_WINDOW_MS);
    type("The Kokoro sidecar needs work");
    vi.advanceTimersByTime(2000);
    expect(learn).not.toHaveBeenCalled();
  });

  it("compares from the polished words once a polish lands", () => {
    const learn = vi.fn();
    const watch = watchCorrections(around, learn);
    value = "The Civ Core sidecar needs work.";
    watch.rebase();
    type("The Kokoro sidecar needs work.");
    vi.advanceTimersByTime(1300);
    expect(learn.mock.calls).toEqual([[{ heard: "Civ Core", meant: "Kokoro" }]]);
  });
});
