// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { lastPhraseStart, layoutCommands, readIntents } from "./voiceIntents";

describe("readIntents", () => {
  it("takes back the last phrase, then writes the rest (p32)", () => {
    expect(readIntents("Scratch that, make it seven hundred milliseconds.", { canSend: false })).toEqual({
      edits: ["scratch"],
      text: "make it seven hundred milliseconds.",
      send: false,
    });
  });

  it("undoes, and sends from a chat composer (p35)", () => {
    expect(readIntents("Undo that and send it.", { canSend: true })).toEqual({ edits: ["undo"], text: "", send: true });
    // Anywhere else "send it" has nothing to submit, but this utterance was
    // all command: none of it is written.
    expect(readIntents("Undo that and send it.", { canSend: false })).toEqual({ edits: ["undo"], text: "", send: false });
  });

  it("reads a command only at the edges, standing alone", () => {
    expect(readIntents("Undo the migration step first.", { canSend: true })).toEqual({
      edits: [],
      text: "Undo the migration step first.",
      send: false,
    });
    expect(readIntents("Please send it to the reviewer.", { canSend: true }).send).toBe(false);
    expect(readIntents("Fix the tray and send it", { canSend: true })).toEqual({ edits: [], text: "Fix the tray", send: true });
    // A plan comment keeps the words: there is nothing to send.
    expect(readIntents("Fix the tray and send it", { canSend: false })).toEqual({
      edits: [],
      text: "Fix the tray and send it",
      send: false,
    });
  });

  it("reads commands said together, in order", () => {
    expect(readIntents("Scratch that. Scratch that.", { canSend: false }).edits).toEqual(["scratch", "scratch"]);
    expect(readIntents("undo", { canSend: false })).toEqual({ edits: ["undo"], text: "", send: false });
    expect(readIntents("Send it.", { canSend: true })).toEqual({ edits: [], text: "", send: true });
  });
});

describe("layoutCommands", () => {
  it("opens a paragraph (p33)", () => {
    expect(layoutCommands("New paragraph. The second phase adds the studio voice.")).toBe(
      "\n\nThe second phase adds the studio voice.",
    );
    expect(layoutCommands("That was phase one. New paragraph. The second phase.")).toBe(
      "That was phase one.\n\nThe second phase.",
    );
    expect(layoutCommands("first line new line second line")).toBe("first line\nSecond line");
  });

  it("makes list items of bullets (p34)", () => {
    expect(layoutCommands("Bullet fix the queue tray. Bullet fix the scroll pin.")).toBe(
      "- Fix the queue tray\n- Fix the scroll pin",
    );
    expect(layoutCommands("Two things. Bullet point, the tray. Bullet the pin.")).toBe("Two things.\n- The tray\n- The pin");
  });

  it("opens the next item wherever a recognizer put the next bullet (the shared set's p34)", () => {
    const items = "- Fix the queue tray\n- Fix the scroll pin";
    expect(layoutCommands("Bullet fix the queue tray, Bullet fix the scroll pin.")).toBe(items);
    expect(layoutCommands("BulletFix the queue tray, BulletFix the scroll pin,")).toBe(items);
    expect(layoutCommands("Bullet fix the queue tray bullet fix the scroll pin")).toBe(items);
    // The noun is no command.
    expect(layoutCommands("Bullet make the bullet points smaller.")).toBe("- Make the bullet points smaller");
    expect(layoutCommands("Fix the bullet list, and the bullet spacing.")).toBe("Fix the bullet list, and the bullet spacing.");
  });

  it("drops the clause before a mid-utterance scratch that (p32's correction, said in one go)", () => {
    expect(layoutCommands("Make it three hundred milliseconds, scratch that, make it seven hundred.")).toBe(
      "Make it seven hundred.",
    );
    expect(layoutCommands("Keep the pill. Make it red, scratch that, blue.")).toBe("Keep the pill. Blue.");
  });
});

describe("lastPhraseStart", () => {
  it("finds the last sentence of a dictation", () => {
    expect(lastPhraseStart("Fix the tray.")).toBe(0);
    const text = "Fix the tray. Then the pin.";
    expect(text.slice(lastPhraseStart(text))).toBe("Then the pin.");
    expect("- A\n- B".slice(lastPhraseStart("- A\n- B"))).toBe("- B");
  });
});
