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
    engine: "system",
    // Another owner (a dictation) holds the mic: an open start is refused.
    taken: null as string | null,
    // Where the reply plays (`dictation_status`), and the end-of-turn model:
    // downloaded or not, and its answer.
    route: { kind: "speakers", transport: "builtin" } as { kind: string; transport: string },
    turnModel: false,
    turnScore: 0.99 as number | null,
    // The recognizer's final transcript of an utterance `dictation_cycle` ends,
    // and what holds its answer back (a final slow to come).
    final: "",
    cycleWait: null as Promise<void> | null,
  },
}));
// The studio voice's driver, recording what it is handed (studioTts.ts has
// its own tests).
interface StudioSpoken {
  text: string;
  tone?: string | null;
  done: () => void;
}
const studio = vi.hoisted(() => ({
  drivers: [] as Array<{ opts: Record<string, unknown>; spoken: StudioSpoken[]; heard: string }>,
  warmed: 0,
  surfaces: [] as Array<[string, boolean]>,
}));
vi.mock("../audio/studioTts", () => ({
  studioTtsDriver: (opts: Record<string, unknown>) => {
    const d = { opts, spoken: [] as StudioSpoken[], heard: "" };
    studio.drivers.push(d);
    return {
      speak: (text: string, o: { tone?: string | null }, done: () => void) =>
        d.spoken.push({ text, tone: o.tone, done }),
      cancel: () => {
        d.spoken.length = 0;
      },
      pause: () => {},
      resume: () => {},
      heard: () => d.heard,
    };
  },
  warmStudio: async () => {
    studio.warmed += 1;
  },
  studioSurface: (surface: string, open: boolean) => studio.surfaces.push([surface, open]),
}));
vi.mock("./StudioVoiceCard", () => ({ StudioVoiceCard: () => null }));
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
        return { engine: script.engine, studioStyle: "calm" };
      case "dictation_start":
        // Refused a beat later, as over IPC: the panel renders in between.
        if (script.taken && args?.kind === "open") return new Promise((r) => setTimeout(() => r({ granted: false, holder: script.taken }), 5));
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
      case "dictation_cycle": {
        const final = script.final;
        if (script.cycleWait) await script.cycleWait;
        return final;
      }
      case "dictation_status":
        return {
          holder: null,
          engine: "auto",
          whisperModel: "base",
          whisperActive: null,
          whisperModels: [],
          outputRoute: script.route,
        };
      case "turn_scorer":
        if (args?.op === "warm" && !script.turnModel) throw "the end-of-turn model isn't downloaded";
        return { runtime: true, model: script.turnModel, warm: script.turnModel, score: script.turnScore };
      // Kokoro: the sentence itself as its "audio", which the fake context
      // below plays.
      case "tts_synth":
        return { audioBase64: Buffer.from(String(args?.text)).toString("base64"), mime: "audio/wav", speed: 1 };
      case "delete_comment":
        return true;
      default:
        return null;
    }
  }),
}));

import { VoicePanel } from "./VoicePanel";
import { strip } from "./DictationStrip";
import { broker } from "../audio/dictationBroker";
import { installDictation } from "../audio/dictationHost";
import { composerAt } from "../audio/dictationTarget";
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
/** What the system voice was told besides `speak`. */
let synthCalls: string[];
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

