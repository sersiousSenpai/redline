// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { splitReply, spokenPause } from "./voiceStream";

const REPLY =
  "Mostly. The risk is a double apply when the panel comes back mid-turn. ⟦§A.2⟧ " +
  "Gate the replay on the turn id.\n" +
  "⟦screen⟧\n" +
  "| Case | Today | Fix |\n|---|---|---|\n| remount ⟦§B⟧ | replays | gate on turn |";

describe("splitReply", () => {
  it("speaks only what comes before ⟦screen⟧, with every marker taken out", () => {
    const r = splitReply(REPLY);
    expect(r.spoken).toBe(
      "Mostly. The risk is a double apply when the panel comes back mid-turn. " +
        "Gate the replay on the turn id.",
    );
    expect(r.spoken).not.toContain("⟦");
    expect(r.screen).toBe(
      "| Case | Today | Fix |\n|---|---|---|\n| remount | replays | gate on turn |",
    );
  });

  it("records where each spoken marker sat: just past the sentence it follows", () => {
    const r = splitReply(REPLY);
    expect(r.marks).toEqual([
      { anchorId: "A.2", at: r.spoken.indexOf("mid-turn.") + "mid-turn.".length },
    ]);
  });

  it("names every section once, spoken ones first, as the chips", () => {
    const r = splitReply("One ⟦§B⟧. Two ⟦§A.1⟧. Again ⟦§B⟧.\n⟦screen⟧\nSee ⟦§C.2.p1⟧ and ⟦§A.1⟧.");
    expect(r.sections).toEqual(["B", "A.1", "C.2.p1"]);
  });

  it("takes the whitespace before a marker with it", () => {
    expect(splitReply("The risk ⟦§A⟧.").spoken).toBe("The risk.");
    expect(splitReply("First. ⟦§A⟧ Second.").spoken).toBe("First. Second.");
    expect(splitReply("⟦§A⟧ Leading.").marks).toEqual([{ anchorId: "A", at: 0 }]);
  });

  it("drops any other bracketed token rather than reading it", () => {
    const r = splitReply("Fine ⟦note⟧ here.");
    expect(r.spoken).toBe("Fine here.");
    expect(r.marks).toEqual([]);
  });

  it("has no screen part when the reply is all for the ear", () => {
    const r = splitReply("Short and spoken.");
    expect(r.screen).toBe("");
    expect(r.sections).toEqual([]);
  });

  it("holds back a marker still arriving, including a partial ⟦screen⟧ line", () => {
    expect(splitReply("Gate it ⟦§A").spoken).toBe("Gate it");
    expect(splitReply("Gate it.\n⟦scr").spoken).toBe("Gate it.");
    expect(splitReply("Gate it.\n⟦scr").screen).toBe("");
  });

  it("only ever grows the spoken text by appending while a reply streams", () => {
    // Whatever went to speech must be a prefix of what follows — speech is fed
    // the difference, and a rewound prefix would be said twice or not at all.
    let prev = "";
    for (let i = 1; i <= REPLY.length; i++) {
      const spoken = splitReply(REPLY.slice(0, i)).spoken;
      expect(spoken.startsWith(prev), `at ${i}: ${JSON.stringify(spoken)}`).toBe(true);
      prev = spoken;
    }
    expect(prev).toBe(splitReply(REPLY).spoken);
  });

  it("renders a reply stored raw exactly as it rendered live", () => {
    expect(splitReply(REPLY.trim())).toEqual(splitReply(REPLY));
  });

  it("reads the reply's tone, whichever delta closes its marker, and never says it", () => {
    const raw = "⟦tone: Calm, warm⟧ Mostly, yes. The replay is safe.";
    for (let i = 1; i < raw.length; i++) {
      const part = splitReply(raw.slice(0, i));
      expect(part.spoken.includes("⟦") || part.spoken.includes("tone"), `at ${i}`).toBe(false);
      expect(part.tone).toBe(i >= raw.indexOf("⟧") + 1 ? "calm, warm" : null);
    }
    expect(splitReply(raw).spoken).toBe("Mostly, yes. The replay is safe.");
    // Not plain words: no tone, and still never spoken.
    expect(splitReply("⟦tone: 50%⟧ Sure.")).toMatchObject({ spoken: "Sure.", tone: null });
    // Only the spoken part's tone counts.
    expect(splitReply("Sure.\n⟦screen⟧\n⟦tone: upbeat⟧").tone).toBeNull();
  });

  it("holds an open marker for 40 characters at most, then speaks what follows it", () => {
    const stray = "Use the ⟦ bracket to open a section in the editor, then type its name.";
    // Within reach of a ⟧ it may be a marker still arriving…
    expect(splitReply(stray.slice(0, 30)).spoken).toBe("Use the");
    // …past it, it never was one, and the spoken text only grew.
    expect(splitReply(stray).spoken).toBe(stray);
    let prev = "";
    for (let i = 1; i <= stray.length; i++) {
      const spoken = splitReply(stray.slice(0, i)).spoken;
      expect(spoken.startsWith(prev), `at ${i}`).toBe(true);
      prev = spoken;
    }
  });
});

describe("spokenPause", () => {
  it("is a line break the stream rests on, or the detail having begun", () => {
    // Where the agent stops to use a tool, the backend leaves a paragraph break.
    expect(spokenPause("Let me check the code.\n\n")).toBe(true);
    expect(spokenPause("Gate it on the turn id.\n⟦screen⟧\n| Case |")).toBe(true);
    // Mid-sentence, or a sentence that may yet go on: not a pause.
    expect(spokenPause("Let me check the code.")).toBe(false);
    expect(spokenPause("First line.\nSecond")).toBe(false);
  });
});
