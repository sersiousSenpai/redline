// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// The Kokoro voice picker: graded voices to audition with ▶, a blend, and the
// rule that only the user's own pick ever changes the saved voice — someone on
// am_adam (graded F+) is shown the grade, never moved off it. And the Whisper
// model choice for dictation, and the end-of-turn model for hands-free.

const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
let savedVoice = "am_adam";
// Set to hold `whisper_install` open until `finishInstall` is called.
let holdInstall = false;
let finishInstall: () => void = () => {};
let whisperModels = [
  { id: "base", present: true, bytes: 147_964_211, partial: 0 },
  { id: "turbo", present: false, bytes: 574_041_195, partial: 0 },
];
// The end-of-turn model: the Kokoro runtime it needs, and whether it is downloaded.
let turnRuntime = true;
let turnModelPresent = false;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args: args ?? {} });
    if (cmd === "tts_get_settings")
      return Promise.resolve({
        engine: "kokoro",
        hasOpenaiKey: false,
        openaiVoice: "alloy",
        kokoroVoice: savedVoice,
        hasElevenKey: false,
        elevenVoice: "21m00Tcm4TlvDq8ikWAM",
        pythonPath: "",
      });
    if (cmd === "tts_kokoro_status")
      return Promise.resolve({
        modelPresent: true,
        pythonReady: true,
        pythonPath: "/venv/bin/python3",
        detail: "Natural voice is ready.",
      });
    if (cmd === "whisper_install" && holdInstall)
      return new Promise<void>((resolve) => {
        finishInstall = resolve;
      });
    if (cmd === "dictation_status")
      return Promise.resolve({
        holder: null,
        engine: "auto",
        whisperModel: "base",
        whisperActive: "base",
        whisperModels,
        outputRoute: { kind: "speakers", transport: "builtin" },
      });
    if (cmd === "turn_scorer") {
      if (args.op === "install") turnModelPresent = true;
      return Promise.resolve({ runtime: turnRuntime, model: turnModelPresent, warm: false, score: null });
    }
    return Promise.resolve(null);
  }),
}));

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler[]>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: Handler) => {
    handlers.set(name, [...(handlers.get(name) ?? []), cb]);
    return Promise.resolve(() => {});
  }),
}));
const fire = (name: string, payload: unknown) => {
  for (const h of handlers.get(name) ?? []) h({ payload });
};

