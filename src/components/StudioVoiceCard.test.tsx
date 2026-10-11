// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The studio voice's settings card against a scripted `tts_studio`: what it
// costs, what this Mac lacks in words, the install from first byte to "Studio
// voice ready." (cancelled and resumed on the way), the previews, the model,
// the way back out; and the local dictation polish row, on the same runtime,
// which the Dictation section shows whatever the speaking engine.
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Args = Record<string, unknown>;
const { rust, handlers, samples } = vi.hoisted(() => ({
  rust: {
    calls: [] as Array<[string, Args]>,
    status: {} as Record<string, unknown>,
    preflight: {} as Record<string, unknown>,
    polishPreflight: {} as Record<string, unknown>,
  },
  handlers: new Map<string, Array<(e: { payload: unknown }) => void>>(),
  samples: [] as Array<{ voice: string; text: string; onEnd: (e?: string) => void; stop: () => void }>,
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: vi.fn(async (cmd: string, args: Args = {}) => {
    rust.calls.push([cmd, args]);
    if (args.op === "status") return { ...rust.status };
    if (args.op === "preflight") {
      const polish = (args.args as Args).model === "polish/Qwen3.5-2B-4bit";
      return { ...(polish ? rust.polishPreflight : rust.preflight) };
    }
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => {
    handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    return () => {};
  }),
}));
vi.mock("../audio/studioTts", async (original) => ({
  ...(await original<typeof import("../audio/studioTts")>()),
  playStudioSample: vi.fn((voice: string, text: string, onEnd: (e?: string) => void) => {
    const stop = vi.fn();
    samples.push({ voice, text, onEnd, stop });
    return stop;
  }),
}));

import { LocalPolish, StudioVoiceCard, type StudioPrefs } from "./StudioVoiceCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EIGHT = "1.7B-CustomVoice-8bit";
const FOUR = "1.7B-CustomVoice-4bit";
const POLISH = "polish/Qwen3.5-2B-4bit";
let host: HTMLDivElement;
let root: Root;
let prefs: StudioPrefs;
const errors: string[] = [];

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const fire = (name: string, payload: unknown) =>
  act(async () => {
    for (const h of handlers.get(name) ?? []) h({ payload });
  });
const ops = () => rust.calls.filter(([c]) => c === "tts_studio").map(([, a]) => a.op);
const button = (text: string) =>
  [...host.querySelectorAll("button")].find(
    (b) => b.textContent?.includes(text) || b.getAttribute("aria-label") === text,
  ) as HTMLButtonElement | undefined;
/** The studio card, the local polish row, or both (Voice settings with the
 *  studio voice as the engine). */
async function render(...parts: Array<"card" | "polish">) {
  const shown = parts.length ? parts : ["card"];
  const onError = (m: string) => errors.push(m);
  const card = createElement(StudioVoiceCard, {
    key: "card",
    prefs,
    onChange: (p: StudioPrefs) => {
      prefs = p;
    },
    onError,
  });
  const polish = createElement(LocalPolish, { key: "polish", onError });
  await act(async () =>
    root.render(
      createElement(Fragment, null, shown.includes("card") && card, shown.includes("polish") && polish),
    ),
  );
  await flush();
}
const polishRow = () => host.querySelector("[data-studio-polish]")!.textContent!;

beforeEach(() => {
  rust.calls.length = 0;
  rust.status = {
    supported: true,
    model: EIGHT,
    installed: false,
    models: null,
    runtimeCurrent: false,
    state: "off",
    installing: null,
    speedRatio: null,
    slow: false,
  };
  rust.preflight = {
    blockers: [],
    ramBytes: 48e9,
    freeMemoryBytes: 20e9,
    freeDiskBytes: 200e9,
    needDiskBytes: 4.5e9,
    needMemoryBytes: 4.2e9,
  };
  rust.polishPreflight = { ...rust.preflight, needDiskBytes: 2.5e9, needMemoryBytes: 1.9e9, needRamBytes: 8e9 };
  handlers.clear();
  samples.length = 0;
  errors.length = 0;
  prefs = { model: EIGHT, voice: "ryan", style: "" };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("StudioVoiceCard", () => {
  it("says what it costs, that this Mac can run it, and installs, cancels and resumes", async () => {
    await render();
    expect(host.textContent).toContain(
      "Studio voice — 3.1 GB download, about 4.2 GB memory while speaking",
    );
    expect(host.textContent).toContain("✓ This Mac can run it: 200.0 GB of disk and 20.0 GB of memory free.");
    await act(async () => button("Install the studio voice (3.1 GB)")!.click());
    expect(ops()).toContain("install");
    await fire("studio-setup", { phase: "model", received: 1.55e9, total: 3.1e9 });
    const bar = host.querySelector("[role=progressbar]")!;
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(host.textContent).toContain("Downloading the voice model… 1.6 GB of 3.1 GB");
    await act(async () => button("Cancel")!.click());
    expect(ops()).toContain("cancel");
    await fire("studio-setup", { phase: "error", message: "cancelled" });
    expect(host.textContent).toContain("Install paused. What it downloaded is kept.");
    rust.calls.length = 0;
    await act(async () => button("Resume install")!.click());
    expect(ops()).toEqual(["install"]);
    // Paused again, then another model picked: that one starts fresh.
    await fire("studio-setup", { phase: "error", message: "cancelled" });
    await act(async () => (host.querySelectorAll("input[name=studio-model]")[1] as HTMLInputElement).click());
    await render();
    expect(host.textContent).not.toContain("Install paused");
    expect(button("Install the studio voice (2.3 GB)")).toBeDefined();
  });

  it("puts what this Mac lacks in words, and won't install until it has it", async () => {
    rust.preflight = {
      ...rust.preflight,
      blockers: ["disk", "memory"],
      freeDiskBytes: 2e9,
      freeMemoryBytes: 1.5e9,
    };
    await render();
    expect(host.textContent).toContain("Needs 4.5 GB of free disk; 2.0 GB is free.");
    expect(host.textContent).toContain("Needs about 4.2 GB of free memory to speak; 1.5 GB is free right now.");
    expect(button("Install the studio voice")!.disabled).toBe(true);
    rust.calls.length = 0;
    await act(async () => button("Check again")!.click());
    expect(ops()).toEqual(["status", "preflight"]);
  });

  it("ends an install warm, saying so in the chosen voice, and then offers each voice to hear", async () => {
    prefs = { ...prefs, voice: "serena" };
    await render();
    expect(button("Play a sample of Ryan")!.disabled).toBe(true);
    await act(async () => button("Install the studio voice (3.1 GB)")!.click());
    rust.status = { ...rust.status, installed: true, runtimeCurrent: true, models: { [EIGHT]: { speedRatio: 0.27 } }, state: "ready" };
    await fire("studio-setup", { phase: "done", speedRatio: 0.27, slow: false });
    await flush();
    expect(samples.map((s) => [s.voice, s.text])).toEqual([["serena", "Studio voice ready."]]);
    expect(host.textContent).toContain("✓ Installed");
    expect(host.textContent).toContain("3.7 times faster than it plays");
    await act(async () => button("Play a sample of Aiden")!.click());
    expect(samples[1].voice).toBe("aiden");
    expect(samples[0].stop).toHaveBeenCalled();
    // A second press stops it.
    await act(async () => button("Stop the sample")!.click());
    expect(samples[1].stop).toHaveBeenCalled();
    expect(samples).toHaveLength(2);
  });

  it("warns when this Mac speaks it slower than it plays", async () => {
    rust.status = { ...rust.status, installed: true, runtimeCurrent: true, models: { [EIGHT]: { speedRatio: 0.62 } } };
    await render();
    expect(host.textContent).toContain("It spoke at 0.62× real time here");
  });

  it("only looks at a model that isn't installed until its install starts, and switches to one that is", async () => {
    rust.status = { ...rust.status, installed: true, runtimeCurrent: true, models: { [EIGHT]: {} } };
    await render();
    const radios = () => host.querySelectorAll("input[name=studio-model]") as NodeListOf<HTMLInputElement>;
    rust.calls.length = 0;
    await act(async () => radios()[1].click());
    await flush();
    // Saving it would turn the installed voice off until it was installed.
    expect(ops()).not.toContain("prefs");
    expect(rust.calls).toContainEqual(["tts_studio", { op: "preflight", args: { model: FOUR } }]);
    expect(prefs.model).toBe(FOUR);
    await render();
    expect(host.textContent).toContain("Studio voice — 2.3 GB download, about 3.4 GB memory while speaking");
    await act(async () => button("Install the studio voice (2.3 GB)")!.click());
    expect(rust.calls).toContainEqual(["tts_studio", { op: "install", args: { model: FOUR } }]);
    // Back to the installed one: switched to at once, so its ▶ plays it.
    await fire("studio-setup", { phase: "error", message: "cancelled" });
    await act(async () => radios()[0].click());
    await flush();
    expect(rust.calls).toContainEqual(["tts_studio", { op: "prefs", args: { model: EIGHT } }]);
  });

  it("offers only tested styles, and removes the install after asking", async () => {
    rust.status = { ...rust.status, installed: true, runtimeCurrent: true, models: { [EIGHT]: {} } };
    await render();
    const styles = [...host.querySelectorAll("select option")].map((o) => o.textContent);
    expect(styles).toEqual(["Natural", "Calm", "Gentle", "Slow", "Brisk", "Upbeat", "Excited"]);
    await act(async () => button("Remove the studio voice…")!.click());
    expect(host.textContent).toContain("Remove the studio voice and everything it downloaded?");
    expect(ops()).not.toContain("remove");
    await act(async () => button("Remove")!.click());
    expect(ops()).toContain("remove");
  });

  it("points to local polish under Dictation, where it no longer lives in the card", async () => {
    await render();
    expect(host.querySelector("[data-studio-polish]")).toBeNull();
    expect(host.querySelector("[data-studio-polish-pointer]")!.textContent).toContain("under Dictation, below");
    expect(ops()).toEqual(["status", "preflight"]);
  });
});

describe("LocalPolish", () => {
  it("is a download of its own: the runtime and its model, without the voice", async () => {
    await render("polish");
    expect(polishRow()).toContain("Polish dictation locally1.7 GB download, about 1.9 GB of memory while in use");
    expect(polishRow()).toContain("✓ This Mac can run it");
    expect(rust.calls).toContainEqual(["tts_studio", { op: "preflight", args: { model: POLISH } }]);
    await act(async () => button("Install local polish (1.7 GB)")!.click());
    expect(rust.calls).toContainEqual(["tts_studio", { op: "install", args: { polish: true } }]);
    await fire("studio-setup", { phase: "model", received: 0.87e9, total: 1.74e9, polish: true });
    const bar = host.querySelector('[role=progressbar][aria-label="Local polish install"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(polishRow()).toContain("Downloading the polish model… 0.9 GB of 1.7 GB");
    await act(async () => button("Cancel")!.click());
    await fire("studio-setup", { phase: "error", message: "cancelled", polish: true });
    expect(polishRow()).toContain("Install paused. What it downloaded is kept.");
    await act(async () => button("Resume install")!.click());
    rust.status = { ...rust.status, runtimeCurrent: true, models: { [POLISH]: {} } };
    await fire("studio-setup", { phase: "done", polish: true });
    await flush();
    expect(samples).toEqual([]);
    expect(polishRow()).toContain("✓ Dictation is polished on this Mac");
  });

  it("and the voice's install, each waiting for the other", async () => {
    await render("card", "polish");
    await act(async () => button("Install local polish (1.7 GB)")!.click());
    await fire("studio-setup", { phase: "model", received: 0.87e9, total: 1.74e9, polish: true });
    // The voice's install isn't the one running, and waits for it.
    expect(host.querySelector('[aria-label="Studio voice install"]')).toBeNull();
    expect(button("Install the studio voice (3.1 GB)")!.disabled).toBe(true);
    rust.status = { ...rust.status, runtimeCurrent: true, models: { [POLISH]: {} } };
    await fire("studio-setup", { phase: "done", polish: true });
    await flush();
    expect(button("Install the studio voice (3.1 GB)")!.disabled).toBe(false);
    await act(async () => button("Install the studio voice (3.1 GB)")!.click());
    await fire("studio-setup", { phase: "model", received: 1e9, total: 3.1e9 });
    expect(host.querySelector('[aria-label="Local polish install"]')).toBeNull();
    expect(host.querySelector("[aria-label='Studio voice install']")).not.toBeNull();
  });

  it("shows an install it reopens on", async () => {
    rust.status = { ...rust.status, installing: POLISH };
    await render("card", "polish");
    expect(host.querySelector('[role=progressbar][aria-label="Local polish install"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Studio voice install"]')).toBeNull();
    expect(button("Install the studio voice (3.1 GB)")!.disabled).toBe(true);
  });

  it("waits while a voice install it reopens on runs", async () => {
    rust.status = { ...rust.status, installing: EIGHT };
    await render("polish");
    expect(button("Install local polish (1.7 GB)")!.disabled).toBe(true);
  });

  it("puts what this Mac lacks for it in its own words", async () => {
    rust.polishPreflight = { ...rust.polishPreflight, blockers: ["ram"], ramBytes: 4e9 };
    await render("card", "polish");
    expect(polishRow()).toContain("Needs 8.0 GB of memory; this Mac has 4.0 GB.");
    expect(button("Install local polish (1.7 GB)")!.disabled).toBe(true);
    expect(button("Install the studio voice (3.1 GB)")!.disabled).toBe(false);
  });

  it("removes only local polish, after asking", async () => {
    rust.status = { ...rust.status, installed: true, runtimeCurrent: true, models: { [EIGHT]: {}, [POLISH]: {} } };
    await render("card", "polish");
    await act(async () => button("Remove local polish…")!.click());
    expect(host.textContent).toContain("Remove local polish (1.7 GB)?");
    expect(button("Remove the studio voice…")).toBeDefined();
    const confirm = host.querySelector<HTMLButtonElement>('[aria-label="Remove local polish"] button')!;
    expect(confirm.textContent).toBe("Remove");
    await act(async () => confirm.click());
    expect(rust.calls).toContainEqual(["tts_studio", { op: "remove", args: { polish: true } }]);
    expect(ops().filter((o) => o === "remove")).toHaveLength(1);
  });

  it("says what stays: the runtime goes with the last of the voice and local polish", async () => {
    rust.status = { ...rust.status, installed: true, runtimeCurrent: true, models: { [EIGHT]: {}, [POLISH]: {} } };
    await render("card", "polish");
    await act(async () => button("Remove the studio voice…")!.click());
    expect(host.textContent).toContain("Remove the studio voice? Local polish stays.");
    act(() => root.unmount());
    root = createRoot(host);
    rust.status = { ...rust.status, installed: false, models: { [POLISH]: {} } };
    await render("polish");
    await act(async () => button("Remove local polish…")!.click());
    expect(host.textContent).toContain("Remove local polish and everything it downloaded?");
  });

  it("credits what it downloads, apart from the voice", async () => {
    await render("card", "polish");
    const [voice, polish] = [...host.querySelectorAll("details")].map((d) => d.textContent!);
    expect(voice).toContain("Qwen3-TTS by the Qwen team (Alibaba Cloud, Apache-2.0)");
    expect(voice).toContain("GCC runtime libraries (GPL-3.0-or-later with the GCC runtime library exception)");
    expect(voice).toContain("libquadmath (LGPL-2.1-or-later)");
    expect(voice).toContain("BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0");
    expect(voice).not.toContain("Qwen3.5");
    expect(polish).toContain("Qwen3.5-2B by the Qwen team (Apache-2.0)");
    expect(polish).toContain("mlx-lm (MIT) with Jinja2 and MarkupSafe (BSD-3-Clause)");
    expect(polish).toContain("VOICE_ENGINE_NOTICES.md");
  });
});
