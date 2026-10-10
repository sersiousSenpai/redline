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

import { DiscussPill } from "./DiscussPill";
import { getVoiceAway, setVoiceAway } from "../audio/voiceAway";

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

  it("stays one button: a click still just opens the panel", async () => {
    await act(async () => setVoiceAway({ key: "plan-1", state: "waiting" }));
    expect(host.querySelectorAll("button")).toHaveLength(1);
    await act(async () => pill().click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