async function mount(markdown = "# Plan\n\nBody.") {
  await act(async () => {
    root.render(<VoicePanel sessionId={SID} markdown={markdown} sections={SECTIONS} onClose={() => {}} />);
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

/** `ms` of the mic's level windows at `rms` dBFS (a voice at -26, the room at
 *  -62), one at a time, as they arrive: what a window sets off lands first. */
async function levels(rms: number, ms: number) {
  for (let i = 0; i < ms / 50; i++) {
    await act(async () => {
      for (const fn of handlers.get("dictation-level") ?? []) fn({ payload: { owner: "voice", rms, peak: rms + 11, ms: 0 } });
    });
  }
}
/** Hands-free: say `text` for `ms`, the recognizer writing it as it goes. */
async function speak(text: string, ms = 1000) {
  await levels(-26, ms);
  await emit("dictation-partial", { owner: "voice", text });
}
const room = (ms: number) => levels(-62, ms);
async function handsFreeOn() {
  await act(async () => button("🎧 Hands-free: off").click());
  await wait(350);
  await room(500);
}

/** Hold the talk button, say `text` (heard live unless told otherwise), let go. */
async function holdToTalk(text: string, opts: { heard?: boolean; holdMs?: number } = {}) {
  script.dictated = text;
  const talk = button("Hold to talk");
  await act(async () => talk.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  if (opts.heard ?? true) await emit("dictation-partial", { owner: "voice", text });
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

/** Poll until `test` holds (real timers), then insist on it. */
async function until(test: () => boolean, ms = 2000) {
  for (let t = 0; t < ms && !test(); t += 10) await wait(10);
  expect(test()).toBe(true);
}

/** The composer's one button (SendStopButton), whatever its face. */
const primary = () => input().form!.lastElementChild as HTMLButtonElement;

let scrolled: Element[];
beforeEach(() => {
  calls.length = 0;
  // The dictation broker is the app's one, and listens once for good.
  for (const ev of [...handlers.keys()]) if (!ev.startsWith("dictation-")) handlers.delete(ev);
  script.turn = 0;
  script.dictated = "";
  script.thread = [];
  script.status = { up: true, inFlight: false, generation: 1, turn: 0 };
  script.micOpen = false;
  script.armed = 0;
  script.engine = "system";
  studio.drivers.length = 0;
  studio.warmed = 0;
  studio.surfaces.length = 0;
  script.taken = null;
  script.route = { kind: "speakers", transport: "builtin" };
  script.turnModel = false;
  script.turnScore = 0.99;
  script.final = "";
  script.cycleWait = null;
  utterances = [];
  synthCalls = [];
  setVoiceAway(null);
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
    speak: (u: FakeUtterance) => utterances.push(u),
    cancel: () => {
      synthCalls.push("cancel");
      utterances = [];
    },
    pause: () => synthCalls.push("pause"),
    resume: () => synthCalls.push("resume"),
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
  vi.unstubAllGlobals();
});

// --- Space ---------------------------------------------------------------------

describe("the input row", () => {
  it("is one row: the box, the mic and the send button, and the panel is where what is said becomes a turn", async () => {
    await mount();
    const row = input().form!;
    expect([...row.children].map((c) => c.getAttribute("aria-label") ?? c.textContent)).toEqual([
      "Type a message to the voice agent",
      "Hold to talk",
      "Send",
    ]);
    expect(input().placeholder).toBe("Ask, or hold ⌥ to talk…");
    // The hold-to-dictate key, even from the typed box, is a turn here.
    expect(composerAt(input())?.spec.turn).toBe(true);
  });

  it("shows its own capture on the dictation strip over the row, the waveform and the words, and takes it down after", async () => {
    await mount();
    script.dictated = "is the replay safe";
    const talk = button("Hold to talk");
    await act(async () => talk.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(strip.get()).toMatchObject({ owner: "voice", phase: "listening", text: "", hint: "release to send" });
    // Over the row above the input, short of its Hands-free switch: in
    // hands-free the panel listens most of the time, and that is the way out.
    vi.spyOn(input().form!, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 500, 340, 32));
    vi.spyOn(document.querySelector('[role="switch"]')!, "getBoundingClientRect").mockReturnValue(new DOMRect(260, 466, 90, 26));
    const anchor = strip.get()?.anchor;
    expect(anchor && "rect" in anchor ? anchor.rect() : null).toEqual(new DOMRect(10, 500, 242, 32));
    await emit("dictation-partial", { owner: "voice", text: "is the replay" });
    await emit("dictation-level", { owner: "voice", rms: -20, peak: -6, ms: 50 });
    expect(strip.get()?.text).toBe("is the replay");
    expect(strip.get()?.levels).toHaveLength(1);
    // Another capture's level never draws here.
    await emit("dictation-level", { owner: "dictation", rms: -20, peak: -6, ms: 100 });
    expect(strip.get()?.levels).toHaveLength(1);
    await wait(320);
    await act(async () => talk.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    await wait(400);
    expect(strip.get()).toBeNull();
    expect(sends().map((s) => s.text)).toEqual(["is the replay safe"]);
  });

  it("has one primary button, never disabled: send, queue while a reply runs, stop on an empty box", async () => {
    await mount();
    const el = primary();
    expect(el.getAttribute("aria-label")).toBe("Send");
    // Nothing to send is aria-disabled, so the button keeps its focus.
    expect(el.getAttribute("aria-disabled")).toBe("true");
    expect(el.hasAttribute("disabled")).toBe(false);
    await type("And the risks?");
    expect(el.getAttribute("aria-disabled")).toBeNull();
    await type("");
    await summarize();
    expect(el.getAttribute("aria-label")).toBe("Stop");
    await type("Add that as feedback");
    // The same button in the same slot, its face changed.
    expect(primary()).toBe(el);
    expect(el.getAttribute("aria-label")).toBe("Queue");
    await act(async () => el.click());
    expect(host.querySelector("[aria-label='Queued messages']")?.textContent).toContain("Add that as feedback");
    expect(el.getAttribute("aria-label")).toBe("Stop");
    expect(sends()).toHaveLength(1);
  });

  it("never takes down a strip that is not its own", async () => {
    await mount();
    const other = { owner: "dictation", phase: "listening" as const, text: "into a comment", levels: [], anchor: null, hint: "" };
    strip.set(other);
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(strip.get()).toBe(other);
    strip.set(null);
  });
});

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
    await emit("dictation-partial", { owner: "voice", text: "what does section two do" });
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
    await emit("dictation-partial", { owner: "voice", text: "actually focus on rollout" });
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
    // On the reply's tail, where it adds no line under the text.
    expect(host.querySelector("[data-reply='settled'] [data-reply-tail]")?.textContent).toBe("(interrupted)");
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
      { owner: "voice", kind: "hold", preroll: true },
      { owner: "voice", kind: "hold", preroll: false },
      { owner: "voice", kind: "hold", preroll: true },
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
  it("says what the agent is doing on its reply's one status line, that it is still going, and leaves Stop to the composer", async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(<VoicePanel sessionId={SID} markdown={"# Plan"} sections={SECTIONS} onClose={() => {}} />);
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      button("Summarize").click();
      await vi.advanceTimersByTimeAsync(10);
    });
    const live = () => host.querySelector("[data-reply='live']")!;
    const status = () => live().querySelector("[data-reply-tail] [role=status]")?.textContent ?? "";
    // The reply's skeleton is there from the send: its byline where its words
    // will start, and the one working line in the whole panel under it — no
    // caption over it, no status sentence and no indicator below.
    expect(live().querySelector(".rl-reply-byline")?.textContent).toBe("Claude");
    expect(status()).toBe("Thinking…");
    expect(panel().querySelectorAll("[role=status]")).toHaveLength(1);
    expect(panel().textContent!.match(/Thinking|Answering|Speaking|Ready|●/g)).toEqual(["Thinking"]);
    await emit("voice-meter", { ...of(1), rev: 3, meter: {}, activity: { at: Date.now(), kind: "tool", label: "Bash…" } });
    expect(status()).toBe("Reading the plan…");
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(status()).toBe("Still reading the plan…");
    // Long after, still no Stop of its own: the composer's one button is it.
    await act(async () => { await vi.advanceTimersByTimeAsync(33_000); });
    expect(live().querySelector("button")).toBeNull();
    const stop = button("Stop");
    expect(stop.dataset.send).toBe("stop");
    expect(stop.hasAttribute("disabled")).toBe(false);
    calls.length = 0;
    await act(async () => stop.click());
    expect(names()).toContain("voice_interrupt");
    expect(status()).toBe("Stopping…");
  });

  it("keeps a rate limit's own words on the status line for as long as it waits", async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(<VoicePanel sessionId={SID} markdown={"# Plan"} sections={SECTIONS} onClose={() => {}} />);
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      button("Summarize").click();
      await vi.advanceTimersByTimeAsync(10);
    });
    const status = () => host.querySelector("[data-reply='live'] [data-reply-tail] [role=status]")?.textContent ?? "";
    await emit("voice-meter", { ...of(1), rev: 2, meter: {}, activity: { at: Date.now(), kind: "rateLimit", label: "Rate limited (five_hour) · waiting" } });
    // A known wait is not silence: never "still waiting for the agent".
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(status()).toBe("Rate limited (five_hour) · waiting");
  });
});

