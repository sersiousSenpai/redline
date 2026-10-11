// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const { handlers, status } = vi.hoisted(() => ({
  handlers: new Map<string, Set<Handler>>(),
  status: { inFlight: true },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (ev: string, fn: Handler) => {
    const set = handlers.get(ev) ?? new Set<Handler>();
    set.add(fn);
    handlers.set(ev, set);
    return () => set.delete(fn);
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === "voice_session_status" ? { up: true, ...status, generation: 1, turn: 1 } : null,
  ),
}));

import { invoke } from "@tauri-apps/api/core";
import { DiscussPill } from "./DiscussPill";
import { getVoiceAway, setVoiceAway } from "../audio/voiceAway";
import { captionFor, voiceCaption } from "../audio/voiceCaption";
import { CAPTION_MAX, captionBox } from "./DiscussCaption";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const emit = (ev: string, payload: unknown) =>
  act(async () => {
    for (const fn of handlers.get(ev) ?? []) fn({ payload });
  });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

let root: Root;
let host: HTMLDivElement;
const onClick = vi.fn();
const pill = () => host.querySelector("button")!;
const badge = () => host.querySelector(".rl-discuss-badge");

beforeEach(async () => {
  handlers.clear();
  status.inFlight = true;
  onClick.mockReset();
  setVoiceAway(null);
  voiceCaption.set(null);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<DiscussPill onClick={onClick} />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("DiscussPill states", () => {
  it("is the plain pill when no voice turn is out", () => {
    expect(badge()).toBeNull();
    expect(pill().getAttribute("aria-label")).toBe("Discuss — talk or type with your agent");
  });

  it("breathes while a turn left running works, then shows a dot when its reply lands", async () => {
    await act(async () => setVoiceAway({ key: "plan-1", state: "thinking" }));
    await settle();
    expect(badge()?.getAttribute("data-state")).toBe("thinking");
    expect(pill().getAttribute("aria-label")).toContain("working on a reply");
    // Another plan's reply is not this one.
    await emit("voice-done", { sessionId: "plan-2" });
    expect(badge()?.getAttribute("data-state")).toBe("thinking");
    await emit("voice-done", { sessionId: "plan-1" });
    expect(badge()?.getAttribute("data-state")).toBe("waiting");
    expect(pill().getAttribute("aria-label")).toContain("a reply is waiting");
  });

  it("catches a reply that landed while the pill was off screen", async () => {
    status.inFlight = false;
    await act(async () => setVoiceAway({ key: "plan-1", state: "thinking" }));
    await settle();
    expect(getVoiceAway()).toEqual({ key: "plan-1", state: "waiting" });
  });

  it("clears when the turn failed, since nothing is waiting", async () => {
    await act(async () => setVoiceAway({ key: "plan-1", state: "thinking" }));
    await settle();
    await emit("voice-error", { sessionId: "plan-1", generation: 1, turn: 1, error: "boom" });
    expect(badge()).toBeNull();
  });

  it("shows only its own conversation's turn", async () => {
    await act(async () => root.render(<DiscussPill onClick={onClick} voiceKey="plan-2" />));
    await act(async () => setVoiceAway({ key: "plan-1", state: "thinking" }));
    await settle();
    expect(badge()).toBeNull();
    expect(pill().getAttribute("aria-label")).toBe("Discuss — talk or type with your agent");
    // …while still following it, so plan-1's own pill has the news later.
    await emit("voice-done", { sessionId: "plan-1" });
    expect(getVoiceAway()).toEqual({ key: "plan-1", state: "waiting" });
    await act(async () => root.render(<DiscussPill onClick={onClick} voiceKey="plan-1" />));
    expect(badge()?.getAttribute("data-state")).toBe("waiting");
  });

  it("stays one button: a click still just opens the panel", async () => {
    await act(async () => setVoiceAway({ key: "plan-1", state: "waiting" }));
    expect(host.querySelectorAll("button")).toHaveLength(1);
    await act(async () => pill().click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("DiscussPill warms the studio voice on a hover", () => {
  const pointer = (type: "pointerover" | "pointerout", pointerType = "mouse", buttons = 0) => {
    const e = new Event(type, { bubbles: true });
    Object.assign(e, { pointerType, buttons });
    act(() => {
      pill().dispatchEvent(e);
    });
  };
  const warms = () => vi.mocked(invoke).mock.calls.filter(([c, a]) => c === "tts_studio" && (a as { op: string }).op === "warm");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("after a 150 ms dwell of the mouse, never for a pass over it", () => {
    pointer("pointerover");
    vi.advanceTimersByTime(100);
    pointer("pointerout");
    vi.advanceTimersByTime(500);
    expect(warms()).toEqual([]);
    pointer("pointerover");
    vi.advanceTimersByTime(150);
    expect(warms()).toHaveLength(1);
  });

  it("not for a touch, nor a drag across it", () => {
    pointer("pointerover", "touch");
    pointer("pointerout", "touch");
    pointer("pointerover", "mouse", 1);
    vi.advanceTimersByTime(500);
    expect(warms()).toEqual([]);
  });
});

describe("DiscussPill springs into a caption of a turn taken with the panel closed", () => {
  const caption = () => document.querySelector<HTMLButtonElement>(".rl-discuss-caption");
  const show = async (patch: Partial<ReturnType<typeof captionFor>>, key = "plan-1") => {
    await act(async () => voiceCaption.set({ ...captionFor(key, "hearing", Date.now()), ...patch }));
    // The caption is a chunk of its own.
    for (let i = 0; i < 20 && !caption(); i++) await settle();
  };

  beforeEach(async () => {
    await act(async () => root.render(<DiscussPill onClick={onClick} voiceKey="plan-1" />));
  });

  it("hears: the waveform and the words, the pill hidden under it", async () => {
    await show({ phase: "hearing", text: "is the replay safe", levels: [0.2, 0.9] });
    expect(caption()?.dataset.phase).toBe("hearing");
    expect(caption()?.textContent).toContain("is the replay safe");
    expect(caption()?.querySelectorAll(".rl-discuss-caption-wave i")).toHaveLength(16);
    expect(pill().hasAttribute("data-captioned")).toBe(true);
  });

  it("thinks: what the agent is doing, in words", async () => {
    await show({ phase: "thinking", activity: { at: 1, kind: "tool", label: "Bash…" } });
    expect(caption()?.textContent).toContain("Reading the plan…");
    expect(caption()?.querySelector(".rl-discuss-caption-mark")).not.toBeNull();
  });

  it("speaks: the sentence being said", async () => {
    await show({ phase: "speaking", text: "Mostly. The risk is a double apply when the panel comes back." });
    expect(caption()?.dataset.phase).toBe("speaking");
    expect(caption()?.textContent).toContain("The risk is a double apply");
  });

  it("is the pill's click, and never takes focus", async () => {
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    await show({ phase: "thinking" });
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    caption()!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(caption()!.tabIndex).toBe(-1);
    await act(async () => caption()!.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  it("shows only its own conversation's turn", async () => {
    await show({ phase: "thinking" }, "plan-2");
    expect(caption()).toBeNull();
    expect(pill().hasAttribute("data-captioned")).toBe(false);
  });

  it("shrinks back into the pill once it is over, and springs again for the next turn", async () => {
    await show({ phase: "done", text: "It ships behind a flag." });
    await act(async () => voiceCaption.set(null));
    await settle();
    expect(caption()).toBeNull();
    expect(pill().hasAttribute("data-captioned")).toBe(false);
    await show({ phase: "hearing" });
    expect(caption()).not.toBeNull();
  });

  it("grows up and right out of the pill, at most 420 px and never past its pane", () => {
    const viewport = { width: 1400, height: 900 };
    const pill = { left: 16, bottom: 884, width: 96 };
    expect(captionBox(pill, 1400, viewport)).toEqual({ left: 16, bottom: 16, width: CAPTION_MAX });
    expect(captionBox(pill, 300, viewport).width).toBe(300 - 8 - 16);
    // A pane narrower than the pill itself: the pill's width, never less.
    expect(captionBox(pill, 60, viewport).width).toBe(96);
  });
});
