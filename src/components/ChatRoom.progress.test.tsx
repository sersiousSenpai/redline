// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { turn, cancel } = vi.hoisted(() => {
  const cancel = vi.fn();
  return { cancel, turn: { messages: [], liveText: "", status: "streaming", startedAt: 1_000, loaded: true,
    send: vi.fn(), cancel, unqueue: vi.fn(), meter: null, activity: [], meters: {} } };
});
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: () => turn }));
vi.mock("../hooks/useStickToBottom", () => ({ useStickToBottom: () => ({ ref: { current: null }, onScroll: () => {}, stick: () => {} }) }));
vi.mock("../audio/useReadAloud", () => ({ useReadAloud: () => ({ speaking: false, stop: () => {} }) }));
vi.mock("../lib/useDictation", () => ({ useDictation: () => ({ listening: false, partial: "", toggle: () => {} }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./MarkdownView", () => ({ MarkdownView: () => null }));
vi.mock("./StreamingBubble", () => ({ default: ({ text }: { text: string }) => createElement("div", { "data-reply": true }, text) }));
import { ChatRoom } from "./ChatRoom";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  cancel.mockReset(); turn.liveText = ""; turn.status = "streaming";
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(createElement(ChatRoom, {
  companionId: "chat-1", onSelectChat: () => {}, onEmpty: () => {}, cwd: null,
  dictationEnabled: false, onClose: () => {},
}))); }
describe("Chat room progress placement", () => {
  it("keeps progress and Stop visible after a public progress note arrives, then clears at completion", async () => {
    await render();
    expect(host.querySelector("[data-chat-progress]")).not.toBeNull();
    turn.liveText = "I’m checking the stored session counts.";
    await render();
    expect(host.querySelector("[data-reply]")?.textContent).toContain("stored session counts");
    const progress = host.querySelector("[data-chat-progress]");
    expect(progress).not.toBeNull();
    await act(async () => progress?.querySelector("button")?.click());
    expect(cancel).toHaveBeenCalledOnce();
    turn.status = "idle";
    await render();
    expect(host.querySelector("[data-chat-progress]")).toBeNull();
  });
});
