// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatTurnProgress, { chatProgress, elapsedLabel } from "./ChatTurnProgress";
import { emptyMeter } from "../lib/turnMeter";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
describe("chat progress throughout a long turn", () => {
  it("keeps a meaningful elapsed clock before any text or activity arrives", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    await act(async () => root.render(createElement(ChatTurnProgress, { startedAt: 10_000, activity: [], meter: null, status: null, onStop: () => {} })));
    expect(host.textContent).toContain("Preparing your reply");
    await act(async () => vi.advanceTimersByTime(403_000));
    expect(host.textContent).toContain("6m 43s");
    expect(host.textContent).toContain("No new activity");
  });
  it("shows observed tool work and Stop without exposing tool arguments or reasoning", async () => {
    const stop = vi.fn();
    const activity = [{ at: 1_000, kind: "tool", label: "Reading session history" }];
    await act(async () => root.render(createElement(ChatTurnProgress, { startedAt: 1_000, activity, meter: { ...emptyMeter(), toolCalls: 12, outputTokens: 1000 }, status: null, onStop: stop })));
    expect(host.textContent).toContain("Reading session history");
    expect(host.textContent).toContain("12 tool calls");
    await act(async () => host.querySelector("button")?.click());
    expect(stop).toHaveBeenCalledOnce();
  });
  it("uses fresh model activity over an obsolete retrieval caption and rejects a prior turn caption", () => {
    const activity = [{ at: 10_000, kind: "thinking", label: "Thinking…" }];
    expect(chatProgress(activity, null, { at: 9_000, label: "Old lookup" }, 5_000, 11_000).label).toBe("Thinking…");
    expect(chatProgress([], null, { at: 4_000, label: "Prior turn" }, 5_000, 11_000).label).toBe("Preparing your reply");
  });
  it("keeps progress after early text and does not call a growing reply inactive", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const props = { startedAt: 1_000, activity: [{ at: 2_000, kind: "tool", label: "Grep…" }], meter: null, status: null, onStop: () => {}, textLength: 20 };
    await act(async () => root.render(createElement(ChatTurnProgress, props)));
    expect(host.textContent).toContain("Writing the reply");
    expect(host.textContent).toContain("Searching source files");
    await act(async () => vi.advanceTimersByTime(35_000));
    await act(async () => root.render(createElement(ChatTurnProgress, { ...props, textLength: 200 })));
    expect(host.textContent).not.toContain("No new activity");
    expect(host.querySelector("[data-chat-progress]")).not.toBeNull();
    expect(host.textContent).toContain("Stop");
  });
  it("prioritizes rate limits and bounds the recent tool list", () => {
    const activity = Array.from({ length: 10 }, (_, index) => ({ at: index + 1, kind: "tool", label: `Read ${index}` }));
    const p = chatProgress(activity, { ...emptyMeter(), rateLimited: { status: "limited", resetsAt: null, kind: "usage" } }, { at: 11, label: "Fetching" }, 0, 12);
    expect(p.label).toContain("Rate limited");
    expect(p.recent.map((item) => item.label)).toEqual(["Read 6", "Read 7", "Read 8", "Read 9"]);
    expect(elapsedLabel(-1)).toBe("0s");
  });
});
