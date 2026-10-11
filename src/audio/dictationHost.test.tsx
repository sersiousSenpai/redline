// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appInvoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: appInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { strip } from "../components/DictationStrip";
import { useDictationComposer, type ComposerSpec } from "../lib/dictationComposer";
import { DictationBroker } from "./dictationBroker";
import { BACKGROUND_WARM_MS, DICTATION_OWNER, DictationHost, type TalkContext, type TurnTaker } from "./dictationHost";
import { getVoiceAway, setVoiceAway } from "./voiceAway";
import { voiceCaption } from "./voiceCaption";
import { APP_KEYS, HOLD_MS, type HotkeyEvent } from "./voiceHotkey";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Handler = (e: { payload: never }) => void;

/** dictation.rs, as far as the host can tell: one holder, events by owner,
 *  and what the user "said" as each stop's transcript. */
function nativeMic() {
  const handlers = new Map<string, Handler[]>();
  const calls: [string, Record<string, unknown> | undefined][] = [];
  let holder: string | null = null;
  let said = "";
  const emit = (event: string, payload: unknown) => {
    for (const fn of handlers.get(event) ?? []) fn({ payload } as never);
  };
  const bridge = {
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<never> => {
      calls.push([cmd, args]);
      const owner = args?.owner as string;
      if (cmd === "dictation_start") {
        const preempted = holder && holder !== owner ? holder : undefined;
        holder = owner;
        if (preempted) emit("dictation-preempted", { owner: preempted, by: owner, text: said });
        return { granted: true, holder: owner, preempted } as never;
      }
      if (cmd === "dictation_stop") {
        if (holder !== owner) return "" as never;
        holder = null;
        return said as never;
      }
      if (cmd === "dictation_kill_all" && holder === owner) holder = null;
      return null as never;
    }),
    listen: vi.fn(async (event: string, fn: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return () => {};
    }),
  };
  return {
    bridge,
    calls,
    holder: () => holder,
    /** Speak: the live partial now, and the transcript a stop returns. */
    say(text: string, opts: { heard?: boolean } = {}) {
      said = text;
      if (opts.heard ?? true) emit("dictation-partial", { owner: holder, text });
    },
    emit,
  };
}

let mic: ReturnType<typeof nativeMic>;
let host: DictationHost;
let polish: { polish: ReturnType<typeof vi.fn>; warm: ReturnType<typeof vi.fn> };
/** The background reply (awayReply.ts), as the host drives it. */
let away: Record<"expect" | "sent" | "drop" | "hush" | "release", ReturnType<typeof vi.fn>>;
let talk: TalkContext | null;
let taker: TurnTaker | null;
let root: Root;
let mount: HTMLDivElement;
let now: number;

beforeEach(() => {
  appInvoke.mockReset();
  appInvoke.mockImplementation(async () => null);
  localStorage.clear();
  polish = { polish: vi.fn(async () => ""), warm: vi.fn() };
  away = { expect: vi.fn(async () => {}), sent: vi.fn(), drop: vi.fn(), hush: vi.fn(), release: vi.fn() };
  mic = nativeMic();
  talk = null;
  taker = null;
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  host = new DictationHost({
    broker: new DictationBroker(mic.bridge),
    doc: document,
    conversation: () => talk,
    taker: () => taker,
    invoke: appInvoke as never,
    polish: polish as never,
    away: async () => away as never,
  });
  mount = document.createElement("div");
  document.body.appendChild(mount);
  root = createRoot(mount);
  strip.set(null);
  setVoiceAway(null);
  voiceCaption.set(null);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** What the host asked of the app, past loading the user's words, the
 *  memory index's names and the project's. */
const voiceCalls = () =>
  appInvoke.mock.calls.filter(([cmd]) => cmd !== "get_ui_prefs" && cmd !== "classmem_tree" && cmd !== "dictation_identifiers");

/** The key, as the window would hear it. */
function press(e: HotkeyEvent): boolean {
  let swallowed = false;
  act(() => void (swallowed = host.hotkey.dispatch(e)));
  return swallowed;
}

const settle = () => act(async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
});

/** Hold the key `ms`, saying `text` meanwhile, and let go. */
async function hold(text: string, opts: { ms?: number; heard?: boolean } = {}) {
  press({ type: "down", at: now, source: APP_KEYS, solo: true });
  press({ type: "elapsed", at: now + HOLD_MS });
  await settle();
  mic.say(text, opts);
  now += opts.ms ?? 1500;
  press({ type: "up", at: now });
  await settle();
}

const CHAT: ComposerSpec = { send: true, polish: true };

function Composer({ onSend, spec = CHAT }: { onSend?: (text: string) => void; spec?: ComposerSpec }) {
  const frame = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  useDictationComposer(frame, spec);
  return (
    <div ref={frame}>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSend?.(draft);
        }}
      />
      <output>{draft}</output>
    </div>
  );
}

