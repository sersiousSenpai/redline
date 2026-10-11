// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The voice panel's turn lifecycle against a scripted backend. Each case began
// as a reproduction of "it streams one response and then stops" (a Space press
// anywhere killed the warm child, a typed follow-up vanished, a capture note
// fired on any comment change) and now pins the fixed behaviour.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
type Args = Record<string, unknown> | undefined;
const { handlers, calls, script } = vi.hoisted(() => ({
  handlers: new Map<string, Set<Handler>>(),
  calls: [] as Array<[string, Args]>,
  script: {
    turn: 0,
    dictated: "",
    thread: [] as unknown[],
    status: { up: true, inFlight: false, generation: 1, turn: 0 },
    // The native capture: `dictation_start` arms the mic only when none is
    // open, exactly like dictation.rs, so a test sees a re-arm that never armed.
    micOpen: false,
    armed: 0,
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (ev: string, fn: Handler) => {
    const set = handlers.get(ev) ?? new Set<Handler>();
    set.add(fn);
    handlers.set(ev, set);
    return () => set.delete(fn);
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Args) => {
    calls.push([cmd, args]);
    switch (cmd) {
      case "voice_session_start":
        return 1;
      case "voice_session_status":
        return script.status;
      case "voice_send":
        script.turn += 1;
        return { generation: 1, turn: script.turn };
      case "voice_interrupt":
        return { interrupting: true, generation: 1, turn: script.turn };
      case "voice_thread":
        return script.thread;
      case "comment_offers_pending":
        return [];
      case "tts_get_settings":
        return { engine: "system" };
      case "dictation_start":
        if (!script.micOpen) {
          script.micOpen = true;
          script.armed += 1;
        }
        return null;
      case "dictation_stop":
        script.micOpen = false;
        return script.dictated;
      case "dictation_kill_all":
        script.micOpen = false;
        return null;
      case "delete_comment":
        return true;
      default:
        return null;
    }
  }),
}));

import { VoicePanel } from "./VoicePanel";
import { getVoiceAway, setVoiceAway } from "../audio/voiceAway";
import type { Section } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SID = "plan-1";
const SECTIONS: Section[] = [
  {
    anchorId: "A",
    blockId: "b-a",
    level: 1,
    title: "Plan",
    bodyMarkdown: "Body.",
    paragraphs: [],
    children: [
      { anchorId: "A.1", blockId: "b-a1", level: 2, title: "Rollout", bodyMarkdown: "Roll it.", paragraphs: [], children: [] },
    ],
  },
];

// --- harness -----------------------------------------------------------------

interface FakeUtterance {
  text: string;
  onend?: () => void;
  onerror?: () => void;
}
let utterances: FakeUtterance[];
let root: Root;
let host: HTMLDivElement;

const emit = (ev: string, payload: unknown) =>
  act(async () => {
    for (const fn of handlers.get(ev) ?? []) fn({ payload });
  });
const wait = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const named = (cmd: string) => calls.filter(([c]) => c === cmd);
const names = () => calls.map(([c]) => c);
const sends = () => named("voice_send").map(([, a]) => a as { text: string; context: string | null });
const of = (turn: number, generation = 1) => ({ sessionId: SID, generation, turn });
/** Finish every utterance the fake speech engine is "playing". */
const finishSpeech = () =>
  act(async () => {
    for (const u of utterances.splice(0)) u.onend?.();
  });
const spoken = () => utterances.map((u) => u.text).join(" ");

async function mount() {
  await act(async () => {
    root.render(<VoicePanel sessionId={SID} markdown={"# Plan\n\nBody."} sections={SECTIONS} onClose={() => {}} />);
  });
  await wait();
  await wait();
}

const button = (text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text) || b.getAttribute("aria-label") === text) as HTMLButtonElement;
const input = () => host.querySelector("input[aria-label='Type a message to the voice agent']") as HTMLInputElement;
const panel = () => host.querySelector("[data-tour='voice']") as HTMLElement;