const samples: { voice: string; rate: number; stop: ReturnType<typeof vi.fn> }[] = [];
vi.mock("../audio/cloudTts", () => ({
  playVoiceSample: vi.fn((voice: string, rate: number) => {
    const stop = vi.fn();
    samples.push({ voice, rate, stop });
    return stop;
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { VoiceSettings } from "./VoiceSettings";

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  invoked.length = 0;
  samples.length = 0;
  holdInstall = false;
  whisperModels = [
    { id: "base", present: true, bytes: 147_964_211, partial: 0 },
    { id: "turbo", present: false, bytes: 574_041_195, partial: 0 },
  ];
  handlers.clear();
  turnRuntime = true;
  turnModelPresent = false;
  savedVoice = "am_adam";
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

async function mount() {
  await act(async () => {
    root.render(createElement(VoiceSettings, { onClose: () => {}, onSaved: () => {} }));
  });
  await flush();
}

const radios = () => [...host.querySelectorAll<HTMLInputElement>('input[name="kokoro-voice"]')];
const rowOf = (name: string) =>
  radios().find((r) => r.closest("label")!.textContent!.startsWith(name))!;
const button = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name,
  )!;
const save = async () => {
  await act(async () => button("Save").click());
  await flush();
  return invoked.find((c) => c.cmd === "tts_set_settings")!.args;
};

describe("Kokoro voice picker", () => {
  it("keeps a saved am_adam selected, and says what its grade means", async () => {
    await mount();
    const checked = radios().filter((r) => r.checked);
    expect(checked).toHaveLength(1);
    expect(checked[0].closest("label")!.textContent).toBe("AdamUS malegrade F+");
    expect(host.textContent).toContain("Adam · grade F+");
    expect(host.textContent).toContain("Adam is graded F+");
    // Best first: the list opens on the A voices.
    expect(radios()[0].closest("label")!.textContent).toBe("HeartUS femalegrade A");
    expect((await save()).kokoroVoice).toBe("am_adam");
  });

  it("▶ auditions a voice at the saved speed without changing the saved one", async () => {
    localStorage.setItem("redline.voice.prefs", JSON.stringify({ voiceURI: null, rate: 1.25 }));
    await mount();
    await act(async () => button("Play a sample of Heart").click());
    expect(samples).toEqual([{ voice: "af_heart", rate: 1.25, stop: expect.any(Function) }]);
    // ■ stops it; starting another sample stops the one playing.
    await act(async () => button("Stop the sample").click());
    expect(samples[0].stop).toHaveBeenCalled();
    await act(async () => button("Play a sample of Bella").click());
    await act(async () => button("Play a sample of Michael").click());
    expect(samples[1].stop).toHaveBeenCalled();
    expect((await save()).kokoroVoice).toBe("am_adam");
  });

  it("leaving settings stops a sample that is still playing", async () => {
    await mount();
    await act(async () => button("Play a sample of Puck").click());
    act(() => root.unmount());
    expect(samples[0].stop).toHaveBeenCalled();
    root = createRoot(host); // for afterEach
  });

  it("saves a picked voice blended with a second one", async () => {
    await mount();
    await act(async () => rowOf("Michael").click());
    const select = [...host.querySelectorAll("select")].find(
      (s) => s.options[0].text === "Nothing (one voice)",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
        select,
        "am_fenrir",
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).not.toContain("graded F+");
    await act(async () => button("Play a sample of the Michael and Fenrir blend").click());
    expect(samples[0].voice).toBe("am_michael+am_fenrir");
    expect((await save()).kokoroVoice).toBe("am_michael+am_fenrir");
  });

  it("shows the background model upgrade's progress", async () => {
    await mount();
    await act(async () => fire("kokoro-setup", { phase: "upgrade", received: 1_000_000, total: 325_532_387 }));
    expect(host.textContent).toContain(
      "Downloading a faster voice model in the background — 1.0 MB / 325.5 MB. The current one keeps talking until it's ready.",
    );
    await act(async () => fire("kokoro-setup", { phase: "done", received: 0, total: 0 }));
    expect(host.textContent).not.toContain("faster voice model");
  });
});

describe("Whisper model choice", () => {
  const pick = async (value: string) => {
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Whisper model"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  it("offers the large model as a download, while base keeps dictating", async () => {
    await mount();
    expect(host.textContent).toContain("Whisper base installed");
    await pick("turbo");
    expect(host.textContent).toContain("Until it is downloaded, dictation uses Whisper base.");
    whisperModels = [whisperModels[0], { ...whisperModels[1], present: true }];
    await act(async () => button("Download Whisper large turbo (574.0 MB)").click());
    await flush();
    expect(invoked.find((c) => c.cmd === "whisper_install")!.args).toEqual({ model: "turbo" });
    expect(host.textContent).toContain("Whisper large turbo installed");
    await act(async () => button("Save").click());
    await flush();
    expect(invoked.find((c) => c.cmd === "dictation_set_engine")!.args).toEqual({
      engine: "auto",
      whisperModel: "turbo",
    });
  });

  it("holds the model choice still while its download runs", async () => {
    holdInstall = true;
    await mount();
    await pick("turbo");
    await act(async () => button("Download Whisper large turbo (574.0 MB)").click());
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Whisper model"]')!;
    expect(select.disabled).toBe(true);
    await act(async () => fire("whisper-setup", { phase: "model", model: "turbo", received: 287_000_000, total: 574_041_195 }));
    expect(host.textContent).toContain("287.0 MB / 574.0 MB");
    whisperModels = [whisperModels[0], { ...whisperModels[1], present: true }];
    await act(async () => finishInstall());
    await flush();
    expect(select.disabled).toBe(false);
    expect(host.textContent).toContain("Whisper large turbo installed");
  });

  it("resumes a download an interruption left half done", async () => {
    whisperModels = [whisperModels[0], { ...whisperModels[1], partial: 200_000_000 }];
    await mount();
    await pick("turbo");
    expect(button("Resume download (200.0 MB of 574.0 MB)")).toBeTruthy();
  });
});

describe("end-of-turn model", () => {
  const toggle = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

  it("is offered only with the Kokoro runtime it runs on", async () => {
    turnRuntime = false;
    await mount();
    expect(host.textContent).not.toContain("End of turn");
  });

  it("downloads on request, then is on, and can be switched off", async () => {
    await mount();
    expect(host.textContent).toContain("End of turn (hands-free)");
    await act(async () => button("Download the end-of-turn model (8.7 MB)").click());
    await flush();
    expect(invoked.filter((c) => c.cmd === "turn_scorer").map((c) => c.args)).toEqual([
      { op: "status" },
      { op: "install" },
    ]);
    expect(toggle().checked).toBe(true);
    await act(async () => toggle().click());
    expect(localStorage.getItem("redline.voice.turnModelOff")).toBe("1");
    // Off stops its process now, not at the next listen.
    expect(invoked.filter((c) => c.cmd === "turn_scorer").map((c) => c.args)).toContainEqual({ op: "stop" });
    await act(async () => toggle().click());
    expect(localStorage.getItem("redline.voice.turnModelOff")).toBeNull();
  });
});