async function composer(onSend?: (text: string) => void, spec?: ComposerSpec) {
  await act(async () => root.render(<Composer onSend={onSend} spec={spec} />));
  const ta = mount.querySelector("textarea")!;
  ta.focus();
  return { ta, shown: () => mount.querySelector("output")!.textContent };
}

describe("dictating into a composer", () => {
  it("captures as the dictation owner, shows the words on the strip, and writes them cleaned up on release", async () => {
    const { ta, shown } = await composer();
    press({ type: "down", at: now, source: APP_KEYS, solo: true });
    press({ type: "elapsed", at: now + HOLD_MS });
    await settle();
    expect(mic.calls[0]).toEqual(["dictation_start", { owner: DICTATION_OWNER, kind: "hold", vocab: [], preroll: true }]);
    expect(strip.get()).toMatchObject({ phase: "listening", hint: "release to insert", anchor: ta.parentElement });
    mic.say("um the kokoro sidecar in tts dot rs");
    expect(strip.get()?.text).toBe("um the kokoro sidecar in tts dot rs");
    // Nothing is written while the key is held.
    expect(ta.value).toBe("");
    now += 2000;
    press({ type: "up", at: now });
    await settle();
    expect(shown()).toBe("The kokoro sidecar in tts.rs");
    expect(strip.get()).toBeNull();
    expect(host.busy()).toBe(false);
    expect(host.hotkey.state.phase).toBe("idle");
    expect(document.activeElement).toBe(ta);
  });

  it("spells the open plan's vocabulary its way", async () => {
    talk = { key: "plan-1", markdown: () => "Keep Kokoro warm in the Front Door.", cwd: null };
    const { shown } = await composer();
    await hold("the front door keeps kokoro warm");
    expect(mic.calls[0][1]?.vocab).toEqual(["Kokoro", "Front Door"]);
    expect(shown()).toBe("The Front Door keeps Kokoro warm");
  });

  it("keeps a paragraph break the recognizer wrote itself", async () => {
    const { shown } = await composer();
    await hold("The first phase ships the door.");
    await hold("\n\nThe second phase adds the studio voice");
    expect(shown()).toBe("The first phase ships the door.\n\nThe second phase adds the studio voice");
  });

  it("writes nothing for a tap's worth of nothing", async () => {
    const { shown } = await composer();
    await hold("you", { heard: false });
    expect(shown()).toBe("");
    expect(strip.get()).toMatchObject({ phase: "notice", text: "Didn't catch that" });
  });

  it("takes back the last phrase on \"scratch that\", and sends on \"send it\"", async () => {
    const onSend = vi.fn();
    const { shown } = await composer(onSend);
    await hold("Make it three hundred milliseconds.");
    expect(shown()).toBe("Make it 300 milliseconds.");
    await hold("Scratch that, make it seven hundred milliseconds.");
    expect(shown()).toBe("Make it 700 milliseconds.");
    await hold("Send it.");
    expect(onSend).toHaveBeenCalledWith("Make it 700 milliseconds.");
  });

  it("offers the words for copying when the box can't take them", async () => {
    // An email box has no caret to write at: the browser refuses the write.
    const box = document.createElement("input");
    box.type = "email";
    document.body.appendChild(box);
    box.focus();
    await hold("yusuf at example dot com");
    expect(box.value).toBe("");
    expect(strip.get()).toMatchObject({ phase: "notice", copy: "yusuf at example.com" });
    expect(host.busy()).toBe(false);
    expect(host.hotkey.state.phase).toBe("idle");
  });

  it("cancels on Esc: the capture is dropped and nothing is written", async () => {
    const { shown } = await composer();
    press({ type: "down", at: now, source: APP_KEYS, solo: true });
    press({ type: "elapsed", at: now + HOLD_MS });
    await settle();
    mic.say("never mind all this");
    expect(press({ type: "escape", at: now + 900 })).toBe(true);
    await settle();
    expect(mic.calls[mic.calls.length - 1]).toEqual(["dictation_kill_all", { owner: DICTATION_OWNER }]);
    expect(shown()).toBe("");
    expect(strip.get()).toBeNull();
    expect(host.busy()).toBe(false);
  });

  it("drops a hold that a click shows was the key modifying it, but keeps words already said", async () => {
    const { shown } = await composer();
    // Option-click: nothing said, the capture goes quietly.
    press({ type: "down", at: now, source: APP_KEYS, solo: true });
    press({ type: "elapsed", at: now + HOLD_MS });
    await settle();
    press({ type: "press", at: now + 400 });
    await settle();
    expect(mic.calls[mic.calls.length - 1]).toEqual(["dictation_kill_all", { owner: DICTATION_OWNER }]);
    expect(strip.get()).toBeNull();
    press({ type: "up", at: now + 500 });
    // Speaking, then a click: what was said lands.
    now += 1000;
    press({ type: "down", at: now, source: APP_KEYS, solo: true });
    press({ type: "elapsed", at: now + HOLD_MS });
    await settle();
    mic.say("the tray moves up");
    now += 1200;
    press({ type: "press", at: now });
    await settle();
    expect(shown()).toBe("The tray moves up");
    press({ type: "up", at: now + 100 });
    expect(host.hotkey.state.phase).toBe("idle");
  });

  it("keeps the words heard when another gesture takes the mic", async () => {
    const { shown } = await composer();
    press({ type: "down", at: now, source: APP_KEYS, solo: true });
    press({ type: "elapsed", at: now + HOLD_MS });
    await settle();
    mic.say("half a thought about the tray");
    now += 1200;
    // The voice panel's talk button.
    await act(async () => void (await new DictationBroker(mic.bridge).start("voice", { kind: "hold" })));
    await settle();
    expect(shown()).toBe("Half a thought about the tray");
    expect(host.busy()).toBe(false);
  });

  it("locks open from a composer's mic button until it is pressed again", async () => {
    const { ta, shown } = await composer();
    act(() => host.toggleInto(ta));
    await settle();
    expect(strip.get()?.hint).toBe("tap again to insert · esc cancels");
    mic.say("a long thought, said slowly");
    now += 9000;
    act(() => host.toggleInto(ta));
    await settle();
    expect(shown()).toBe("A long thought, said slowly");
    // And the key's tap ends one too.
    act(() => host.toggleInto(ta));
    await settle();
    mic.say("second thought");
    press({ type: "down", at: now, source: APP_KEYS, solo: true });
    press({ type: "up", at: now + 80 });
    await settle();
    expect(shown()).toBe("A long thought, said slowly second thought");
  });
});

