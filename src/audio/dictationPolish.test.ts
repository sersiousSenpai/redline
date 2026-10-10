// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => "polished"));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { cleanupChild, polished, polishEnabled, setPolishEnabled, wantsPolish } from "./dictationPolish";

beforeEach(() => localStorage.clear());

describe("when to polish", () => {
  it("only past twelve words, or for a list", () => {
    expect(wantsPolish("fix the tray and the pin")).toBe(false);
    expect(wantsPolish("one two three four five six seven eight nine ten eleven twelve")).toBe(false);
    expect(wantsPolish("one two three four five six seven eight nine ten eleven twelve thirteen")).toBe(true);
    expect(wantsPolish("- Fix the queue tray\n- Fix the scroll pin")).toBe(true);
    expect(wantsPolish("Two things. First, the tray; second, the pin")).toBe(true);
    // An ordinal inside a sentence is no list.
    expect(wantsPolish("the first message waits")).toBe(false);
  });

  it("is on until the user turns it off", () => {
    expect(polishEnabled()).toBe(true);
    setPolishEnabled(false);
    expect(polishEnabled()).toBe(false);
    setPolishEnabled(true);
    expect(polishEnabled()).toBe(true);
  });
});

describe("the cleanup child", () => {
  it("is voice_clean, with the vocabulary's ranked head as its spellings", async () => {
    const vocab = Array.from({ length: 80 }, (_, i) => `Term${i}`);
    expect(await cleanupChild.polish("so the tray", vocab)).toBe("polished");
    expect(invoke).toHaveBeenCalledWith("voice_clean", { text: "so the tray", vocab: vocab.slice(0, 60) });
  });
});

describe("what comes back", () => {
  const SAID = " so i think the tray should sit above the composer and the thread never moves";

  it("is used in place of the words, their edges kept", () => {
    expect(polished(SAID, "So I think the tray should sit above the composer, and the thread never moves.", [])).toBe(
      " so I think the tray should sit above the composer, and the thread never moves.",
    );
    // Running on into the text after: no full stop of its own.
    expect(polished(SAID, "So I think the tray should sit above the composer, and the thread never moves.", [], " because")).toBe(
      " so I think the tray should sit above the composer, and the thread never moves",
    );
  });

  it("loses the model's own wrapping", () => {
    expect(polished("the tray moves", "<text>\nThe tray moves.\n</text>", [])).toBe("the tray moves.");
    expect(polished("the tray moves", "“The tray moves.”", [])).toBe("the tray moves.");
  });

  it("is thrown away when it answers, summarizes or adds", () => {
    const question = "can you tell me why the tray hides the newest line when a reply is long";
    expect(polished(question, "The tray floats over the thread, so a long reply's last line sits under it — pad the thread by the tray's height.", [])).toBeNull();
    expect(polished(SAID, "Tray above composer.", [])).toBeNull();
    expect(polished(SAID, `${SAID.trim()} and also we should probably add a toggle for it too`, [])).toBeNull();
  });

  it("is thrown away when it drops a term's spelling or a list item", () => {
    expect(polished("the Kokoro sidecar in tts.rs needs a timeout", "The Coco Rho sidecar in TTS.rs needs a timeout.", ["Kokoro", "tts.rs"])).toBeNull();
    expect(polished("- Fix the tray\n- Fix the pin", "Fix the tray and the pin.", [])).toBeNull();
  });

  it("is nothing when nothing changed", () => {
    expect(polished("The tray moves.", "The tray moves.", [])).toBeNull();
    expect(polished("The tray moves.", "", [])).toBeNull();
  });
});
