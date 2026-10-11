// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Args = Record<string, unknown>;
const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: Args): Promise<unknown> => "polished"));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage: (data: ArrayBuffer) => void = () => {};
  },
}));

import {
  cleanupChild,
  LOCAL_LIMIT_MS,
  polished,
  polishEnabled,
  polishEngine,
  setPolishEnabled,
  wantsPolish,
} from "./dictationPolish";

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  invoke.mockImplementation(async () => "polished");
});
afterEach(() => vi.useRealTimers());

describe("when to polish", () => {
  it("only past twelve words, or for a list", () => {
    expect(wantsPolish("fix the tray and the pin")).toBe(false);
    expect(wantsPolish("one two three four five six seven eight nine ten eleven twelve")).toBe(false);
    expect(wantsPolish("one two three four five six seven eight nine ten eleven twelve thirteen")).toBe(true);
    expect(wantsPolish("- Fix the queue tray\n- Fix the scroll pin")).toBe(true);
    expect(wantsPolish("Two things. First, the tray; second, the pin")).toBe(true);
    // An ordinal inside a sentence is no list.
    expect(wantsPolish("the first message waits")).toBe(false);
  });

  it("is on until the user turns it off", () => {
    expect(polishEnabled()).toBe(true);
    setPolishEnabled(false);
    expect(polishEnabled()).toBe(false);
    setPolishEnabled(true);
    expect(polishEnabled()).toBe(true);
  });
});

describe("the cleanup child", () => {
  it("is voice_clean, with the vocabulary's ranked head as its spellings", async () => {
    const vocab = Array.from({ length: 80 }, (_, i) => `Term${i}`);
    expect(await cleanupChild.polish("so the tray", vocab)).toBe("polished");
    expect(invoke).toHaveBeenCalledWith("voice_clean", { text: "so the tray", vocab: vocab.slice(0, 60) });
  });

  it("warms with an empty text, which starts the process and polishes nothing", () => {
    cleanupChild.warm([]);
    expect(invoke).toHaveBeenCalledWith("voice_clean", { text: "" });
  });
});

describe("what comes back", () => {
  const SAID = " so i think the tray should sit above the composer and the thread never moves";

  it("is used in place of the words, their edges kept", () => {
    expect(polished(SAID, "So I think the tray should sit above the composer, and the thread never moves.", [])).toBe(
      " so I think the tray should sit above the composer, and the thread never moves.",
    );
    // Running on into the text after: no full stop of its own.
    expect(polished(SAID, "So I think the tray should sit above the composer, and the thread never moves.", [], " because")).toBe(
      " so I think the tray should sit above the composer, and the thread never moves",
    );
  });

  it("loses the model's own wrapping", () => {
    expect(polished("the tray moves", "<text>\nThe tray moves.\n</text>", [])).toBe("the tray moves.");
    expect(polished("the tray moves", "“The tray moves.”", [])).toBe("the tray moves.");
  });

  it("is thrown away when it answers, summarizes or adds", () => {
    const question = "can you tell me why the tray hides the newest line when a reply is long";
    expect(polished(question, "The tray floats over the thread, so a long reply's last line sits under it — pad the thread by the tray's height.", [])).toBeNull();
    expect(polished(SAID, "Tray above composer.", [])).toBeNull();
    expect(polished(SAID, `${SAID.trim()} and also we should probably add a toggle for it too`, [])).toBeNull();
  });

  it("is thrown away when it drops a term's spelling or a list item", () => {
    expect(polished("the Kokoro sidecar in tts.rs needs a timeout", "The Coco Rho sidecar in TTS.rs needs a timeout.", ["Kokoro", "tts.rs"])).toBeNull();
    expect(polished("- Fix the tray\n- Fix the pin", "Fix the tray and the pin.", [])).toBeNull();
  });

  it("is nothing when nothing changed", () => {
    expect(polished("The tray moves.", "The tray moves.", [])).toBeNull();
    expect(polished("The tray moves.", "", [])).toBeNull();
  });
});

// --- the local model -----------------------------------------------------------

/** A frame as tts_studio.rs writes it: the generation's low 32 bits, a
 *  sequence, flags, then the outcome as JSON. */
function frame(generation: number, flags: number, outcome: unknown): ArrayBuffer {
  const body = new TextEncoder().encode(JSON.stringify(outcome));
  const buf = new ArrayBuffer(12 + body.length);
  const head = new DataView(buf);
  head.setUint32(0, generation >>> 0, true);
  head.setUint16(8, flags, true);
  new Uint8Array(buf, 12).set(body);
  return buf;
}
const FINAL = 1;
const ERROR = 4;

interface Asked {
  args: { text: string; vocab: string[]; generation: number };
  reply: (data: ArrayBuffer) => void;
}

