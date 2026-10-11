// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { cleanupDictation, fitToContext, spokenBreaks } from "./dictationCleanup";
import { readIntents } from "./voiceIntents";
import { buildVocab, VOCAB_CAP } from "./vocab";

/** What a release writes into a field with `before` ahead of the caret. */
const dictate = (said: string, before = "", vocab: string[] = []) =>
  fitToContext(cleanupDictation(readIntents(spokenBreaks(said), { canSend: false }).text, { vocab }), before);

describe("the spoken forms of the shared test set", () => {
  it("p32: a correction in digits", () => {
    expect(dictate("Scratch that, make it seven hundred milliseconds.")).toBe("Make it 700 milliseconds.");
  });

  it("p33: a paragraph break, only where there is a paragraph to break", () => {
    expect(dictate("New paragraph. The second phase adds the studio voice.", "The first phase ships the door.")).toBe(
      "\n\nThe second phase adds the studio voice.",
    );
    expect(dictate("New paragraph. The second phase adds the studio voice.")).toBe("The second phase adds the studio voice.");
    // The on-device recognizer writes the break itself.
    expect(dictate("\n\nThe second phase adds the studio voice", "The first phase ships the door.")).toBe(
      "\n\nThe second phase adds the studio voice",
    );
    expect(dictate("first line\nsecond line")).toBe("First line\nSecond line");
  });

  it("p34: list items on their own lines", () => {
    expect(dictate("Bullet fix the queue tray. Bullet fix the scroll pin.", "Next:")).toBe(
      "\n- Fix the queue tray\n- Fix the scroll pin",
    );
  });

  it("p35: a command utterance writes nothing", () => {
    expect(dictate("Undo that and send it.", "Some text.")).toBe("");
  });
});

