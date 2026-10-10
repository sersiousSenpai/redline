// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The studio voice's settings card against a scripted `tts_studio`: what it
// costs, what this Mac lacks in words, the install from first byte to "Studio
// voice ready." (cancelled and resumed on the way), the previews, the model,
// and the way back out.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Args = Record<string, unknown>;
const { rust, handlers, samples } = vi.hoisted(() => ({
  rust: {
    calls: [] as Array<[string, Args]>,
    status: {} as Record<string, unknown>,
    preflight: {} as Record<string, unknown>,
  },
  handlers: new Map<string, Array<(e: { payload: unknown }) => void>>(),
  samples: [] as Array<{ voice: string; text: string; onEnd: (e?: string) => void; stop: () => void }>,
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: vi.fn(async (cmd: string, args: Args = {}) => {
    rust.calls.push([cmd, args]);
    if (args.op === "status") return { ...rust.status };
    if (args.op === "preflight") return { ...rust.preflight };
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

import { StudioVoiceCard, type StudioPrefs } from "./StudioVoiceCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EIGHT = "1.7B-CustomVoice-8bit";
const FOUR = "1.7B-CustomVoice-4bit";
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
async function render() {
  await act(async () =>
    root.render(
      createElement(StudioVoiceCard, {
        prefs,
        onChange: (p: StudioPrefs) => {
          prefs = p;
        },
        onError: (m: string) => errors.push(m),
      }),
    ),
  );
  await flush();
}

beforeEach(() => {
  rust.calls.length = 0;
  rust.status = {
    supported: true,
    model: EIGHT,
    installed: false,
    models: null,
    runtimeCurrent: false,
    state: "off",
    installing: false,
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

  it("saves a model pick at once, since the install fetches it", async () => {
    await render();
    const low = host.querySelectorAll("input[name=studio-model]")[1] as HTMLInputElement;
    await act(async () => low.click());
    expect(rust.calls).toContainEqual(["tts_studio", { op: "prefs", args: { model: FOUR } }]);
    expect(prefs.model).toBe(FOUR);
    await render();
    expect(host.textContent).toContain("Studio voice — 2.3 GB download, about 3.4 GB memory while speaking");
  });

  it("offers only tested styles, and removes the install after asking", async () => {
    rust.status = { ...rust.status, installed: true, runtimeCurrent: true, models: { [EIGHT]: {} } };
    await render();
    const styles = [...host.querySelectorAll("select option")].map((o) => o.textContent);
    expect(styles).toEqual(["Natural", "Calm", "Gentle", "Slow", "Brisk", "Upbeat", "Excited"]);
    await act(async () => button("Remove the studio voice…")!.click());
    expect(ops()).not.toContain("remove");
    await act(async () => button("Remove")!.click());
    expect(ops()).toContain("remove");
  });

  it("credits what it downloads, with the licenses the audit corrected", async () => {
    await render();
    const about = host.querySelector("details")!.textContent!;
    expect(about).toContain("Qwen3-TTS by the Qwen team (Alibaba Cloud, Apache-2.0)");
    expect(about).toContain("GCC runtime libraries (GPL-3.0-or-later with the GCC runtime library exception)");
    expect(about).toContain("libquadmath (LGPL-2.1-or-later)");
    expect(about).toContain("BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0");
  });
});
