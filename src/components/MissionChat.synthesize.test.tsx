// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mission } from "../types";

const turn = vi.hoisted(() => ({ messages: [], queue: [], liveText: "", status: "idle", startedAt: null, loaded: true,
  send: vi.fn(), cancel: vi.fn(), unqueue: vi.fn(), meter: null, activity: [], meters: {} }));
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: () => turn }));
vi.mock("./MarkdownView", () => ({ MarkdownView: () => null }));
vi.mock("./StreamingText", () => ({ StreamingText: () => null }));
import { MissionChat } from "./MissionChat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(turn, { status: "idle", loaded: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const mission = { missionId: "m-1", title: "Rate limits", goal: "Compare token buckets", createdAt: 1, updatedAt: 1, status: "active" } as unknown as Mission;
const show = (props: Partial<ComponentProps<typeof MissionChat>>) => act(async () => root.render(
  <MissionChat mission={mission} findings={[]} onClose={() => {}} onRemoveFinding={() => {}} onEditGoal={() => {}} {...props}/>));

describe("a Synthesize asked for from the page chat's goal card", () => {
  it("runs the mission's synthesis turn once the thread is free, and says it started", async () => {
    const started = vi.fn();
    turn.status = "streaming";
    await show({ synthesizeAsked: true, onSynthesizeStarted: started });
    expect(turn.send).not.toHaveBeenCalled();
    turn.status = "idle";
    await show({ synthesizeAsked: true, onSynthesizeStarted: started });
    expect(started).toHaveBeenCalledOnce();
    expect(turn.send).toHaveBeenCalledOnce();
    expect(turn.send.mock.calls[0][0]).toContain("Produce the mission synthesis brief now");
    expect(turn.send.mock.calls[0][1]).toEqual({ localBody: "✦ Synthesize the mission", extra: "synthesize" });
    // Consumed: the panel mounting again does not synthesize again.
    await show({ synthesizeAsked: false, onSynthesizeStarted: started });
    expect(turn.send).toHaveBeenCalledOnce();
  });
});