// --- one reply anatomy ------------------------------------------------------------

describe("one reply anatomy", () => {
  const REPLY = "The risk is a double apply. ⟦§A.1⟧ Gate it on the turn id.\n⟦screen⟧\n- remount replays\n- gate on the turn";
  /** Each slot of a reply: its tag, classes and data attributes, in order. */
  const skeleton = (reply: Element) =>
    [...reply.children].map((el) =>
      [el.tagName.toLowerCase(), el.getAttribute("class") ?? "", ...[...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => a.name).sort()].join(" "),
    );

  it("streams a reply into the skeleton it settles into, its chips and detail under the text", async () => {
    await mount();
    await summarize();
    await emit("voice-delta", { ...of(1), text: REPLY });
    const live = host.querySelector("[data-reply='live']")!;
    const streamed = {
      skeleton: skeleton(live),
      text: live.querySelector(".rl-reply-text")!.innerHTML,
      detail: live.querySelector("[data-voice-screen]")!.textContent,
    };
    // The spoken part is the text; the sections it named and the detail sit
    // under it, and the tail row closes it.
    expect(live.querySelector(".rl-reply-text")!.textContent!.trim()).toMatch(/^The risk is a double apply\.\s+Gate it on the turn id\.$/);
    expect(streamed.skeleton.map((slot) => slot.split(" ")[1])).toEqual(["rl-reply-head", "rl-reply-text", "flex", "", "rl-reply-tail"]);
    await emit("voice-done", { ...of(1), body: REPLY, messageId: "m1" });
    expect(host.querySelector("[data-reply='live']")).toBeNull();
    const settled = [...host.querySelectorAll("[data-reply]")].pop()!;
    expect(settled.getAttribute("data-reply")).toBe("settled");
    expect(skeleton(settled)).toEqual(streamed.skeleton);
    expect(settled.querySelector(".rl-reply-text")!.innerHTML).toBe(streamed.text);
    expect(settled.querySelector("[data-voice-screen]")!.textContent).toBe(streamed.detail);
    expect(settled.querySelector(".rl-reply-byline")!.textContent).toBe("Claude");
    expect(button("§ Rollout")).toBeTruthy();
    // Settled, nothing says the agent is working.
    expect(panel().querySelectorAll("[role=status]")).toHaveLength(0);
    // The user's side is a compact card with no "You" on it.
    expect(host.querySelector("[data-user-turn]")!.textContent!.trim()).toBe("▶ Summarize the plan");
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

// --- reading the plan aloud, then Stop ---------------------------------------------

describe("reading the plan aloud", () => {
  const PLAN = "# Plan\n\nFirst point of the plan. Second point of the plan.\n\n## Rollout\n\nRoll it out in waves. Then widen the flag.";
  const planSaid = /point of the plan|Roll it out|widen the flag/;

  /** A Web Audio context whose clips each play for 200 ms, logging what is
   *  heard: the sentence each was synthesized from. */
  function fakeAudioContext(heard: string[]) {
    return class {
      state = "running";
      destination = {};
      createBufferSource() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const source = {
          buffer: null as { tag: string } | null,
          playbackRate: { value: 1 },
          onended: null as (() => void) | null,
          connect() {},
          start() {
            heard.push(source.buffer!.tag);
            timer = setTimeout(() => source.onended?.(), 200);
          },
          stop() {
            clearTimeout(timer);
            setTimeout(() => source.onended?.(), 0);
          },
        };
        return source;
      }
      async decodeAudioData(bytes: ArrayBuffer) {
        const tag = new TextDecoder().decode(new Uint8Array(bytes));
        const data = new Float32Array(tag.length * 10).fill(0.5);
        return { tag, sampleRate: 1000, getChannelData: () => data };
      }
      async suspend() {
        this.state = "suspended";
      }
      async resume() {
        this.state = "running";
      }
    };
  }

  it("is stopped by the composer's button with nothing left to say, and the next Summarize is heard first", async () => {
    await mount(PLAN);
    await act(async () => button("▸ Read it to me").click());
    await wait();
    expect(spoken()).toMatch(planSaid);
    // While it reads, the one button is Stop.
    expect(primary().dataset.send).toBe("stop");
    expect(button("Pause speech")).toBeTruthy();
    calls.length = 0;
    await act(async () => primary().click());
    // Stopped in the voice, with nothing of it left queued…
    expect(synthCalls).toContain("cancel");
    expect(utterances).toEqual([]);
    // …and idle: the button sends again, and the reading can be replayed.
    expect(primary().getAttribute("aria-label")).toBe("Send");
    expect(button("Pause speech")).toBeUndefined();
    expect(button("▶ Replay").disabled).toBe(false);
    // No turn ran, so none was interrupted.
    expect(names()).not.toContain("voice_interrupt");
    await wait(300);
    expect(utterances).toEqual([]);
    await summarize();
    await emit("voice-delta", { ...of(1), text: "Here is the short version. It ships in two waves." });
    expect(utterances[0]?.text).toBe("Here is the short version.");
    expect(spoken()).not.toMatch(planSaid);
  });

  it("on Kokoro, drops the reading's backlog in the engine, and the next Summarize is the next clip heard", async () => {
    script.engine = "kokoro";
    const heard: string[] = [];
    vi.stubGlobal("AudioContext", fakeAudioContext(heard));
    await mount(PLAN);
    await act(async () => button("▸ Read it to me").click());
    await until(() => heard.length > 0);
    const reading = (named("tts_synth")[0][1] as { generation: number }).generation;
    // A sentence or two ahead of the one heard, never the whole plan queued.
    expect(named("tts_synth").length).toBeLessThanOrEqual(3);
    expect(primary().dataset.send).toBe("stop");
    await act(async () => primary().click());
    expect(named("tts_cancel").map(([, a]) => a)).toEqual([{ generation: reading }]);
    expect(primary().getAttribute("aria-label")).toBe("Send");
    const asked = named("tts_synth").length;
    const before = heard.length;
    await wait(400);
    expect(named("tts_synth")).toHaveLength(asked);
    expect(heard).toHaveLength(before);
    await summarize();
    await emit("voice-delta", { ...of(1), text: "Here is the short version. It ships in two waves." });
    await until(() => heard.length > before);
    expect(heard[before]).toBe("Here is the short version.");
    const after = named("tts_synth").slice(asked).map(([, a]) => String(a?.text));
    expect(after.filter((text) => planSaid.test(text))).toEqual([]);
  });
});

// --- the hold-to-dictate key over a reply --------------------------------------------

describe("the hold-to-dictate key over a reply", () => {
  /** A key on what has focus, as the window hears it. */
  function key(type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}) {
    const ev = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init });
    act(() => {
      (document.activeElement ?? document.body).dispatchEvent(ev);
    });
    return ev;
  }

  async function replying() {
    installDictation(() => null);
    await mount();
    await summarize();
    await emit("voice-delta", { ...of(1), text: "First, the ownership globs are guesses. Second, check" });
    expect(spoken()).toBe("First, the ownership globs are guesses.");
    input().focus();
    calls.length = 0;
    synthCalls.length = 0;
  }

  it("lets a slow AltGr keystroke in the box type its character, the reply playing on", async () => {
    await replying();
    key("keydown", "AltRight", { key: "Alt", altKey: true });
    await wait(300);
    // Held past its threshold: the panel listens, and the reply is paused,
    // not stopped — what streams in meanwhile waits.
    expect(names()).toContain("dictation_start");
    expect(synthCalls).toEqual(["pause"]);
    await emit("voice-delta", { ...of(1), text: " attribution is missing. Third, the end" });
    expect(spoken()).toBe("First, the ownership globs are guesses.");
    // The character: it goes on to the box, which keeps the caret…
    const typed = key("keydown", "KeyQ", { key: "œ", altKey: true });
    key("keyup", "KeyQ", { key: "œ", altKey: true });
    key("keyup", "AltRight", { key: "Alt" });
    await wait(50);
    expect(typed.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input());
    // …and the reply plays on from where it paused, saying what came in.
    expect(names()).toContain("dictation_kill_all");
    expect(names()).not.toContain("voice_interrupt");
    expect(synthCalls).toEqual(["pause", "resume"]);
    expect(spoken()).toBe("First, the ownership globs are guesses. Second, check attribution is missing.");
    await emit("voice-done", { ...of(1), body: "First, the ownership globs are guesses. Second, check attribution is missing. Third, the end.", messageId: "m1" });
    expect(spoken()).toContain("Third, the end.");
    expect(host.textContent).not.toContain("(interrupted)");
    expect(sends()).toEqual([]);
  });

  it("stops the reply in place once its capture hears a word, and sends what was said", async () => {
    await replying();
    key("keydown", "AltRight", { key: "Alt", altKey: true });
    await wait(300);
    expect(names()).not.toContain("voice_interrupt");
    await emit("dictation-partial", { owner: "voice", text: "wait which" });
    expect(names()).toContain("voice_interrupt");
    expect(utterances).toEqual([]);
    script.dictated = "Wait, which globs?";
    await wait(150);
    key("keyup", "AltRight", { key: "Alt" });
    await wait(450);
    await emit("voice-interrupted", { ...of(1), text: "First, the ownership globs are guesses.", streamedChars: 40, messageId: "m1", killed: false });
    await wait();
    expect(sends().map((x) => x.text)).toEqual(["Wait, which globs?"]);
    expect(sends()[0].context).toContain('You were interrupted after saying: "First, the ownership globs are guesses."');
  });

  it("…or once its release brings words the live transcript missed", async () => {
    await replying();
    key("keydown", "AltRight", { key: "Alt", altKey: true });
    await wait(450);
    script.dictated = "Focus on the rollout first.";
    key("keyup", "AltRight", { key: "Alt" });
    await wait(450);
    expect(names()).toContain("voice_interrupt");
    await emit("voice-interrupted", { ...of(1), text: "First, the ownership globs are guesses.", streamedChars: 40, messageId: "m1", killed: false });
    await wait();
    expect(sends().map((x) => x.text)).toEqual(["Focus on the rollout first."]);
  });

  it("tells the agent how much was heard of a reply that ended while the key held it", async () => {
    installDictation(() => null);
    await mount();
    await summarize();
    await emit("voice-delta", { ...of(1), text: "First, the ownership globs are guesses. " });
    expect(spoken()).toBe("First, the ownership globs are guesses.");
    await finishSpeech();
    input().focus();
    calls.length = 0;
    key("keydown", "AltRight", { key: "Alt", altKey: true });
    await wait(300);
    // The rest of it lands, and the turn ends, while the key holds it.
    await emit("voice-delta", { ...of(1), text: "Second, check attribution is missing." });
    await emit("voice-done", { ...of(1), body: "First, the ownership globs are guesses. Second, check attribution is missing.", messageId: "m1" });
    expect(utterances).toEqual([]);
    await emit("dictation-partial", { owner: "voice", text: "hold on" });
    script.dictated = "Hold on, which globs?";
    key("keyup", "AltRight", { key: "Alt" });
    await wait(450);
    // Nothing of the rest is said, and the agent hears where the user got to.
    expect(utterances).toEqual([]);
    expect(sends().map((x) => x.text)).toEqual(["Hold on, which globs?"]);
    expect(sends()[0].context).toContain('You were interrupted after saying: "First, the ownership globs are guesses."');
  });

  it("…or that none of it was, when the agent was still thinking as the key went down", async () => {
    installDictation(() => null);
    await mount();
    await summarize();
    input().focus();
    calls.length = 0;
    key("keydown", "AltRight", { key: "Alt", altKey: true });
    await wait(300);
    await emit("voice-delta", { ...of(1), text: "It ships in two waves." });
    await emit("voice-done", { ...of(1), body: "It ships in two waves.", messageId: "m1" });
    await emit("dictation-partial", { owner: "voice", text: "why" });
    script.dictated = "Why two waves?";
    key("keyup", "AltRight", { key: "Alt" });
    await wait(450);
    expect(utterances).toEqual([]);
    expect(sends().map((x) => x.text)).toEqual(["Why two waves?"]);
    expect(sends()[0].context).toContain("You were interrupted before they heard any of your reply");
  });

  it("sends what was typed meanwhile once the talk that held the reply turns out to be nothing", async () => {
    await replying();
    await type("And the rollout?");
    await submit();
    key("keydown", "AltRight", { key: "Alt", altKey: true });
    await wait(300);
    await emit("voice-done", { ...of(1), body: "First, the ownership globs are guesses. Second, check it.", messageId: "m1" });
    // The turn is over, but what was typed waits on what the talk says.
    expect(sends()).toEqual([]);
    // A sound the live transcript took for a word, then nothing at the end.
    await emit("dictation-partial", { owner: "voice", text: "hm" });
    script.dictated = "";
    key("keyup", "AltRight", { key: "Alt" });
    await wait(450);
    expect(sends().map((x) => x.text)).toEqual(["And the rollout?"]);
  });

  it("says nothing from a panel that closed while the key held its reply", async () => {
    await replying();
    key("keydown", "AltRight", { key: "Alt", altKey: true });
    await wait(300);
    await emit("voice-delta", { ...of(1), text: " attribution is missing. Third" });
    // The dock switches context mid-hold: the panel goes, the key comes up.
    await act(async () => root.render(<></>));
    key("keyup", "AltRight", { key: "Alt" });
    await wait(450);
    expect(utterances).toEqual([]);
    expect(sends()).toEqual([]);
  });

  it("…nor sends what was typed there when the key's character cancels the talk after", async () => {
    await replying();
    await type("And the rollout?");
    await submit();
    key("keydown", "AltRight", { key: "Alt", altKey: true });
    await wait(300);
    await emit("voice-done", { ...of(1), body: "First, the ownership globs are guesses. Second, check it.", messageId: "m1" });
    await act(async () => root.render(<></>));
    key("keydown", "KeyQ", { key: "œ", altKey: true });
    key("keyup", "KeyQ", { key: "œ", altKey: true });
    key("keyup", "AltRight", { key: "Alt" });
    await wait(50);
    expect(sends()).toEqual([]);
    expect(utterances).toEqual([]);
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
    await emit("dictation-error", { owner: "voice", error: "No speech detected", domain: "kAFAssistantErrorDomain", code: 1110 });
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
    await emit("dictation-error", { owner: "voice", error: "Speech service crashed", domain: "kAFAssistantErrorDomain", code: 1101 });
    expect(host.textContent).toContain("Speech service crashed");
    await act(async () => talk.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    await wait(400);
    await holdToTalk("Focus on rollout.");
    expect(script.armed).toBe(2);
    expect(sends().map((s) => s.text)).toEqual(["Focus on rollout."]);
  });

  it("waits out a dictation that took the mic, its strip untouched, then listens again", async () => {
    await mount();
    await act(async () => button("🎧 Hands-free: off").click());
    await wait(350);
    expect(script.armed).toBe(1);
    // The hold key, with the caret in a comment box: the dictation takes the
    // mic and shows its own strip.
    script.taken = "dictation";
    await emit("dictation-preempted", { owner: "voice", by: "dictation", text: "" });
    const dictating = { owner: "dictation", phase: "listening" as const, text: "into the comment", levels: [], anchor: null, hint: "" };
    act(() => strip.set(dictating));
    const opens = () => named("dictation_start").filter(([, a]) => a?.kind === "open").length;
    // A frame at a time, as the app renders: no re-arm flashing "listening"
    // at it meanwhile, nor over its strip.
    for (let ms = 0; ms < 2600; ms += 50) {
      await wait(50);
      expect(strip.get()).toBe(dictating);
      expect(button("Hands-free status").getAttribute("aria-pressed")).toBe("false");
    }
    expect(opens()).toBe(1);
    // It lets go: hands-free listens again.
    script.taken = null;
    act(() => strip.set(null));
    await act(async () => void (await broker.stop("dictation")));
    await wait(1100);
    expect(opens()).toBe(2);
    expect(script.armed).toBe(2);
  });

  it("ends the turn on real silence, keeps the mic on the same capture, and closes it while the reply plays on speakers", async () => {
    await mount();
    await handsFreeOn();
    expect(script.armed).toBe(1);
    // The words stop growing well before the voice does: still talking.
    await speak("is the replay safe", 400);
    await levels(-26, 1600);
    expect(sends()).toEqual([]);
    await emit("dictation-partial", { owner: "voice", text: "Is the replay safe?" });
    // Then real silence: 700 ms of the room ends the turn.
    await room(650);
    expect(sends()).toEqual([]);
    await room(50);
    expect(sends().map((s) => s.text)).toEqual(["Is the replay safe?"]);
    expect(names()).toContain("dictation_cycle");
    expect(names()).not.toContain("dictation_stop");
    expect(names()).toContain("dictation_status");
    expect(script.micOpen).toBe(true);
    await emit("voice-delta", { ...of(1), text: "Mostly." });
    await emit("voice-done", { ...of(1), body: "Mostly.", messageId: "m1" });
    await wait(400);
    // Its voice sounds through the speakers: the mic closes, so it never hears it.
    expect(named("dictation_kill_all").map(([, a]) => a)).toEqual([{ owner: "voice" }]);
    expect(script.micOpen).toBe(false);
    await finishSpeech();
    await wait(400);
    expect(named("dictation_start")).toHaveLength(2);
    expect(script.armed).toBe(2);
    // Re-armed just after the agent's voice: the pre-roll would hold its end.
    expect(named("dictation_start").map(([, a]) => a)).toEqual([
      { owner: "voice", kind: "open", preroll: true },
      { owner: "voice", kind: "open", preroll: false },
    ]);
  });

  it("sends the recognizer's final transcript, which has the last word the partials lagged on", async () => {
    await mount();
    await handsFreeOn();
    script.final = "Summarize the rollout plan.";
    await speak("summarize the rollout");
    await room(700);
    expect(sends().map((s) => s.text)).toEqual(["Summarize the rollout plan."]);
  });

  it("carries a turn on when they speak again before the reply is heard", async () => {
    await mount();
    await handsFreeOn();
    await speak("rename the panel");
    await room(700);
    expect(sends().map((s) => s.text)).toEqual(["rename the panel"]);
    // They weren't done: the reply is stopped before a word of it is heard…
    await room(600);
    await levels(-26, 200);
    expect(names()).toContain("voice_interrupt");
    await emit("voice-interrupted", { ...of(1), text: "", streamedChars: 0, messageId: null, killed: false });
    await speak("to TalkPanel", 600);
    await room(700);
    // …and the whole of it goes out as one turn, shown as the rest of the last.
    expect(sends().map((s) => s.text)).toEqual(["rename the panel", "rename the panel to TalkPanel"]);
    expect(named("voice_send")[1][1]).toMatchObject({ label: "to TalkPanel" });
    expect(sends()[1].context).toContain('carries on from their last one ("rename the panel")');
    expect(host.textContent).not.toContain("(interrupted)");
    expect(host.textContent).not.toContain("You were interrupted");
  });

  it("carries on a turn taken back before it went out as one line, the whole of it", async () => {
    await mount();
    await handsFreeOn();
    let release!: () => void;
    script.cycleWait = new Promise<void>((r) => (release = r));
    script.final = "Rename the panel";
    await speak("rename the panel");
    await room(700);
    // They speak again while the recognizer is still writing the first part.
    await levels(-26, 200);
    script.cycleWait = null;
    await act(async () => release());
    await wait();
    expect(sends()).toEqual([]);
    script.final = "to TalkPanel.";
    await speak("to TalkPanel", 600);
    await room(700);
    expect(sends().map((s) => s.text)).toEqual(["Rename the panel to TalkPanel."]);
    // Nothing of it was on screen, nor reached the agent: no line is lost, and
    // there is no earlier message to carry on from.
    expect(named("voice_send")[0][1]).toMatchObject({ label: null });
    expect(sends()[0].context ?? "").not.toContain("carries on");
    expect(names()).not.toContain("voice_interrupt");
  });

  it("carries on a turn still waiting behind a typed reply without stopping that reply", async () => {
    await mount();
    await handsFreeOn();
    // They start talking, and a typed message goes out meanwhile.
    await levels(-26, 300);
    await type("Check the tests too");
    await submit();
    expect(sends().map((s) => s.text)).toEqual(["Check the tests too"]);
    await speak("rename the panel", 700);
    await room(700);
    // Their turn waits for the typed one's reply; they carry on before it goes.
    await levels(-26, 200);
    expect(names()).not.toContain("voice_interrupt");
    await speak("to TalkPanel", 600);
    await room(700);
    expect(sends()).toHaveLength(1);
    await emit("voice-done", { ...of(1), body: "", messageId: "m1" });
    await wait();
    expect(sends().map((s) => s.text)).toEqual(["Check the tests too", "rename the panel to TalkPanel"]);
    expect(named("voice_send")[1][1]).toMatchObject({ label: null });
    expect(sends()[1].context ?? "").not.toContain("carries on");
  });

  it("closes the mic on speakers when read-aloud starts while it listens, and opens it again after", async () => {
    await mount();
    await handsFreeOn();
    expect(script.micOpen).toBe(true);
    await act(async () => button("▸ Read it to me").click());
    await wait();
    expect(utterances).not.toHaveLength(0);
    // From the reading's first sound the mic is closed: it never hears it.
    expect(script.micOpen).toBe(false);
    await levels(-26, 2000);
    await emit("dictation-partial", { owner: "voice", text: "Plan. Body." });
    await room(1000);
    expect(sends()).toEqual([]);
    await finishSpeech();
    await wait(400);
    expect(script.micOpen).toBe(true);
  });

  it("on wired headphones keeps listening through the reply, where two words interrupt it", async () => {
    script.route = { kind: "headphones", transport: "builtin" };
    await mount();
    await handsFreeOn();
    await speak("summarize the rollout");
    await room(700);
    await emit("voice-delta", { ...of(1), text: "Rollout goes in two waves. Then the flag flips." });
    await wait();
    expect(utterances).not.toHaveLength(0);
    expect(named("dictation_kill_all")).toEqual([]);
    expect(names()).not.toContain("voice_interrupt");
    // A "yeah" under the reply is let go.
    await speak("yeah", 300);
    await room(700);
    expect(names()).not.toContain("voice_interrupt");
    await speak("wait which flag", 800);
    expect(names()).toContain("voice_interrupt");
    expect(utterances).toHaveLength(0);
    await room(700);
    await emit("voice-interrupted", { ...of(1), text: "Rollout goes in two waves.", streamedChars: 26, messageId: "m1", killed: false });
    await wait();
    expect(sends().map((s) => s.text)).toEqual(["summarize the rollout", "wait which flag"]);
  });

  it("on a Bluetooth headset closes the mic as soon as the turn is over", async () => {
    script.route = { kind: "headphones", transport: "bluetooth" };
    await mount();
    await handsFreeOn();
    await speak("summarize the rollout");
    await room(700);
    expect(sends().map((s) => s.text)).toEqual(["summarize the rollout"]);
    expect(named("dictation_kill_all").map(([, a]) => a)).toEqual([{ owner: "voice" }]);
  });

  it("asks the end-of-turn model when it is downloaded, and holds a pause it calls unfinished", async () => {
    script.turnModel = true;
    script.turnScore = 0.1;
    await mount();
    await handsFreeOn();
    expect(named("turn_scorer").map(([, a]) => a)).toContainEqual({ op: "warm" });
    await speak("rename the panel");
    await room(1000);
    expect(sends()).toEqual([]);
    expect(named("turn_scorer").filter(([, a]) => (a as { op: string }).op === "score").length).toBeGreaterThan(1);
    // Unsure to the end: the pause is cut at 2.5 s.
    await room(1500);
    expect(sends().map((s) => s.text)).toEqual(["rename the panel"]);
    // Turning hands-free off stops the model.
    await act(async () => button("🎧 Hands-free: on").click());
    expect(named("turn_scorer").map(([, a]) => a)).toContainEqual({ op: "stop" });
  });
});

// --- the studio voice -------------------------------------------------------------

describe("the studio voice", () => {
  const live = () => studio.drivers[studio.drivers.length - 1];

  it("speaks through its own driver, warming the model as the panel opens", async () => {
    script.engine = "studio";
    await mount();
    await wait();
    expect(studio.drivers).toHaveLength(1);
    expect(live().opts.style).toBe("calm");
    expect(studio.warmed).toBe(1);
    expect(studio.surfaces).toEqual([[`voice:${SID}`, true]]);
    await summarize();
    await emit("voice-delta", { ...of(1), text: "⟦tone: upbeat⟧ The plan has three parts. Let me check." });
    expect(live().spoken.map((x) => [x.text, x.tone])).toEqual([["The plan has three parts.", "upbeat"]]);
    expect(utterances).toEqual([]); // not the system voice
    await act(async () => root.unmount());
    root = createRoot(host);
    await wait();
    expect(studio.surfaces).toEqual([
      [`voice:${SID}`, true],
      [`voice:${SID}`, false],
    ]);
  });

  it("says quietly why its stand-in is reading, and stops saying it when it speaks again", async () => {
    script.engine = "studio";
    await mount();
    await wait();
    const typing = input();
    typing.focus();
    const onFallback = live().opts.onFallback as (n: string | null) => void;
    await act(async () => onFallback("Studio voice warming · Kokoro reading"));
    const chip = host.querySelector("[data-studio-chip]")!;
    expect(chip.textContent).toBe("Studio voice warming · Kokoro reading");
    expect(chip.getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe(typing);
    await act(async () => onFallback(null));
    expect(host.querySelector("[data-studio-chip]")).toBeNull();
  });

  it("tells the agent exactly how far the listener got", async () => {
    script.engine = "studio";
    await mount();
    await wait();
    await summarize();
    await emit("voice-delta", { ...of(1), text: "First, the ownership globs are guesses. Second, check attribution." });
    live().heard = "First, the ownership";
    await holdToTalk("Add them as feedback.");
    await emit("voice-interrupted", { ...of(1), text: "First, the ownership globs are guesses.", streamedChars: 40, messageId: "m1", killed: false });
    await wait();
    expect(sends()[1].context).toContain('You were interrupted after saying: "First, the ownership"');
  });

  it("keeps the speed slider off: it can't change speed without changing pitch", async () => {
    script.engine = "studio";
    await mount();
    await wait();
    await act(async () => button("Voice settings").click());
    await wait();
    const slider = host.querySelector("input[aria-label='Speech speed']") as HTMLInputElement;
    expect(slider.disabled).toBe(true);
    expect(host.textContent).toContain("pick Slow or Brisk as its style");
  });
});
