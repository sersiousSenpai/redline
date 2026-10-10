// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A chat's read-aloud on the studio voice: the hook takes the studio driver
// (its own chunk) when that is the engine, says why its stand-in reads, and
// counts as a voice surface while reading is on.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { settings, studio } = vi.hoisted(() => ({
  settings: { engine: "studio", studioStyle: "slow" },
  studio: {
    drivers: [] as Array<{ opts: Record<string, unknown>; spoken: string[]; begun: number }>,
    surfaces: [] as Array<[string, boolean]>,
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "tts_get_settings" ? { ...settings } : null)),
}));
vi.mock("./studioTts", () => ({
  studioTtsDriver: (opts: Record<string, unknown>) => {
    const d = { opts, spoken: [] as string[], begun: 0 };
    studio.drivers.push(d);
    return {
      speak: (text: string) => d.spoken.push(text),
      cancel: () => {},
      pause: () => {},
      resume: () => {},
      beginTurn: () => {
        d.begun += 1;
      },
    };
  },
  studioSurface: (surface: string, open: boolean) => studio.surfaces.push([surface, open]),
}));

import { useReadAloud } from "./useReadAloud";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const notes: (string | null)[] = [];
function Chat(props: { enabled: boolean; liveText: string; streaming: boolean }) {
  useReadAloud({ ...props, threadKey: "c-1", onFallback: (n) => notes.push(n) });
  return null;
}
const render = (props: { enabled: boolean; liveText: string; streaming: boolean }) =>
  act(async () => root.render(<Chat {...props} />));
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  studio.drivers.length = 0;
  studio.surfaces.length = 0;
  notes.length = 0;
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
    speak: () => {},
    cancel: () => {},
    pause: () => {},
    resume: () => {},
  };
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("useReadAloud on the studio voice", () => {
  it("reads through the studio driver, in the saved style, and passes its stand-in notes on", async () => {
    await render({ enabled: true, liveText: "", streaming: false });
    await flush();
    await flush();
    expect(studio.drivers).toHaveLength(1);
    const d = studio.drivers[0];
    expect(d.opts.style).toBe("slow");
    (d.opts.onFallback as (n: string | null) => void)("Studio voice stalled · Kokoro finishing");
    expect(notes).toEqual(["Studio voice stalled · Kokoro finishing"]);
    await render({ enabled: true, liveText: "The replay is safe. It", streaming: true });
    expect(d.begun).toBe(1);
    expect(d.spoken).toEqual(["The replay is safe."]);
  });

  it("is a voice surface while reading aloud is on", async () => {
    await render({ enabled: true, liveText: "", streaming: false });
    await flush();
    await flush();
    await flush();
    expect(studio.surfaces.map(([, open]) => open)).toEqual([true]);
    const [name] = studio.surfaces[0];
    expect(name).toMatch(/^read-aloud:c-1:/);
    await render({ enabled: false, liveText: "", streaming: false });
    await flush();
    expect(studio.surfaces).toEqual([
      [name, true],
      [name, false],
    ]);
  });
});
