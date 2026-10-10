// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import { splitReply } from "./voiceStream";

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
});