describe("standing down", () => {
  function Two() {
    return (
      <>
        <Composer />
        <Composer />
      </>
    );
  }

  it("lets the newest mic press win: the old capture's words land where they were going", async () => {
    await act(async () => root.render(<Two />));
    const [a, b] = [...mount.querySelectorAll("textarea")];
    act(() => host.toggleInto(a));
    await settle();
    mic.say("for the first box");
    act(() => host.toggleInto(b));
    await settle();
    expect(a.value).toBe("For the first box");
    // And the mic is open into the second one now.
    expect(mic.calls.filter(([cmd]) => cmd === "dictation_start")).toHaveLength(2);
    // (Compared by identity: a deep match would walk the whole DOM.)
    expect(strip.get()?.phase).toBe("listening");
    expect(strip.get()?.anchor).toBe(b.parentElement);
    mic.say("and the second");
    act(() => host.toggleInto(b));
    await settle();
    expect(b.value).toBe("And the second");
  });

  it("drops a mic press while the last capture is still being placed", async () => {
    await act(async () => root.render(<Two />));
    const [a, b] = [...mount.querySelectorAll("textarea")];
    act(() => host.toggleInto(a));
    await settle();
    mic.say("first");
    // The stop is on its way: the transcript has not come back yet.
    let answer!: (text: string) => void;
    mic.bridge.invoke.mockImplementationOnce(async () => new Promise<never>((r) => (answer = r as never)));
    act(() => host.toggleInto(a));
    act(() => host.toggleInto(b));
    await settle();
    expect(mic.calls.filter(([cmd]) => cmd === "dictation_start")).toHaveLength(1);
    await act(async () => answer("first"));
    await settle();
    expect(a.value).toBe("First");
    expect(host.busy()).toBe(false);
  });

  function Card({ open, keep }: { open: boolean; keep: ComposerSpec["keep"] }) {
    return open ? <Composer spec={{ polish: true, keep }} /> : null;
  }

  it("keeps the words of a composer that closes mid-capture where it keeps its draft", async () => {
    let draft = "Fix the tray.";
    const keep = vi.fn((add: (draft: string) => string) => void (draft = add(draft)));
    await act(async () => root.render(<Card open keep={keep} />));
    const ta = mount.querySelector("textarea")!;
    act(() => host.toggleInto(ta));
    await settle();
    mic.say("um remember the scroll pin");
    // A tap outside closes the card: the capture stands down on its own.
    await act(async () => root.render(<Card open={false} keep={keep} />));
    await settle();
    expect(mic.calls.some(([cmd]) => cmd === "dictation_stop")).toBe(true);
    expect(draft).toBe("Fix the tray. Remember the scroll pin");
    expect(strip.get()).toMatchObject({ phase: "notice", text: "Kept in the draft" });
    expect(host.busy()).toBe(false);
  });

  it("never touches the voice panel's own strip", async () => {
    await composer();
    press({ type: "down", at: now, source: APP_KEYS, solo: true });
    press({ type: "elapsed", at: now + HOLD_MS });
    await settle();
    mic.say("half a thought");
    // The panel takes the mic and shows its capture.
    const panel = { owner: "voice", phase: "listening" as const, text: "", levels: [], anchor: null, hint: "release to send" };
    strip.set(panel);
    await act(async () => void (await new DictationBroker(mic.bridge).start("voice", { kind: "hold" })));
    await settle();
    expect(strip.get()).toEqual(panel);
  });
});

