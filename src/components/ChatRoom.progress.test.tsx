// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { turn, cancel } = vi.hoisted(() => {
  const cancel = vi.fn();
  return { cancel, turn: { messages: [], queue: [], liveText: "", status: "streaming", startedAt: 1_000, loaded: true,
    send: vi.fn(), cancel, unqueue: vi.fn(), meter: null, activity: [], meters: {} } };
});
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: () => turn }));
vi.mock("../hooks/useStickToBottom", () => ({ useStickToBottom: () => ({ ref: { current: null }, onScroll: () => {}, stick: () => {} }) }));
vi.mock("../audio/useReadAloud", () => ({ useReadAloud: () => ({ speaking: false, stop: () => {} }) }));
vi.mock("../lib/useDictation", () => ({ useDictation: () => ({ listening: false, partial: "", toggle: () => {} }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./MarkdownView", () => ({ MarkdownView: () => null }));
vi.mock("./StreamingText", () => ({ StreamingText: ({ text }: { text: string }) => createElement("div", { "data-streaming": true }, text) }));
import { ChatRoom } from "./ChatRoom";
import { writeSharedDraft } from "../hooks/useSharedDraft";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  cancel.mockReset(); turn.liveText = ""; turn.status = "streaming"; turn.startedAt = Date.now();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(createElement(ChatRoom, {
  companionId: "chat-1", onSelectChat: () => {}, onEmpty: () => {}, cwd: null,
  onClose: () => {},
}))); }
const primary = () => host.querySelector<HTMLButtonElement>("[data-chat-composer] .rl-send")!;
describe("Chat room progress placement", () => {
  it("says what the turn is doing in the reply's tail and stops it from the composer's one button", async () => {
    await render();
    expect(host.querySelector("[data-chat-progress]")).toBeNull();
    const tail = () => host.querySelector("[data-reply] [data-reply-tail]");
    expect(tail()?.querySelector("[role=status]")?.textContent).toBe("Preparing your reply");
    turn.liveText = "I’m checking the stored session counts.";
    await render();
    expect(host.querySelector("[data-streaming]")?.textContent).toContain("stored session counts");
    expect(tail()?.querySelector("[role=status]")?.textContent).toBe("Writing the reply");
    // An empty box while the reply runs: the one button is Stop.
    expect(primary().dataset.send).toBe("stop");
    expect(primary().disabled).toBe(false);
    await act(async () => primary().click());
    expect(cancel).toHaveBeenCalledOnce();
    // Text in the box makes it Queue, in the same slot, the field untouched.
    const field = host.querySelector("[data-chat-composer] textarea")!;
    await act(async () => writeSharedDraft("rl.chatDraft.chat-1", "and then?"));
    expect(primary().dataset.send).toBe("queue");
    expect(host.querySelector("[data-chat-composer] textarea")).toBe(field);
    expect((field as HTMLTextAreaElement).disabled).toBe(false);
    turn.status = "idle";
    await render();
    expect(host.querySelector("[data-reply] [role=status]")).toBeNull();
    expect(primary().dataset.send).toBe("send");
  });
});
