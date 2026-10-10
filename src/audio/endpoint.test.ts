// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import {
  CAP_MS,
  EARLY_END_MS,
  END_SILENCE_MS,
  Endpointer,
  RESUME_MS,
  SCORE_AFTER_MS,
  UNFINISHED_SILENCE_MS,
  endCommand,
  listenThrough,
  stripCommand,
  type EndReason,

} from "./endpoint";

const ROOM = { rms: -62, peak: -51 };
const VOICE = { rms: -26, peak: -12 };

/** An endpointer fed 50 ms windows, with what it said and when (ms of audio). */
function harness() {
  const log: string[] = [];
  const ends: { text: string; reason: EndReason; resumed: boolean; at: number }[] = [];
  let t = 0;
  const ep = new Endpointer({
    end: (text, reason, resumed) => {
      ends.push({ text, reason, resumed, at: t });
      log.push(`end@${t}`);
    },
    resume: () => log.push(`resume@${t}`),
    barge: () => log.push(`barge@${t}`),
    drop: () => log.push(`drop@${t}`),
  });
  const frames = (ms: number, level: { rms: number; peak: number }) => {
    for (let i = 0; i < ms / 50; i++) {
      t += 50;
      ep.level(level);
    }
  };
  return {
    ep,
    log,
    ends,
    now: () => t,
    quiet: (ms: number) => frames(ms, ROOM),
    /** Speak for `ms`; the recognizer then shows `text`. */
    say: (ms: number, text?: string) => {
      frames(ms, VOICE);
      if (text !== undefined) ep.partial(text);
    },
  };
}