describe("the polish", () => {
  const LONG = "so um what i think we should do is move the queue tray above the composer and keep the thread still";
  const T0 = "So what i think we should do is move the queue tray above the composer and keep the thread still";
  const POLISHED = "So what I think we should do is move the queue tray above the composer and keep the thread still.";

  /** A polish that answers when told to. */
  function deferred() {
    let answer!: (text: string) => void;
    polish.polish.mockImplementation(() => new Promise<string>((r) => (answer = r)));
    return (text: string) => act(async () => {
      // Late enough for the editor's own undo step.
      now += 1000;
      answer(text);
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("swaps the words for the polished ones after they land, and ⌘Z takes it back", async () => {
    const reply = deferred();
    talk = { key: "plan-1", markdown: () => "Move the QueueTray.", cwd: null };
    const { ta, shown } = await composer();
    await hold(LONG);
    // In at once, as the rules wrote it; the polish asked with the vocabulary.
    expect(shown()).toBe(T0);
    expect(polish.polish).toHaveBeenCalledWith(T0, ["QueueTray"]);
    await reply(POLISHED);
    expect(shown()).toBe(POLISHED);
    await act(async () => void ta.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })));
    expect(shown()).toBe(T0);
  });

  it("leaves words the user touched before it came", async () => {
    const reply = deferred();
    const { ta, shown } = await composer();
    await hold(LONG);
    await act(async () => {
      ta.setRangeText("!", ta.value.length, ta.value.length);
      ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "!" }));
    });
    await reply(POLISHED);
    expect(shown()).toBe(`${T0}!`);
  });

  it("throws away an answer in place of a polish", async () => {
    const reply = deferred();
    const { shown } = await composer();
    await hold(LONG);
    await reply("Great idea! Moving the tray above the composer keeps the newest line visible, which helps a lot.");
    expect(shown()).toBe(T0);
  });

  it("is never asked for short words, words sent by \"send it\", a composer that doesn't want it, or once turned off", async () => {
    const onSend = vi.fn();
    await composer(onSend);
    await hold("fix the tray");
    await hold(`${LONG} and send it`);
    expect(onSend).toHaveBeenCalledOnce();
    await act(async () => root.render(<Composer spec={{}} />));
    mount.querySelector("textarea")!.focus();
    await hold(LONG);
    localStorage.setItem("redline.dictation.polish", "off");
    await act(async () => root.render(<Composer key="again" />));
    mount.querySelector("textarea")!.focus();
    await hold(LONG);
    expect(polish.polish).not.toHaveBeenCalled();
  });

  it("is never asked for a turn, nor warmed for one", async () => {
    talk = { key: "plan-1", markdown: () => "# Plan", cwd: null };
    await hold(LONG);
    expect(voiceCalls().map(([cmd]) => cmd)).toContain("voice_send");
    // The voice panel's own turns too.
    taker = { key: "plan-1", start: vi.fn(), stop: vi.fn(), cancel: vi.fn() };
    await hold(LONG);
    expect(taker.stop).toHaveBeenCalledOnce();
    expect(polish.polish).not.toHaveBeenCalled();
    expect(polish.warm).not.toHaveBeenCalled();
  });

  it("warms as the user starts speaking into a composer that polishes, with the vocabulary it will polish with", async () => {
    talk = { key: "plan-1", markdown: () => "Move the QueueTray.", cwd: null };
    await composer();
    press({ type: "down", at: now, source: APP_KEYS, solo: true });
    press({ type: "elapsed", at: now + HOLD_MS });
    await settle();
    expect(polish.warm).toHaveBeenCalledWith(["QueueTray"]);
    mic.say(LONG);
    now += 1500;
    press({ type: "up", at: now });
    await settle();
    expect(polish.polish).toHaveBeenCalledWith(T0, polish.warm.mock.calls[0][0]);
  });

  it("is never warmed for a composer that doesn't want it, or once turned off", async () => {
    await composer(undefined, {});
    await hold(LONG);
    localStorage.setItem("redline.dictation.polish", "off");
    await act(async () => root.render(<Composer key="again" />));
    mount.querySelector("textarea")!.focus();
    await hold(LONG);
    expect(polish.warm).not.toHaveBeenCalled();
  });
});

