// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appInvoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: appInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { strip } from "../components/DictationStrip";
import { DictationBroker } from "./dictationBroker";
import { DICTATION_OWNER, DictationHost, type TalkContext, type TurnTaker } from "./dictationHost";
import { getVoiceAway, setVoiceAway } from "./voiceAway";
import { APP_KEYS, HOLD_MS } from "./voiceHotkey";

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
let talk: TalkContext | null;
let taker: TurnTaker | null;
let root: Root;
let mount: HTMLDivElement;
let now: number;

beforeEach(() => {
  appInvoke.mockReset();
  appInvoke.mockImplementation(async () => null);
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

/** What the host asked of the app, past loading the user's words. */
const voiceCalls = () => appInvoke.mock.calls.filter(([cmd]) => cmd !== "get_ui_prefs");

const settle = () => act(async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
});

/** Hold the key `ms`, saying `text` meanwhile, and let go. */
async function hold(text: string, opts: { ms?: number; heard?: boolean } = {}) {
  host.hotkey.dispatch({ type: "down", at: now, source: APP_KEYS, solo: true });
  host.hotkey.dispatch({ type: "elapsed", at: now + HOLD_MS });
  await settle();
  mic.say(text, opts);
  now += opts.ms ?? 1500;
  host.hotkey.dispatch({ type: "up", at: now });
  await settle();
}

function Composer({ onSend }: { onSend?: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div data-dictation-anchor data-dictation-send>
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

async function composer(onSend?: (text: string) => void) {
  await act(async () => root.render(<Composer onSend={onSend} />));
  const ta = mount.querySelector("textarea")!;
  ta.focus();
  return { ta, shown: () => mount.querySelector("output")!.textContent };
}

describe("dictating into a composer", () => {
  it("captures as the dictation owner, shows the words on the strip, and writes them cleaned up on release", async () => {
    const { ta, shown } = await composer();
    host.hotkey.dispatch({ type: "down", at: now, source: APP_KEYS, solo: true });
    host.hotkey.dispatch({ type: "elapsed", at: now + HOLD_MS });
    await settle();
    expect(mic.calls[0]).toEqual(["dictation_start", { owner: DICTATION_OWNER, kind: "hold", vocab: [], preroll: true }]);
    expect(strip.get()).toMatchObject({ phase: "listening", hint: "release to insert", anchor: ta.parentElement });
    mic.say("um the kokoro sidecar in tts dot rs");
    expect(strip.get()?.text).toBe("um the kokoro sidecar in tts dot rs");
    // Nothing is written while the key is held.
    expect(ta.value).toBe("");
    now += 2000;
    host.hotkey.dispatch({ type: "up", at: now });
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
    host.hotkey.dispatch({ type: "down", at: now, source: APP_KEYS, solo: true });
    host.hotkey.dispatch({ type: "elapsed", at: now + HOLD_MS });
    await settle();
    mic.say("never mind all this");
    expect(host.hotkey.dispatch({ type: "escape", at: now + 900 })).toBe(true);
    await settle();
    expect(mic.calls[mic.calls.length - 1]).toEqual(["dictation_kill_all", { owner: DICTATION_OWNER }]);
    expect(shown()).toBe("");
    expect(strip.get()).toBeNull();
    expect(host.busy()).toBe(false);
  });

  it("keeps the words heard when another gesture takes the mic", async () => {
    const { shown } = await composer();
    host.hotkey.dispatch({ type: "down", at: now, source: APP_KEYS, solo: true });
    host.hotkey.dispatch({ type: "elapsed", at: now + HOLD_MS });
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
    host.toggleInto(ta);
    await settle();
    expect(strip.get()?.hint).toBe("tap again to insert · esc cancels");
    mic.say("a long thought, said slowly");
    now += 9000;
    host.toggleInto(ta);
    await settle();
    expect(shown()).toBe("A long thought, said slowly");
    // And the key's tap ends one too.
    host.toggleInto(ta);
    await settle();
    mic.say("second thought");
    host.hotkey.dispatch({ type: "down", at: now, source: APP_KEYS, solo: true });
    host.hotkey.dispatch({ type: "up", at: now + 80 });
    await settle();
    expect(shown()).toBe("A long thought, said slowly second thought");
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