describe("the user's turn ends", () => {
  it(`${END_SILENCE_MS} ms into the silence after words that sound finished`, () => {
    const h = harness();
    h.quiet(500);
    h.say(1200, "rename the panel to TalkPanel");
    const spoke = h.now();
    h.quiet(END_SILENCE_MS - 50);
    expect(h.ends).toEqual([]);
    h.quiet(50);
    expect(h.ends).toEqual([{ text: "rename the panel to TalkPanel", reason: "silence", resumed: false, at: spoke + END_SILENCE_MS }]);
  });

  it(`${UNFINISHED_SILENCE_MS} ms after a conjunction, an article, a filler or a comma`, () => {
    for (const text of ["rename the panel and", "move it into the", "check the build um", "first,"]) {
      const h = harness();
      h.say(1000, text);
      const spoke = h.now();
      h.quiet(UNFINISHED_SILENCE_MS - 50);
      expect(h.ends, text).toEqual([]);
      h.quiet(50);
      expect(h.ends.map((e) => [e.reason, e.at - spoke]), text).toEqual([["unfinished", UNFINISHED_SILENCE_MS]]);
    }
  });

  it("from real silence, not from the transcript: words still growing don't hold it, a slow word doesn't end it", () => {
    const h = harness();
    h.say(800, "open the");
    // The recognizer revises during the pause: no voice, so the clock runs.
    h.quiet(300);
    h.ep.partial("open the plan");
    h.quiet(400);
    expect(h.ends.map((e) => e.text)).toEqual(["open the plan"]);
  });

  it("when the words land late, as soon as they do", () => {
    const h = harness();
    h.say(400);
    // The recognizer's first text comes ~0.9 s into the audio: not noise yet.
    h.quiet(1000);
    expect(h.ends).toEqual([]);
    h.ep.partial("stop");
    expect(h.ends.map((e) => e.text)).toEqual(["stop"]);
  });

  it(`waits up to ${300} ms more for the transcript to catch up with the last word`, () => {
    const h = harness();
    h.say(1000, "rename the panel to");
    h.say(400); // "TalkPanel", not written yet
    h.quiet(END_SILENCE_MS);
    expect(h.ends).toEqual([]);
    h.quiet(100);
    h.ep.partial("rename the panel to TalkPanel");
    expect(h.ends.map((e) => [e.text, e.reason])).toEqual([["rename the panel to TalkPanel", "silence"]]);
    // Never written at all: it ends anyway, with what there is.
    const late = harness();
    late.say(1000, "rename the panel");
    late.say(300);
    late.quiet(END_SILENCE_MS + 250);
    expect(late.ends).toEqual([]);
    late.quiet(50);
    expect(late.ends.map((e) => e.text)).toEqual(["rename the panel"]);
  });

  it("never on a cough, a breath or a tap with no words", () => {
    const h = harness();
    h.quiet(400);
    h.say(300); // cough
    h.quiet(3000);
    expect(h.ends).toEqual([]);
    h.say(1000, "now the real question");
    h.quiet(END_SILENCE_MS);
    expect(h.ends.map((e) => e.text)).toEqual(["now the real question"]);
  });

  it("by the words alone when the mic is too quiet for its level to tell the voice from the room", () => {
    const h = harness();
    h.quiet(500);
    // Recognized, yet never a voice on the meter.
    h.ep.partial("rename the panel");
    h.quiet(600);
    h.ep.partial("rename the panel to TalkPanel");
    const said = h.now();
    h.quiet(UNFINISHED_SILENCE_MS - 50);
    expect(h.ends).toEqual([]);
    h.quiet(50);
    expect(h.ends.map((e) => [e.text, e.reason, e.at - said])).toEqual([
      ["rename the panel to TalkPanel", "silence", UNFINISHED_SILENCE_MS],
    ]);
  });

  it(`at the ${CAP_MS / 1000} s cap after "hold on", without the command`, () => {
    const h = harness();
    h.say(1200, "Rename the panel, hold on.");
    h.quiet(CAP_MS - 50);
    expect(h.ends).toEqual([]);
    h.quiet(50);
    expect(h.ends.map((e) => [e.text, e.reason])).toEqual([["Rename the panel", "cap"]]);
  });

  it('"hold on" then more: the usual rules again, and the words kept', () => {
    const h = harness();
    h.say(1200, "Rename the panel, hold on");
    h.quiet(3000);
    h.say(800, "Rename the panel, hold on, to TalkPanel");
    h.quiet(END_SILENCE_MS);
    expect(h.ends.map((e) => e.text)).toEqual(["Rename the panel, hold on, to TalkPanel"]);
  });

  it('250 ms after "send now", without the command; a tap sends at once', () => {
    const h = harness();
    h.say(1200, "Rename the panel. Send now.");
    h.quiet(250);
    expect(h.ends.map((e) => [e.text, e.reason])).toEqual([["Rename the panel.", "send-now"]]);
    const tap = harness();
    tap.say(600, "rename it and");
    tap.ep.sendNow();
    expect(tap.ends.map((e) => [e.text, e.reason])).toEqual([["rename it and", "send-now"]]);
    // Before anything is said, a tap does nothing; once a voice is heard it
    // sends, though the recognizer hasn't written a word of it yet.
    const early = harness();
    early.quiet(300);
    early.ep.sendNow();
    expect(early.ends).toEqual([]);
    early.say(500);
    early.ep.sendNow();
    expect(early.ends.map((e) => [e.text, e.reason])).toEqual([["", "send-now"]]);
  });

  it(`at the cap when the words stop changing under a mic that never goes quiet`, () => {
    const h = harness();
    h.say(1000, "la la la");
    h.say(CAP_MS - 50);
    expect(h.ends).toEqual([]);
    h.say(50);
    expect(h.ends.map((e) => e.reason)).toEqual(["cap"]);
  });
});

