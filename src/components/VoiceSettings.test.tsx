// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// The Kokoro voice picker: graded voices to audition with ▶, a blend, and the
// rule that only the user's own pick ever changes the saved voice — someone on
// am_adam (graded F+) is shown the grade, never moved off it.

const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
let savedVoice = "am_adam";
let savedEngine = "kokoro";
let studioSupported = false;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args: args ?? {} });
    if (cmd === "tts_get_settings")
      return Promise.resolve({
        engine: savedEngine,
        hasOpenaiKey: false,
        openaiVoice: "alloy",
        kokoroVoice: savedVoice,
        hasElevenKey: false,
        elevenVoice: "21m00Tcm4TlvDq8ikWAM",
        pythonPath: "",
        studioModel: "1.7B-CustomVoice-8bit",
        studioVoice: "aiden",
        studioStyle: "",
      });
    if (cmd === "tts_studio" && args.op === "status")
      return Promise.resolve({ supported: studioSupported });
    if (cmd === "tts_kokoro_status")
      return Promise.resolve({
        modelPresent: true,
        pythonReady: true,
        pythonPath: "/venv/bin/python3",
        detail: "Natural voice is ready.",
      });
    if (cmd === "dictation_get_engine") return Promise.resolve("auto");
    if (cmd === "whisper_model_present") return Promise.resolve(true);
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

// The studio voice's card (its own tests): here, only what it hands back.
vi.mock("./StudioVoiceCard", () => ({
  StudioVoiceCard: ({ prefs, onChange }: { prefs: { voice: string }; onChange: (p: object) => void }) =>
    createElement(
      "button",
      { type: "button", onClick: () => onChange({ ...prefs, voice: "serena", style: "calm" }) },
      `studio card: ${prefs.voice}`,
    ),
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
  handlers.clear();
  savedVoice = "am_adam";
  savedEngine = "kokoro";
  studioSupported = false;
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

const saved: unknown[][] = [];
async function mount() {
  await act(async () => {
    root.render(
      createElement(VoiceSettings, { onClose: () => {}, onSaved: (...a: unknown[]) => saved.push(a) }),
    );
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

describe("the studio voice", () => {
  const engines = () => [...host.querySelector("select")!.options].map((o) => o.value);

  it("is offered only on a Mac that can run it", async () => {
    await mount();
    expect(engines()).not.toContain("studio");
    act(() => root.unmount());
    root = createRoot(host);
    studioSupported = true;
    await mount();
    expect(engines()).toContain("studio");
  });

  it("opens its card when chosen, and saves its voice and style with the rest", async () => {
    savedEngine = "studio";
    saved.length = 0;
    await mount();
    await flush();
    expect(host.textContent).toContain("studio card: aiden");
    await act(async () => button("studio card: aiden").click());
    await act(async () => button("Save").click());
    await flush();
    expect(invoked).toContainEqual({
      cmd: "tts_studio",
      args: { op: "prefs", args: { voice: "serena", style: "calm" } },
    });
    expect(invoked.find((c) => c.cmd === "tts_set_settings")!.args.engine).toBe("studio");
    expect(saved).toEqual([["studio", "calm"]]);
  });
});