/** `tts_studio` with the polish model installed: each polish is held for the
 *  test to answer. */
function localModel() {
  const asked: Asked[] = [];
  invoke.mockImplementation(async (cmd: string, args?: Args) => {
    if (cmd === "voice_clean") return "From the cleanup child.";
    if (cmd === "tts_studio" && args?.op === "warm") return true;
    if (cmd === "tts_studio" && args?.op === "polish") {
      const channel = args.onAudio as { onmessage: (data: ArrayBuffer) => void };
      asked.push({ args: args.args as Asked["args"], reply: (data) => channel.onmessage(data) });
    }
    return null;
  });
  return asked;
}

const cleanupCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === "voice_clean");

describe("the engine", () => {
  const VOCAB = ["QueueTray", "x".repeat(65), " ", "Kokoro"];

  it("is the local model when it is installed: its reply is the polish, and nothing goes to the cleanup child", async () => {
    const asked = localModel();
    const done = polishEngine.polish("um so the queue tray moves", VOCAB);
    await Promise.resolve();
    const [{ args, reply }] = asked;
    // The terms the sidecar takes, and a generation from the app-wide counter.
    expect(args).toEqual({ text: "um so the queue tray moves", vocab: ["QueueTray", "Kokoro"], generation: expect.any(Number) });
    // Another request's reply is not this one's.
    reply(frame(args.generation + 1, FINAL, { type: "polished", text: "Wrong one." }));
    reply(frame(args.generation, FINAL, { type: "polished", text: "So the QueueTray moves." }));
    expect(await done).toBe("So the QueueTray moves.");
    expect(cleanupCalls()).toEqual([]);
  });

  it("keeps the words the local model refused to change, without asking the cleanup child", async () => {
    const asked = localModel();
    const said = "can you tell me why the tray hides the newest line";
    const done = polishEngine.polish(said, []);
    await Promise.resolve();
    asked[0].reply(frame(asked[0].args.generation, FINAL, { type: "polished", text: said, changed: false, guard: "reply_opener" }));
    expect(await done).toBe(said);
    expect(cleanupCalls()).toEqual([]);
  });

  it("is the cleanup child when the local model isn't installed", async () => {
    invoke.mockImplementation(async (cmd: string, args?: Args) => {
      if (cmd === "tts_studio" && args?.op === "polish") throw "polish_not_installed";
      return "From the cleanup child.";
    });
    expect(await polishEngine.polish("um the tray", ["QueueTray"])).toBe("From the cleanup child.");
    expect(cleanupCalls()).toEqual([["voice_clean", { text: "um the tray", vocab: ["QueueTray"] }]]);
  });

  it("falls back to the cleanup child when the local model is too slow or fails", async () => {
    const asked = localModel();
    const slow = polishEngine.polish("um the tray", []);
    const failed = polishEngine.polish("um the pin", []);
    await Promise.resolve();
    asked[0].reply(frame(asked[0].args.generation, FINAL | ERROR, { type: "error", code: "slow" }));
    asked[1].reply(frame(asked[1].args.generation, FINAL | ERROR, { type: "error", code: "sidecar_exited" }));
    expect(await slow).toBe("From the cleanup child.");
    expect(await failed).toBe("From the cleanup child.");
    expect(cleanupCalls().map(([, a]) => (a as Args).text)).toEqual(["um the tray", "um the pin"]);
  });

  it("falls back when no reply comes at all", async () => {
    vi.useFakeTimers();
    localModel();
    const done = polishEngine.polish("um the tray", []);
    await vi.advanceTimersByTimeAsync(LOCAL_LIMIT_MS);
    expect(await done).toBe("From the cleanup child.");
  });

  it("warms the local model with the terms it will polish with", async () => {
    const asked = localModel();
    polishEngine.warm!(VOCAB);
    void polishEngine.polish("the tray", VOCAB);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith("tts_studio", { op: "warm", args: { polish: true, vocab: ["QueueTray", "Kokoro"] } });
    expect(asked[0].args.vocab).toEqual(["QueueTray", "Kokoro"]);
    expect(cleanupCalls()).toEqual([]);
  });

  it("warms the cleanup child instead when local polish isn't installed", async () => {
    invoke.mockImplementation(async (cmd: string, args?: Args) => (cmd === "tts_studio" && args?.op === "warm" ? false : ""));
    polishEngine.warm!(VOCAB);
    await vi.waitFor(() => expect(cleanupCalls()).toEqual([["voice_clean", { text: "" }]]));
  });

  it("or when the local model can't be had now", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "tts_studio") throw "memory_pressure";
      return "";
    });
    polishEngine.warm!(VOCAB);
    await vi.waitFor(() => expect(cleanupCalls()).toEqual([["voice_clean", { text: "" }]]));
  });
});