describe("after the turn ends", () => {
  it(`speaking again within ${RESUME_MS / 1000} s, before the reply is heard, carries the turn on`, () => {
    const h = harness();
    h.say(1000, "rename the panel");
    h.quiet(END_SILENCE_MS);
    h.quiet(1000);
    h.say(150);
    expect(h.log).toEqual([`end@${h.now() - 1150}`, `resume@${h.now()}`]);
    h.say(600, "to TalkPanel");
    h.quiet(END_SILENCE_MS);
    expect(h.ends.map((e) => [e.text, e.resumed])).toEqual([
      ["rename the panel", false],
      ["to TalkPanel", true],
    ]);
  });

  it("a click right after the end is not speaking again", () => {
    const h = harness();
    h.say(1000, "rename the panel");
    h.quiet(END_SILENCE_MS + 300);
    h.say(100);
    h.quiet(500);
    expect(h.log.filter((l) => l.startsWith("resume"))).toEqual([]);
  });

  it("carrying on with no words (a cough) still ends, so the first part is answered", () => {
    const h = harness();
    h.say(1000, "rename the panel");
    h.quiet(END_SILENCE_MS + 200);
    h.say(300);
    h.quiet(UNFINISHED_SILENCE_MS);
    expect(h.ends.map((e) => [e.text, e.resumed])).toEqual([
      ["rename the panel", false],
      ["", true],
    ]);
  });

  it(`after ${RESUME_MS / 1000} s it takes two words to interrupt the reply (or "stop")`, () => {
    const h = harness();
    h.say(1000, "rename the panel");
    h.quiet(END_SILENCE_MS + RESUME_MS + 100);
    h.say(400, "yeah");
    h.quiet(END_SILENCE_MS);
    expect(h.log.slice(1)).toEqual([`drop@${h.now()}`]);
    h.say(600, "no wait");
    expect(h.log.slice(2)).toEqual([`barge@${h.now()}`]);
    // The interruption is a turn of its own.
    h.say(400, "no wait, the other panel");
    h.quiet(END_SILENCE_MS);
    expect(h.ends.map((e) => [e.text, e.resumed])).toEqual([
      ["rename the panel", false],
      ["no wait, the other panel", false],
    ]);
    const stop = harness();
    stop.say(1000, "rename the panel");
    stop.quiet(END_SILENCE_MS + RESUME_MS + 100);
    stop.say(400, "Stop.");
    expect(stop.log.slice(1)).toEqual([`barge@${stop.now()}`]);
  });

  it("a late rewrite of the words just sent is not someone talking over the reply", () => {
    const h = harness();
    h.say(1000, "rename the panel");
    h.quiet(END_SILENCE_MS);
    // The recognizer re-punctuates the finished utterance a beat after it
    // ended, before the next one starts: no voice came with it.
    h.ep.partial("Rename the panel.");
    h.quiet(300);
    expect(h.log).toEqual([`end@${h.now() - 300}`]);
    // So speaking again still carries the turn on.
    h.say(150);
    expect(h.log.slice(1)).toEqual([`resume@${h.now()}`]);
    h.say(600, "to TalkPanel");
    h.quiet(END_SILENCE_MS);
    expect(h.ends.map((e) => [e.text, e.resumed])).toEqual([
      ["rename the panel", false],
      ["to TalkPanel", true],
    ]);
  });

  it("a typed turn's reply has no turn of theirs to carry on", () => {
    const h = harness();
    h.ep.replyStarted();
    h.quiet(300);
    h.say(400);
    expect(h.log).toEqual([]);
    h.ep.partial("what about");
    expect(h.log).toEqual([`barge@${h.now()}`]);
  });

  it("the reply over, the floor is theirs again", () => {
    const h = harness();
    h.say(1000, "rename the panel");
    h.quiet(END_SILENCE_MS + RESUME_MS + 100);
    h.ep.replyOver();
    h.say(500, "thanks");
    h.quiet(END_SILENCE_MS);
    expect(h.ends.map((e) => e.text)).toEqual(["rename the panel", "thanks"]);
  });
});