describe("cleanupDictation", () => {
  it("drops fillers and keeps the sentence whole", () => {
    expect(cleanupDictation("So, um, the plan is, uh, fine.")).toBe("So, the plan is, fine.");
    expect(cleanupDictation("Um the hook pins too early")).toBe("the hook pins too early");
    expect(cleanupDictation("Hmm, keep the umbrella and the error text")).toBe("keep the umbrella and the error text");
  });

  it("writes punctuation said aloud", () => {
    expect(cleanupDictation("is it safe question mark")).toBe("is it safe?");
    expect(cleanupDictation("first comma second semicolon third colon done period")).toBe("first, second; third: done.");
    expect(cleanupDictation("The Kokoro sidecar in tts dot rs needs a timeout.")).toBe("The Kokoro sidecar in tts.rs needs a timeout.");
    expect(cleanupDictation("The worktree lives under redline dash wt.")).toBe("The worktree lives under redline-wt.");
    expect(cleanupDictation("use off underscore main and and slash or")).toBe("use off_main and and/or");
    // Content, not commands.
    expect(cleanupDictation("A trial period of two weeks.")).toBe("A trial period of 2 weeks.");
    expect(cleanupDictation("The reply waiting dot on the pill")).toBe("The reply waiting dot on the pill");
  });

  it("writes numbers that measure, label or count past nine in digits", () => {
    expect(cleanupDictation("pre roll three hundred milliseconds of audio")).toBe("pre roll 300 milliseconds of audio");
    expect(cleanupDictation("The binary is forty one megabytes")).toBe("The binary is 41 megabytes");
    expect(cleanupDictation("forty-one items")).toBe("41 items");
    expect(cleanupDictation("wait two and a half seconds")).toBe("wait 2.5 seconds");
    expect(cleanupDictation("about two point five times")).toBe("about 2.5 times");
    expect(cleanupDictation("fifty percent of turns")).toBe("50% of turns");
    expect(cleanupDictation("one hundred and five tests")).toBe("105 tests");
    expect(cleanupDictation("two thousand three hundred files")).toBe("2300 files");
    expect(cleanupDictation("Gate it on macOS fourteen")).toBe("Gate it on macOS 14");
    expect(cleanupDictation("phase two then port eighty eighty")).toBe("phase 2 then port 8080");
    // Small numbers in prose stay words.
    expect(cleanupDictation("one owner holds the mic and two lanes wait")).toBe("one owner holds the mic and two lanes wait");
    expect(cleanupDictation("give it one second")).toBe("give it one second");
    // A word an object would answer to is not a number.
    expect(cleanupDictation("the constructor and toString take two hundred ms")).toBe(
      "the constructor and toString take 200 ms",
    );
  });

  it("writes dates", () => {
    expect(cleanupDictation("open DESIGN dash twenty twenty six")).toBe("open DESIGN-2026");
    expect(cleanupDictation("ship it October tenth")).toBe("ship it October 10");
    expect(cleanupDictation("since nineteen ninety nine and twenty oh five")).toBe("since 1999 and 2005");
  });

  it("spells the vocabulary's terms its way, the higher-ranked first", () => {
    const vocab = ["Front Door", "FrontDoor", "Kokoro", "useStickToBottom", "VoicePanel", "tts.rs", "MLX", "IT"];
    expect(cleanupDictation("the front door uses kokoro", { vocab })).toBe("the Front Door uses Kokoro");
    expect(cleanupDictation("I think the use stick to bottom hook pins too early", { vocab })).toBe(
      "I think the useStickToBottom hook pins too early",
    );
    expect(cleanupDictation("rename voicepanel, and the mlx sidecar in TTS.rs", { vocab })).toBe(
      "rename VoicePanel, and the MLX sidecar in tts.rs",
    );
    // An UpperCamel name said as words is how people talk about the thing.
    expect(cleanupDictation("open the voice panel", { vocab })).toBe("open the voice panel");
    // An acronym spelled like an everyday word never takes that word over.
    expect(cleanupDictation("it works", { vocab })).toBe("it works");
  });

  it("puts a name where the recognizer wrote what it sounded like", () => {
    const vocab = ["Kokoro", "Tauri", "CoreML", "ReplyBlock", "DiscussPill"];
    expect(cleanupDictation("The Coro sidecar in tts dot rs needs a timeout", { vocab })).toBe(
      "The Kokoro sidecar in tts.rs needs a timeout",
    );
    expect(cleanupDictation("check why the Tori build fails", { vocab })).toBe("check why the Tauri build fails");
    expect(cleanupDictation("it runs on the neural engine with corn ML", { vocab })).toBe(
      "it runs on the neural engine with CoreML",
    );
    // A name said as words stays words, as the spelling step leaves them.
    expect(cleanupDictation("let the reply black keep its byline", { vocab })).toBe("let the reply block keep its byline");
    expect(cleanupDictation("move the discuss bill state", { vocab })).toBe("move the discuss pill state");
    // Lines and bullets said aloud stay where they were.
    expect(cleanupDictation("first point new line bullet ask the Coro sidecar", { vocab })).toBe(
      "first point.\n- Ask the Kokoro sidecar",
    );
  });

  it("leaves what only sounds like a name", () => {
    const vocab = ["Kokoro", "Polis", "chatStatus", "Macs", "IDEs", "tts_studio_voice", "TalkPanel", "Drafter", "ChatRoom"];
    for (const said of [
      // Everyday words, lowercase as the recognizer wrote them.
      "the coral reef needs a polish",
      // A sentence's first word is capitalized whatever it is.
      "Coro is the opening word",
      // Two edits from a code name, as words.
      "the chat stays open",
      // Short names take one edit, and capitals are letters, not a name.
      "on an Apple M3 Max with message IDs",
      // A run never starts or ends on a little word, nor runs past the name.
      "add the studio voice",
      "rename the voice panel to talk panel",
      "open the Drafter",
      // One letter off as words, but sounding apart: "that room" is no ChatRoom.
      "the voice lanes merged onto that room",
    ]) {
      expect(cleanupDictation(said, { vocab }), said).toBe(cleanupDictation(said, {}));
    }
  });

  it("applies learned corrections first", () => {
    expect(cleanupDictation("the civ core sidecar", { pairs: [{ heard: "civ core", meant: "Kokoro" }] })).toBe(
      "the Kokoro sidecar",
    );
  });

  it("stays well under 10 ms with a full vocabulary", () => {
    const plan = Array.from({ length: 200 }, (_, i) => `Use FooBar${i} in \`baz_${i}.rs\` and the Name${i} Thing.`).join("\n");
    const vocab = buildVocab({ plan });
    expect(vocab).toHaveLength(VOCAB_CAP);
    const said =
      "So um the Kokoro sidecar in tts dot rs needs a timeout of seven hundred milliseconds comma and the front door " +
      "should close when I click outside the card new paragraph bullet fix the queue tray bullet fix the scroll pin " +
      "then rerun cargo test and check the forty one megabyte binary against the budget question mark";
    cleanupDictation(said, { vocab });
    const runs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      cleanupDictation(said, { vocab });
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    expect(runs[10]).toBeLessThan(10);
  });
});

describe("fitToContext", () => {
  it("spaces against the text around the caret", () => {
    expect(fitToContext("the tray", "Fix")).toBe(" the tray");
    expect(fitToContext("the tray", "Fix ", "first")).toBe("the tray ");
    expect(fitToContext(", then ship", "Fix it")).toBe(", then ship");
    expect(fitToContext("Kokoro", "(")).toBe("Kokoro");
  });

  it("capitalizes where a sentence starts, and lowercases an everyday opener mid-sentence", () => {
    expect(fitToContext("fix the tray.", "")).toBe("Fix the tray.");
    expect(fitToContext("fix the tray.", "Done. ")).toBe("Fix the tray.");
    expect(fitToContext("Rename the hook", "and then")).toBe(" rename the hook");
    // A name keeps its capital.
    expect(fitToContext("Kokoro is slow", "and then")).toBe(" Kokoro is slow");
  });

  it("flattens to one line for a one-line field", () => {
    expect(fitToContext("- Fix the tray\n- Fix the pin", "", "", { line: true })).toBe("Fix the tray Fix the pin");
    expect(fitToContext("\n\nNext part", "Done.", "", { line: true })).toBe(" Next part");
  });
});
