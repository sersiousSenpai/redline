// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appInvoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: appInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { strip } from "../components/DictationStrip";
import { useDictationComposer, type ComposerSpec } from "../lib/dictationComposer";
import { DictationBroker } from "./dictationBroker";
import { DICTATION_OWNER, DictationHost, type TalkContext, type TurnTaker } from "./dictationHost";
import { getVoiceAway, setVoiceAway } from "./voiceAway";
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
let polish: { polish: ReturnType<typeof vi.fn> };
let talk: TalkContext | null;
let taker: TurnTaker | null;
let root: Root;
let mount: HTMLDivElement;
let now: number;

beforeEach(() => {
  appInvoke.mockReset();
  appInvoke.mockImplementation(async () => null);
  localStorage.clear();
  polish = { polish: vi.fn(async () => "") };
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
  });
  mount = document.createElement("div");
  document.body.appendChild(mount);
  root = createRoot(mount);
  strip.set(null);
  setVoiceAway(null);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** What the host asked of the app, past loading the user's words and the
 *  memory index's names. */
const voiceCalls = () => appInvoke.mock.calls.filter(([cmd]) => cmd !== "get_ui_prefs" && cmd !== "classmem_tree");

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

  it("is never asked for a turn", async () => {
    talk = { key: "plan-1", markdown: () => "# Plan", cwd: null };
    await hold(LONG);
    expect(voiceCalls().map(([cmd]) => cmd)).toContain("voice_send");
    expect(polish.polish).not.toHaveBeenCalled();
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
    });
    talk = { key: "plan-1", markdown: () => "Keep Tauri warm.", cwd: null };
    await settle();
    await composer();
    await hold("check the smart turn model");
    expect(mic.calls[0][1]?.vocab).toEqual(["Tauri", "Kokoro", "Smart Turn"]);
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
    taker = { start: vi.fn(), stop: vi.fn(), cancel: vi.fn() };
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