describe("where the reply plays", () => {
  it("names how far the mic listens from the output route", () => {
    expect(listenThrough({ kind: "headphones", transport: "builtin" })).toBe("reply");
    expect(listenThrough({ kind: "headphones", transport: "bluetooth" })).toBe("turn");
    expect(listenThrough({ kind: "speakers", transport: "builtin" })).toBe("thinking");
    expect(listenThrough({ kind: "unknown", transport: "usb" })).toBe("thinking");
    expect(listenThrough(null)).toBe("thinking");
  });

  it("on speakers: deaf from the reply's first sound, so it never hears itself", () => {
    const h = harness();
    h.ep.setListenThrough("thinking");
    h.say(1000, "rename the panel");
    h.quiet(END_SILENCE_MS + 300);
    expect(h.ep.listening).toBe(true);
    h.ep.agentAudible(true);
    expect(h.ep.listening).toBe(false);
    // The reply, heard through the mic: ignored, however long.
    h.say(3000, "Renaming it now, and updating the tests");
    h.quiet(END_SILENCE_MS);
    expect(h.log).toEqual([`end@${h.now() - 4000}`]);
  });

  it("on wired headphones: through the reply, where two words interrupt and a 'yeah' is dropped", () => {
    const h = harness();
    h.ep.setListenThrough("reply");
    h.say(1000, "rename the panel");
    h.quiet(END_SILENCE_MS + 300);
    h.ep.agentAudible(true);
    expect(h.ep.listening).toBe(true);
    h.say(300, "Yeah.");
    h.quiet(END_SILENCE_MS);
    h.say(500, "Actually no");
    expect(h.log.slice(1)).toEqual([`drop@${h.now() - 500}`, `barge@${h.now()}`]);
  });

  it("a reply that sounds while the floor is theirs takes it: read-aloud, a replay, a typed turn's", () => {
    // Nothing said (a cough at most): on speakers, deaf at once.
    for (const before of [() => {}, (h: ReturnType<typeof harness>) => h.say(300)]) {
      const h = harness();
      h.ep.setListenThrough("thinking");
      h.quiet(500);
      before(h);
      h.quiet(200);
      h.ep.agentAudible(true);
      expect(h.ep.listening).toBe(false);
      h.say(2000, "Here is the plan, section by section");
      h.quiet(END_SILENCE_MS);
      expect(h.log).toEqual([]);
    }
    // Mid-sentence on speakers: what they said goes out before the mic would
    // hear the reply.
    const mid = harness();
    mid.ep.setListenThrough("thinking");
    mid.say(1000, "rename the panel");
    mid.ep.agentAudible(true);
    expect(mid.ends.map((e) => e.text)).toEqual(["rename the panel"]);
    expect(mid.ep.listening).toBe(false);
    // On wired headphones the mic can't hear it: nothing said, two words
    // interrupt it; mid-sentence, they carry on.
    const quiet = harness();
    quiet.ep.setListenThrough("reply");
    quiet.ep.agentAudible(true);
    quiet.say(600, "wait what");
    expect(quiet.log).toEqual([`barge@${quiet.now()}`]);
    const talking = harness();
    talking.ep.setListenThrough("reply");
    talking.say(1000, "rename the panel");
    talking.ep.agentAudible(true);
    talking.say(500, "rename the panel to TalkPanel");
    talking.quiet(END_SILENCE_MS);
    expect(talking.ends.map((e) => e.text)).toEqual(["rename the panel to TalkPanel"]);
  });

  it("on a Bluetooth headset: not past the turn", () => {
    const h = harness();
    h.ep.setListenThrough("turn");
    h.say(1000, "rename the panel");
    h.quiet(END_SILENCE_MS);
    expect(h.ep.listening).toBe(false);
    h.quiet(200);
    h.say(1000, "and the tests");
    expect(h.log).toEqual([`end@${h.now() - 1200}`]);
  });
});