describe("the vocabulary", () => {
  it("is learned from a word the user corrects, and spelled that way from then on", async () => {
    let stored: string | null = null;
    appInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_ui_prefs") return { voiceVocab: stored };
      if (cmd === "set_ui_pref") stored = args!.value as string;
      return null;
    });
    const { ta, shown } = await composer();
    await hold("the civcore sidecar needs a timeout");
    expect(shown()).toBe("The civcore sidecar needs a timeout");
    // The user puts it right — then sends, and the box clears.
    await act(async () => {
      ta.setSelectionRange(4, 11);
      ta.setRangeText("Kokoro", 4, 11, "end");
      ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Kokoro" }));
      ta.setRangeText("", 0, ta.value.length);
      ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    });
    await settle();
    expect(JSON.parse(stored!).pairs).toEqual([{ heard: "civcore", meant: "Kokoro", at: now }]);
    await hold("restart the civcore sidecar");
    expect(mic.calls.filter(([cmd]) => cmd === "dictation_start").pop()![1]?.vocab).toEqual(["Kokoro"]);
    expect(shown()).toBe("Restart the Kokoro sidecar");
  });

  it("carries the memory index's names, after the plan's", async () => {
    appInvoke.mockImplementation(async (cmd: string) =>
      cmd === "classmem_tree" ? [{ title: "Smart Turn scoring" }, { title: "Voice agent via Kokoro" }] : null,
    );
    host = new DictationHost({
      broker: new DictationBroker(mic.bridge),
      doc: document,
      conversation: () => talk,
      taker: () => taker,
      invoke: appInvoke as never,
      polish: polish as never,
      away: async () => away as never,
    });
    talk = { key: "plan-1", markdown: () => "Keep Tauri warm.", cwd: null };
    await settle();
    await composer();
    await hold("check the smart turn model");
    expect(mic.calls[0][1]?.vocab).toEqual(["Tauri", "Kokoro", "Smart Turn"]);
  });
});

