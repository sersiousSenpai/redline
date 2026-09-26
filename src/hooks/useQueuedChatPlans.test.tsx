// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPlanRequest } from "../components/ChatRoom";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { useQueuedChatPlans } from "./useQueuedChatPlans";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let queue: ReturnType<typeof useQueuedChatPlans>;
let streaming: boolean;
let waiting: number;
const ready = vi.fn();
const failed = vi.fn();
const request: ChatPlanRequest = { companionId: "chat-a", messages: [], instruction: "Only the local version", project: { path: "/repo" }, title: "Chat A" };
function Shell({ home }: { home: boolean }) {
  queue = useQueuedChatPlans(ready, failed);
  return home ? <div>Home chat</div> : <div>Browser</div>;
}
beforeEach(() => {
  vi.useFakeTimers();
  streaming = true; waiting = 0;
  ready.mockReset(); failed.mockReset();
  invoke.mockImplementation(async (command: string) => command === "companion_turn_status"
    ? { streaming, queued: Array.from({ length: waiting }) }
    : [{ id: "new-reply", role: "assistant", body: "The finished reply", status: "complete" }]);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
describe("queued chat planning survives navigation", () => {
  it("waits through active and queued replies after Home unmounts, then launches once with fresh history", async () => {
    await act(async () => root.render(<Shell home />));
    await act(async () => queue.arm(request));
    await act(async () => root.render(<Shell home={false} />));
    streaming = false; waiting = 1;
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(ready).not.toHaveBeenCalled();
    waiting = 0;
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(ready).toHaveBeenCalledOnce();
    expect(ready.mock.calls[0][0]).toMatchObject({ ...request, messages: [{ id: "new-reply", body: "The finished reply" }] });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(ready).toHaveBeenCalledOnce();
    expect(queue.queued).toEqual({});
  });
  it("cancel returns the instruction and prevents a later launch", async () => {
    await act(async () => root.render(<Shell home />));
    await act(async () => queue.arm(request));
    let restored: string | null = null;
    await act(async () => { restored = queue.cancel(request.companionId); });
    expect(restored).toBe(request.instruction);
    streaming = false;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(ready).not.toHaveBeenCalled();
  });
});