async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    input().form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await wait();
}
async function summarize() {
  await act(async () => button("Summarize").click());
  await wait();
}

/** Hold the talk button, say `text` (heard live unless told otherwise), let go. */
async function holdToTalk(text: string, opts: { heard?: boolean; holdMs?: number } = {}) {
  script.dictated = text;
  const talk = button("Hold to talk");
  await act(async () => talk.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  if (opts.heard ?? true) await emit("dictation-partial", { text });
  await wait(opts.holdMs ?? 320);
  await act(async () => talk.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
  await wait(400);
}

function space(type: "keydown" | "keyup", target: EventTarget) {
  const ev = new KeyboardEvent(type, { code: "Space", key: " ", bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

let scrolled: Element[];
beforeEach(() => {
  calls.length = 0;
  handlers.clear();
  script.turn = 0;
  script.dictated = "";
  script.thread = [];
  script.status = { up: true, inFlight: false, generation: 1, turn: 0 };
  script.micOpen = false;
  script.armed = 0;
  utterances = [];
  setVoiceAway(null);
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
    speak: (u: FakeUtterance) => utterances.push(u),
    cancel: () => {
      utterances = [];
    },
    pause: () => {},
    resume: () => {},
    getVoices: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
    onend?: () => void;
    onerror?: () => void;
    constructor(public text: string) {}
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

// --- Space ---------------------------------------------------------------------

describe("Space to talk", () => {
  it("does nothing with focus outside the panel, and never blocks Space there", async () => {
    await mount();
    await summarize();
    calls.length = 0;
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    for (const target of [window, document.body, outside]) {
      const down = space("keydown", target);
      await wait(300);
      space("keyup", target);
      expect(down.defaultPrevented).toBe(false);
    }
    await wait(400);
    expect(names()).not.toContain("dictation_start");
    expect(names()).not.toContain("voice_interrupt");
    expect(names()).not.toContain("voice_session_stop");
    expect(names()).not.toContain("voice_session_start");
  });

  it("leaves Space to the panel's own buttons and fields", async () => {
    await mount();
    calls.length = 0;
    for (const target of [button("Summarize"), input()]) {
      const down = space("keydown", target);
      await wait(300);
      space("keyup", target);
      expect(down.defaultPrevented).toBe(false);
    }
    expect(names()).not.toContain("dictation_start");
  });

  it("talks only once held for 250 ms with focus in the panel", async () => {
    await mount();
    const spot = panel().querySelector("p")!;
    // A tap: nothing at all.
    space("keydown", spot);
    await wait(100);
    space("keyup", spot);
    await wait(300);
    expect(names()).not.toContain("dictation_start");
    // A hold: it listens, and the release sends what was said.
    script.dictated = "What does section two do?";
    const down = space("keydown", spot);
    expect(down.defaultPrevented).toBe(true);
    await wait(280);
    expect(names()).toContain("dictation_start");
    await emit("dictation-partial", { text: "what does section two do" });
    await wait(200);
    space("keyup", window);
    await wait(400);
    expect(sends().map((s) => s.text)).toEqual(["What does section two do?"]);
  });
});

// --- interrupting ---------------------------------------------------------------

describe("interrupting a reply", () => {
  it("hold-to-talk while thinking stops the turn in place, then sends what was said", async () => {
    await mount();
    await summarize();
    calls.length = 0;
    script.dictated = "Actually, focus on rollout.";
    const talk = button("Hold to talk");
    await act(async () => talk.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    // In place — never a kill and a respawn.
    expect(names()).toContain("voice_interrupt");
    expect(names()).not.toContain("voice_session_stop");
    expect(names()).not.toContain("voice_session_start");
    await emit("dictation-partial", { text: "actually focus on rollout" });
    await wait(320);
    await act(async () => talk.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    await wait(400);
    // The interrupted turn hasn't ended yet, so the utterance waits for it.
    expect(sends()).toEqual([]);
    await emit("voice-interrupted", { ...of(1), text: "", streamedChars: 0, messageId: null, killed: false });
    await wait();
    expect(sends()).toHaveLength(1);
    expect(sends()[0].text).toBe("Actually, focus on rollout.");
    expect(sends()[0].context).toContain("You were interrupted before you said anything");
    expect(host.textContent).toContain("(interrupted)");
  });

  it("talking over a reply being spoken tells the agent where playback was cut", async () => {
    await mount();
    await summarize();
    await emit("voice-delta", { ...of(1), text: "First, the ownership globs are guesses. Second, check attribution is missing." });
    await wait();
    expect(utterances[0]?.text).toBe("First, the ownership globs are guesses.");
    await holdToTalk("Add them all as feedback on the plan.");
    await emit("voice-interrupted", {
      ...of(1),
      text: "First, the ownership globs are guesses. Second, check attribution is missing.",
      streamedChars: 80,
      messageId: "m1",
      killed: false,
    });
    await wait();
    // The half-heard reply stays on screen, marked, never wiped.
    expect(host.textContent).toContain("ownership globs");
    expect(host.textContent).toContain("(interrupted)");
    expect(sends()[1].context).toContain('You were interrupted after saying: "First, the ownership globs are guesses."');
  });

  it("Stop calls voice_interrupt, and the interruption is a muted tag, not an error", async () => {
    await mount();
    await summarize();
    await emit("voice-delta", { ...of(1), text: "The gist is" });
    calls.length = 0;
    await act(async () => button("Stop").click());
    expect(names()).toEqual(["voice_interrupt"]);
    await emit("voice-interrupted", { ...of(1), text: "The gist is", streamedChars: 11, messageId: "m1", killed: false });
    expect(host.textContent).toContain("The gist is");
    expect(host.textContent).toContain("(interrupted)");
    expect(host.querySelector("p[style*='danger']")).toBeNull();
    expect(input().disabled).toBe(false);
  });

  it("a reply cut off before a reload still says so after it, and once", async () => {
    // As voice.rs stores it: the words, then the mark on a line of its own.
    script.thread = [{ id: "m1", sessionKey: SID, role: "agent", text: "The gist is\n⟦interrupted⟧", createdAt: 1 }];
    await mount();
    expect(host.textContent).toContain("The gist is");
    expect(host.textContent).not.toContain("⟦");
    expect(host.textContent!.match(/\(interrupted\)/g)).toHaveLength(1);
    // The mark is the one voice.rs writes.
    const voiceRs = readFileSync(join(process.cwd(), "src-tauri/src/voice.rs"), "utf8");
    expect(voiceRs).toContain('const INTERRUPTED_MARK: &str = "⟦interrupted⟧";');
    expect(voiceRs).toContain('format!("{words}\\n{INTERRUPTED_MARK}")');
  });

  it("starts without the warm mic's pre-roll when it would hold the agent's own voice", async () => {
    await mount();
    await holdToTalk("Focus on rollout.");
    await emit("voice-delta", { ...of(1), text: "Rollout goes in two waves. Then the flag flips." });
    await wait();
    expect(utterances).not.toHaveLength(0);
    // Talking over the spoken reply: the moment before the press is its voice.
    await holdToTalk("Wait, which flag?");
    await emit("voice-interrupted", { ...of(1), text: "Rollout goes in two waves.", streamedChars: 26, messageId: "m1", killed: false });
    await emit("voice-done", { ...of(2), body: "The rollout flag.", messageId: "m2" });
    await finishSpeech();
    // Long enough after it went quiet, the moment before a press is the user's.
    await wait(600);
    await holdToTalk("And the second wave?");
    expect(sends().map((s) => s.text)).toEqual(["Focus on rollout.", "Wait, which flag?", "And the second wave?"]);
    expect(named("dictation_start").map(([, a]) => a)).toEqual([
      { preroll: true },
      { preroll: false },
      { preroll: true },
    ]);
  });

  it("a quick tap of the talk button during thinking sends nothing", async () => {
    await mount();
    await summarize();
    calls.length = 0;
    await holdToTalk("", { heard: false, holdMs: 40 });
    expect(names()).not.toContain("voice_send");
    expect(names()).not.toContain("voice_session_stop");
  });
});

// --- turns ------------------------------------------------------------------------

describe("turns", () => {
  it("a second turn after voice-done sends and renders", async () => {
    await mount();
    await summarize();
    await emit("voice-delta", { ...of(1), text: "Here is the gist." });
    await emit("voice-done", { ...of(1), body: "Here is the gist.", messageId: "m1" });
    await type("And the risks?");
    await submit();
    expect(sends().map((s) => s.text)).toEqual([expect.stringContaining("short spoken summary"), "And the risks?"]);
    await emit("voice-delta", { ...of(2), text: "Mainly replay." });
    await emit("voice-done", { ...of(2), body: "Mainly replay.", messageId: "m2" });
    expect(host.textContent).toContain("Here is the gist.");
    expect(host.textContent).toContain("Mainly replay.");
  });

  it("a typed turn while thinking is queued, never blocked, and sent after done", async () => {
    await mount();
    await summarize();
    await type("Add that as feedback");
    await submit();
    expect(sends()).toHaveLength(1);
    expect(input().value).toBe("");
    expect(input().disabled).toBe(false);
    const tray = host.querySelector("[aria-label='Queued messages']");
    expect(tray?.textContent).toContain("Add that as feedback");
    // …and it stays out of the transcript until it is sent.
    expect(host.querySelectorAll("[data-queued]")).toHaveLength(1);
    await emit("voice-done", { ...of(1), body: "The gist.", messageId: "m1" });
    await wait();
    expect(sends().map((s) => s.text).slice(1)).toEqual(["Add that as feedback"]);
    expect(host.querySelector("[aria-label='Queued messages']")).toBeNull();
  });

  it("× on a queued message puts it back in the box", async () => {
    await mount();
    await summarize();
    await type("Never mind this one");
    await submit();
    await act(async () => button("Put back in the box: Never mind this one").click());
    expect(input().value).toBe("Never mind this one");
    await emit("voice-done", { ...of(1), body: "The gist.", messageId: "m1" });
    await wait();
    expect(sends()).toHaveLength(1);
  });

  it("ignores events from another child or an earlier turn", async () => {
    await mount();
    await summarize();
    await emit("voice-delta", { ...of(1, 0), text: "From a replaced child." });
    await emit("voice-delta", { ...of(0), text: "From an earlier turn." });
    await emit("voice-error", { sessionId: SID, generation: 1, turn: 0, error: "an old turn failed" });
    await emit("voice-done", { ...of(0), body: "An old reply.", messageId: "old" });
    await emit("voice-delta", { ...of(1), text: "The live reply." });
    expect(host.textContent).not.toContain("replaced child");
    expect(host.textContent).not.toContain("earlier turn");
    expect(host.textContent).not.toContain("an old turn failed");
    expect(host.textContent).not.toContain("An old reply.");
    expect(host.textContent).toContain("The live reply.");
  });

  it("never runs a dictated conversation turn through the cleanup pass", async () => {
    await mount();
    await holdToTalk("um so can you make the timeout configurable");
    expect(sends().map((s) => s.text)).toEqual(["um so can you make the timeout configurable"]);
    expect(names()).not.toContain("voice_clean");
  });

  it("adopts a turn still running when it mounts, and leaves the pill a note when it closes mid-turn", async () => {
    script.status = { up: true, inFlight: true, generation: 3, turn: 4 };
    await mount();
    await emit("voice-delta", { ...of(4, 3), text: "Still answering." });
    expect(host.textContent).toContain("Still answering.");
    await act(async () => root.unmount());
    expect(getVoiceAway()).toEqual({ key: SID, state: "thinking" });
    root = createRoot(host);
    await mount();
    expect(getVoiceAway()).toBeNull();
  });

  it("leaves another plan's waiting reply on that plan's pill when it opens", async () => {
    setVoiceAway({ key: "plan-0", state: "waiting" });
    await mount();
    expect(getVoiceAway()).toEqual({ key: "plan-0", state: "waiting" });
  });
});

// --- what is shown before the first word ------------------------------------------

describe("before the first word", () => {
  it("shows what the agent is doing, says it is still going, and offers Stop", async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(<VoicePanel sessionId={SID} markdown={"# Plan"} sections={SECTIONS} onClose={() => {}} />);
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      button("Summarize").click();
      await vi.advanceTimersByTimeAsync(10);
    });
    const thinking = () => host.querySelector("[data-voice-thinking]")?.textContent ?? "";
    expect(thinking()).toContain("Thinking…");
    await emit("voice-meter", { ...of(1), rev: 3, meter: {}, activity: { at: 1, kind: "tool", label: "Bash…" } });
    expect(thinking()).toContain("Reading the plan…");
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(thinking()).toContain("Still reading the plan…");
    expect(thinking()).not.toContain("Stop");
    await act(async () => { await vi.advanceTimersByTimeAsync(33_000); });
    const stop = host.querySelector("[data-voice-thinking] button") as HTMLButtonElement;
    expect(stop.textContent).toBe("Stop");
    calls.length = 0;
    await act(async () => stop.click());
    expect(names()).toContain("voice_interrupt");
  });
});

// --- spoken vs on screen ----------------------------------------------------------

describe("spoken and on-screen parts", () => {
  const REPLY =
    "The risk is a double apply. ⟦§A.1⟧ Gate it on the turn id.\n" +
    "⟦screen⟧\n" +
    "| Case | Fix |\n|---|---|\n| remount | gate on turn |";

  beforeEach(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="doc-article"><h1 data-anchor-id="A">Plan</h1><h2 data-anchor-id="A.1">Rollout</h2></div>`,
    );
  });

  it("speaks only the spoken part, shows the rest as markdown, and points at the section", async () => {
    await mount();
    await summarize();
    for (const chunk of REPLY.match(/[\s\S]{1,7}/g)!) {
      await emit("voice-delta", { ...of(1), text: chunk });
    }
    await emit("voice-done", { ...of(1), body: REPLY, messageId: "m1" });
    expect(spoken()).toContain("The risk is a double apply.");
    expect(spoken()).toContain("Gate it on the turn id.");
    expect(spoken()).not.toMatch(/⟦|Case|remount/);
    // The detail renders as markdown, with no raw marker anywhere.
    expect(host.querySelector("[data-voice-screen] table")).not.toBeNull();
    expect(host.textContent).not.toContain("⟦");
    // The sentence that named the section lit it up when it started playing.
    expect(document.querySelector("[data-anchor-id='A.1']")!.classList.contains("rl-voice-point")).toBe(true);
    // Its chip scrolls there — and nothing else did.
    expect(scrolled).toEqual([]);
    await act(async () => button("§ Rollout").click());
    expect(scrolled).toEqual([document.querySelector("[data-anchor-id='A.1']")]);
  });

  it("says the sentence before a tool while the tool runs, and the last spoken one once the detail begins", async () => {
    await mount();
    await summarize();
    await emit("voice-delta", { ...of(1), text: "The plan has three parts. Let me check the code." });
    expect(spoken()).toBe("The plan has three parts.");
    // The backend's paragraph break where the agent stopped to use a tool:
    // the held sentence is heard now, not after the tool comes back.
    await emit("voice-delta", { ...of(1), text: "\n\n" });
    expect(spoken()).toBe("The plan has three parts. Let me check the code.");
    await emit("voice-delta", { ...of(1), text: "Rollout is the risk. Gate it on the turn id." });
    expect(spoken()).not.toContain("Gate it");
    // Everything after ⟦screen⟧ is for the eye, so the last spoken sentence
    // need not wait for the table to finish streaming.
    await emit("voice-delta", { ...of(1), text: "\n⟦screen⟧\n| Case | Fix |" });
    expect(spoken()).toContain("Gate it on the turn id.");
    expect(spoken()).not.toContain("Case");
  });

  it("renders a stored raw reply through the same reader when the transcript reloads", async () => {
    script.thread = [{ id: "m1", sessionKey: SID, role: "agent", text: REPLY, createdAt: 1 }];
    await mount();
    expect(host.textContent).toContain("The risk is a double apply.");
    expect(host.textContent).not.toContain("⟦");
    expect(button("§ Rollout")).toBeTruthy();
    expect(host.querySelector("[data-voice-screen] table")).not.toBeNull();
  });

  it("sends what the reader is looking at and selected as hidden context", async () => {
    await mount();
    const heading = document.querySelector("[data-anchor-id='A.1']")!;
    document.getSelection()!.selectAllChildren(heading);
    document.dispatchEvent(new Event("selectionchange"));
    await type("add that here");
    await submit();
    const context = sends()[0].context ?? "";
    expect(context).toContain('Looking at §A.1 "Rollout"');
    expect(context).toContain('Selected: "Rollout"');
    // Context rides the turn; the transcript shows only what was typed.
    expect(host.textContent).not.toContain("Looking at");
  });
});

// --- feedback -----------------------------------------------------------------------

describe("feedback captures", () => {
  const offer = (id: string, explicit: boolean) => ({
    id,
    sessionId: SID,
    messageId: null,
    blockId: "b-a1",
    body: "Make the timeout configurable",
    label: "Configurable timeout",
    agentId: "voice",
    status: "pending",
    createdAt: 1,
    explicit,
  });

  it("confirms only a write that happened, naming the section, with Undo and Show", async () => {
    await mount();
    await emit("comments-changed", { sessionId: SID });
    expect(host.textContent).not.toContain("Captured as feedback");
    await emit("voice-captured", {
      sessionId: SID,
      commentId: "c1",
      anchorId: "A.1",
      blockId: "b-a1",
      sectionTitle: "Rollout",
      body: "Make the timeout configurable",
      offerId: "o1",
    });
    expect(host.textContent).toContain("📝 Captured as feedback on “Rollout”: Make the timeout configurable");
    expect(named("voice_note")).toHaveLength(1);
    expect(button("Show")).toBeTruthy();
    await act(async () => button("Undo").click());
    await wait();
    expect(named("delete_comment")[0][1]).toEqual({ sessionId: SID, commentId: "c1" });
    expect(host.textContent).toContain("↩ Removed that feedback from “Rollout”.");
  });

  it("adds an explicit capture once its read-back has played", async () => {
    await mount();
    await summarize();
    await emit("comment-offer", offer("o1", true));
    await emit("voice-delta", { ...of(1), text: "Adding a configurable timeout to Rollout." });
    await emit("voice-done", { ...of(1), body: "Adding a configurable timeout to Rollout.", messageId: "m1" });
    expect(named("comment_offer_add")).toEqual([]);
    await finishSpeech();
    expect(named("comment_offer_add").map(([, a]) => a)).toEqual([{ offerId: "o1" }]);
  });

  it("does not add an explicit capture whose read-back was stopped", async () => {
    await mount();
    await summarize();
    await emit("comment-offer", offer("o1", true));
    await emit("voice-delta", { ...of(1), text: "Adding a configurable timeout to Rollout." });
    await emit("voice-done", { ...of(1), body: "Adding a configurable timeout to Rollout.", messageId: "m1" });
    await act(async () => button("Stop").click());
    await finishSpeech();
    expect(named("comment_offer_add")).toEqual([]);
    expect(button("＋ Add as item")).toBeTruthy();
  });

  it("never adds an explicit capture whose read-back was silenced, not even after the next reply", async () => {
    await mount();
    await summarize();
    await emit("comment-offer", offer("o1", true));
    // Settings opened mid-turn silence the reply, read-back included.
    await act(async () => button("Voice settings").click());
    await emit("voice-done", { ...of(1), body: "Adding a configurable timeout to Rollout.", messageId: "m1" });
    await act(async () => button("Voice settings").click());
    await type("And the risks?");
    await submit();
    await emit("voice-done", { ...of(2), body: "Mainly replay.", messageId: "m2" });
    await finishSpeech();
    expect(named("comment_offer_add")).toEqual([]);
    expect(button("＋ Add as item")).toBeTruthy();
  });

  it("takes a spoken yes to an offered item without making it a turn", async () => {
    await mount();
    await summarize();
    await emit("comment-offer", offer("o2", false));
    await emit("voice-done", { ...of(1), body: "Want me to add a configurable timeout?", messageId: "m1" });
    await finishSpeech();
    await holdToTalk("Yes, add it.");
    expect(named("comment_offer_add").map(([, a]) => a)).toEqual([{ offerId: "o2" }]);
    expect(sends()).toHaveLength(1);
    // The agent hears about it with the next turn.
    await type("What next?");
    await submit();
    expect(sends()[1].context).toContain('They said yes to adding "Configurable timeout"');
  });
});

// --- non-speech -----------------------------------------------------------------------

describe("non-speech captures", () => {
  it("never become turns", async () => {
    await mount();
    await holdToTalk("you", { heard: false });
    await holdToTalk("Thank you.", { heard: false });
    await holdToTalk("Focus on rollout.", { holdMs: 60 });
    expect(sends()).toEqual([]);
    await holdToTalk("Focus on rollout.");
    expect(sends().map((s) => s.text)).toEqual(["Focus on rollout."]);
  });
});

// --- hands-free -----------------------------------------------------------------------

describe("hands-free", () => {
  it("stays on through a benign recognizer error and listens again", async () => {
    await mount();
    await act(async () => button("🎧 Hands-free: off").click());
    await wait(350);
    expect(script.armed).toBe(1);
    // A quiet room: the recognizer gives up on the live task.
    await emit("dictation-error", { error: "No speech detected", domain: "kAFAssistantErrorDomain", code: 1110 });
    expect(host.querySelector("[role='switch']")!.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).not.toContain("No speech detected");
    await wait(1100);
    // The dead capture was closed first, so the mic really listens again.
    expect(script.armed).toBe(2);
  });

  it("closes the capture a real recognizer error left open, so the next hold listens", async () => {
    await mount();
    const talk = button("Hold to talk");
    await act(async () => talk.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await emit("dictation-error", { error: "Speech service crashed", domain: "kAFAssistantErrorDomain", code: 1101 });
    expect(host.textContent).toContain("Speech service crashed");
    await act(async () => talk.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    await wait(400);
    await holdToTalk("Focus on rollout.");
    expect(script.armed).toBe(2);
    expect(sends().map((s) => s.text)).toEqual(["Focus on rollout."]);
  });

  it("re-arms from the turn's end and the audio finishing, not a speech flag", async () => {
    await mount();
    await act(async () => button("🎧 Hands-free: off").click());
    await wait(350);
    // An utterance ends (the detector's silence), and goes out as a turn.
    script.dictated = "Is the replay safe?";
    await emit("dictation-partial", { text: "is the replay safe" });
    await wait(1900);
    expect(sends().map((s) => s.text)).toEqual(["Is the replay safe?"]);
    await emit("voice-delta", { ...of(1), text: "Mostly." });
    await emit("voice-done", { ...of(1), body: "Mostly.", messageId: "m1" });
    await wait(400);
    // Still playing: the mic stays closed.
    expect(named("dictation_start")).toHaveLength(1);
    await finishSpeech();
    await wait(400);
    expect(named("dictation_start")).toHaveLength(2);
    expect(script.armed).toBe(2);
    // Re-armed just after the agent's voice: the pre-roll would hold its end.
    expect(named("dictation_start").map(([, a]) => a)).toEqual([{ preroll: true }, { preroll: false }]);
  });
});