describe("the project's names", () => {
  it("are read once per project, and ranked in from the next capture on", async () => {
    appInvoke.mockImplementation(async (cmd: string) =>
      cmd === "dictation_identifiers" ? ["DiscussPill.tsx", "README.md", "tts.rs"] : null,
    );
    talk = { key: "plan-1", markdown: () => "Keep Tauri warm.", cwd: "/repo" };
    await composer();
    await hold("check the discuss pill");
    await hold("and the discuss pill again");
    const asked = appInvoke.mock.calls.filter(([cmd]) => cmd === "dictation_identifiers");
    expect(asked).toEqual([["dictation_identifiers", { cwd: "/repo" }]]);
    const starts = mic.calls.filter(([cmd]) => cmd === "dictation_start");
    expect(starts.pop()![1]?.vocab).toEqual(["Tauri", "DiscussPill"]);
  });
});

describe("with nothing that takes text focused", () => {
  it("sends a turn to the plan's discussion, as said, without opening anything", async () => {
    talk = { key: "plan-1", markdown: () => "# Plan", cwd: null };
    await hold("um is the replay safe on remote");
    expect(voiceCalls()).toEqual([
      ["voice_session_start", { sessionId: "plan-1", planMarkdown: "# Plan", cwd: null }],
      ["voice_send", { sessionId: "plan-1", text: "um is the replay safe on remote", label: "um is the replay safe on remote" }],
    ]);
    expect(getVoiceAway()).toEqual({ key: "plan-1", state: "thinking" });
    expect(strip.get()).toMatchObject({ phase: "notice", text: "Sent to the discussion" });
  });

  it("lets the conversation it woke go once the reply has been idle a while, never under its open panel", async () => {
    talk = { key: "plan-1", markdown: () => "# Plan", cwd: null };
    let inFlight = true;
    appInvoke.mockImplementation(async (cmd: string) => (cmd === "voice_session_status" ? { inFlight } : null));
    const wait = vi.spyOn(globalThis, "setTimeout");
    await hold("is the replay safe on remote");
    const sleep = () => {
      const call = wait.mock.calls.filter(([, ms]) => ms === BACKGROUND_WARM_MS).pop()!;
      return act(async () => {
        (call[0] as () => void)();
        for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
      });
    };
    const stops = () => voiceCalls().filter(([cmd]) => cmd === "voice_session_stop");
    // Still answering: it stays up, and looks again later.
    await sleep();
    expect(stops()).toEqual([]);
    // Its panel is open now: the panel lets it go when it closes.
    inFlight = false;
    taker = { key: "plan-1", start: vi.fn(), stop: vi.fn(), cancel: vi.fn() };
    await sleep();
    expect(stops()).toEqual([]);
    // Another turn, the panel closed again: idle, it goes.
    taker = null;
    await hold("and on a slow network");
    await sleep();
    expect(stops()).toEqual([["voice_session_stop", { sessionId: "plan-1" }]]);
  });

  it("interrupts a reply still running instead of refusing the turn", async () => {
    talk = { key: "drafter:d1", markdown: () => "draft", cwd: "/tmp/p" };
    let refused = false;
    appInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "voice_send" && !refused) {
        refused = true;
        throw "a reply is still streaming";
      }
      if (cmd === "voice_session_status") return { inFlight: false };
      return null;
    });
    await hold("actually stop and look at phase two");
    expect(voiceCalls().map(([cmd]) => cmd)).toEqual([
      "voice_session_start",
      "voice_send",
      "voice_interrupt",
      "voice_session_status",
      "voice_send",
    ]);
  });

  it("hands the turn to the open voice panel's own push-to-talk", async () => {
    taker = { key: "plan-1", start: vi.fn(), stop: vi.fn(), cancel: vi.fn() };
    await hold("what does section two do");
    expect(taker.start).toHaveBeenCalledWith(now - 1500);
    expect(taker.stop).toHaveBeenCalledOnce();
    // The panel captures for itself; this owner never touched the mic.
    expect(mic.calls).toEqual([]);
    expect(strip.get()).toBeNull();
  });

  it("offers the words for copying when there is no conversation to send them to", async () => {
    await hold("remember to rerun the size check");
    expect(strip.get()).toMatchObject({ phase: "notice", copy: "remember to rerun the size check" });
  });
});