describe("with a scorer", () => {
  /** A scorer answering from `answers` by how much silence it was asked at. */
  function scored(answers: (silence: number) => number | null) {
    const h = harness();
    const asked: number[] = [];
    let since = 0;
    h.ep.setScorer(() => {
      asked.push(h.now() - since);
      return answers(h.now() - since);
    });
    return {
      ...h,
      asked,
      /** Speak, the transcript caught up as the voice stops. */
      turn(text: string) {
        h.say(1000, text);
        since = h.now();
      },
    };
  }

  it(`asked at ${SCORE_AFTER_MS} ms and sure it is finished, ends at ${EARLY_END_MS} ms — not before the last word is written`, () => {
    const s = scored(() => 0.98);
    s.turn("rename the panel to TalkPanel");
    const spoke = s.now();
    s.quiet(EARLY_END_MS - 50);
    expect(s.ends).toEqual([]);
    s.quiet(50);
    expect(s.ends.map((e) => [e.reason, e.at - spoke])).toEqual([["scored", EARLY_END_MS]]);
    expect(s.asked).toEqual([SCORE_AFTER_MS]);
  });

  it("sure, but the transcript never caught up: the plain rule, catch-up wait and all", () => {
    const s = scored(() => 0.99);
    s.say(1000, "rename the panel");
    s.say(300);
    s.quiet(END_SILENCE_MS + 250);
    expect(s.ends).toEqual([]);
    s.quiet(50);
    expect(s.ends.map((e) => [e.text, e.reason])).toEqual([["rename the panel", "silence"]]);
  });

  it("holds an unsure pause, asking every 250 ms, and ends when it says finished", () => {
    const s = scored((silence) => (silence >= 1450 ? 0.7 : 0.2));
    s.turn("rename the panel");
    s.quiet(1400);
    expect(s.ends).toEqual([]);
    s.quiet(50);
    expect(s.ends.map((e) => e.reason)).toEqual(["scored"]);
    expect(s.asked).toEqual([250, 700, 950, 1200, 1450]);
  });

  it(`never holds past ${UNFINISHED_SILENCE_MS / 1000} s`, () => {
    const s = scored(() => 0.1);
    s.turn("rename the panel");
    s.quiet(UNFINISHED_SILENCE_MS - 50);
    expect(s.ends).toEqual([]);
    s.quiet(50);
    expect(s.ends.map((e) => e.reason)).toEqual(["unfinished"]);
  });

  it("between sure and unsure at 250 ms, ends at the plain rule's time once it agrees", () => {
    const s = scored(() => 0.8);
    s.turn("rename the panel");
    s.quiet(END_SILENCE_MS);
    expect(s.ends.map((e) => e.reason)).toEqual(["scored"]);
    expect(s.asked).toEqual([250, 700]);
  });

  it("is never asked about words that trail off", () => {
    const s = scored(() => 0.99);
    s.turn("rename the panel and");
    s.quiet(UNFINISHED_SILENCE_MS);
    expect(s.asked).toEqual([]);
    expect(s.ends.map((e) => e.reason)).toEqual(["unfinished"]);
  });

  it("failing, leaves the plain rule", () => {
    const s = scored(() => null);
    s.turn("rename the panel");
    s.quiet(END_SILENCE_MS);
    expect(s.ends.map((e) => e.reason)).toEqual(["silence"]);
    expect(s.asked).toEqual([250]);
  });

  it("slow, isn't waited for past the plain rule's time", async () => {
    const h = harness();
    const pending: ((p: number) => void)[] = [];
    h.ep.setScorer(() => new Promise<number>((resolve) => pending.push(resolve)));
    h.say(1000, "rename the panel");
    h.quiet(END_SILENCE_MS);
    expect(h.ends.map((e) => e.reason)).toEqual(["silence"]);
    // Its answer, when it finally comes, changes nothing.
    pending.forEach((resolve) => resolve(0.99));
    await Promise.resolve();
    expect(h.ends).toHaveLength(1);
  });

  it("judges an answer when it lands, and not for a pause that is already over", async () => {
    const h = harness();
    const pending: ((p: number) => void)[] = [];
    h.ep.setScorer(() => new Promise<number>((resolve) => pending.push(resolve)));
    h.say(1000, "rename the panel");
    h.quiet(SCORE_AFTER_MS);
    // They carry on before the answer comes: it was about the last pause.
    h.say(300, "rename the panel to TalkPanel");
    pending.shift()!(0.99);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.ends).toEqual([]);
    // This pause's answer is slow to come, but lands before the plain rule.
    h.quiet(EARLY_END_MS + 50);
    expect(h.ends).toEqual([]);
    pending.shift()!(0.99);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.ends.map((e) => [e.text, e.reason])).toEqual([["rename the panel to TalkPanel", "scored"]]);
  });
});

describe("spoken commands", () => {
  it("are found only at the end, and taken off cleanly", () => {
    expect(endCommand("Rename it. Send now.")).toBe("send");
    expect(endCommand("rename it send it now")).toBe("send");
    expect(endCommand("send now the report to Sam")).toBe(null);
    expect(endCommand("Rename the panel, hold on.")).toBe("hold");
    expect(endCommand("wait a second")).toBe("hold");
    expect(endCommand("let me think…")).toBe("hold");
    expect(endCommand("hold on to the old one")).toBe(null);
    expect(stripCommand("Rename it. Send now.")).toBe("Rename it.");
    expect(stripCommand("Rename the panel, hold on.")).toBe("Rename the panel");
    expect(stripCommand("hold on")).toBe("");
  });
});