describe("the reply to a turn sent in the background", () => {
  /** The Discuss pill, on screen. */
  const pill = () => {
    const el = document.createElement("button");
    el.className = "rl-discuss-pill";
    document.body.appendChild(el);
  };

  it("is listened for before the turn goes, and followed by the turn it started", async () => {
    talk = { key: "plan-1", markdown: () => "# Plan", cwd: null };
    const order: string[] = [];
    away.expect.mockImplementation(async () => void order.push("expect"));
    appInvoke.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      return cmd === "voice_send" ? { generation: 3, turn: 7 } : null;
    });
    await hold("is the replay safe on remote");
    expect(order.filter((c) => c !== "get_ui_prefs" && c !== "classmem_tree")).toEqual(["voice_session_start", "expect", "voice_send"]);
    expect(away.expect).toHaveBeenCalledWith("plan-1");
    expect(away.sent).toHaveBeenCalledWith("plan-1", { generation: 3, turn: 7 });
  });

  it("shows the words on the pill's caption while they are said, never the strip, then what the agent does", async () => {
    pill();
    talk = { key: "plan-1", markdown: () => "# Plan", cwd: null };
    press({ type: "down", at: now, source: APP_KEYS, solo: true });
    press({ type: "elapsed", at: now + HOLD_MS });
    await settle();
    expect(voiceCaption.get()).toMatchObject({ key: "plan-1", phase: "hearing", text: "" });
    act(() => mic.emit("dictation-level", { owner: DICTATION_OWNER, rms: -20, peak: -10 }));
    mic.say("is the replay safe");
    expect(voiceCaption.get()).toMatchObject({ phase: "hearing", text: "is the replay safe" });
    expect(voiceCaption.get()!.levels).toHaveLength(1);
    expect(strip.get()).toBeNull();
    now += 1500;
    press({ type: "up", at: now });
    await settle();
    expect(voiceCaption.get()).toMatchObject({ key: "plan-1", phase: "thinking" });
    // The caption says it went: no notice besides.
    expect(strip.get()).toBeNull();
  });

  it("drops the caption of a capture that sends nothing", async () => {
    pill();
    talk = { key: "plan-1", markdown: () => "# Plan", cwd: null };
    press({ type: "down", at: now, source: APP_KEYS, solo: true });
    press({ type: "elapsed", at: now + HOLD_MS });
    await settle();
    expect(voiceCaption.get()?.phase).toBe("hearing");
    press({ type: "escape", at: now });
    await settle();
    expect(voiceCaption.get()).toBeNull();
    await hold("", { heard: false, ms: 200 });
    expect(voiceCaption.get()).toBeNull();
    expect(strip.get()).toMatchObject({ phase: "notice", text: "Didn't catch that" });
  });

  it("goes when the turn can't be sent, the words offered for copying", async () => {
    pill();
    talk = { key: "plan-1", markdown: () => "# Plan", cwd: null };
    appInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "voice_send") throw "voice session not started";
      return null;
    });
    await hold("is the replay safe on remote");
    expect(away.drop).toHaveBeenCalledWith("plan-1");
    expect(voiceCaption.get()).toBeNull();
    expect(strip.get()).toMatchObject({ phase: "notice", copy: "is the replay safe on remote" });
  });

  it("is left to the panel when it opens on the conversation while the words are said", async () => {
    pill();
    talk = { key: "plan-1", markdown: () => "# Plan", cwd: null };
    press({ type: "down", at: now, source: APP_KEYS, solo: true });
    press({ type: "elapsed", at: now + HOLD_MS });
    await settle();
    mic.say("is the replay safe");
    taker = { key: "plan-1", start: vi.fn(), stop: vi.fn(), cancel: vi.fn() };
    now += 1500;
    press({ type: "up", at: now });
    await settle();
    expect(voiceCalls().map(([cmd]) => cmd)).toEqual(["voice_session_start", "voice_send"]);
    expect(away.expect).not.toHaveBeenCalled();
    expect(voiceCaption.get()).toBeNull();
  });

  it("is hushed by the next hold, and handed to the panel that opens on its conversation", async () => {
    talk = { key: "plan-1", markdown: () => "# Plan", cwd: null };
    await hold("is the replay safe on remote");
    expect(away.hush).not.toHaveBeenCalled();
    press({ type: "down", at: now, source: APP_KEYS, solo: true });
    press({ type: "elapsed", at: now + HOLD_MS });
    await settle();
    expect(away.hush).toHaveBeenCalledOnce();
    press({ type: "escape", at: now });
    await settle();
    host.release("plan-1");
    expect(away.release).toHaveBeenCalledWith("plan-1");
  });
});

describe("its chunk", () => {
  it("loads with the terminal without the speech engines", () => {
    // App.tsx loads it at every launch; the speech drivers load once Redline
    // speaks. Its static imports, then (a type or a lazy import costs nothing).
    const reached = new Set<string>();
    const walk = (file: string) => {
      if (reached.has(file)) return;
      reached.add(file);
      const from = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?"(\.[^"]+)"/gm;
      for (const [, rel] of readFileSync(file, "utf8").matchAll(from)) {
        const base = join(dirname(file), rel);
        const hit = [`${base}.ts`, `${base}.tsx`].find((f) => existsSync(f));
        if (hit) walk(hit);
      }
    };
    walk("src/audio/dictationHost.ts");
    expect(reached).toContain("src/audio/generation.ts");
    expect([...reached].filter((f) => /\/(cloudTts|studioTts|speech|useReadAloud)\.ts$/.test(f))).toEqual([]);
  });
});
