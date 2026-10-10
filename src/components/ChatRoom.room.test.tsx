// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { turn, calls, contextReply, markdownRenders } = vi.hoisted(() => ({
  turn: { messages: [] as { id: string; role: string; body: string; status: string }[], liveText: "", status: "idle", startedAt: null, loaded: true,
    send: vi.fn(), cancel: vi.fn(), unqueue: vi.fn(), meter: null, activity: [], meters: {} },
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  contextReply: { value: null as unknown },
  markdownRenders: { count: 0 },
}));
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: () => turn }));
vi.mock("../hooks/useStickToBottom", () => ({ useStickToBottom: () => ({ ref: { current: null }, onScroll: () => {}, stick: () => {} }) }));
vi.mock("../audio/useReadAloud", () => ({ useReadAloud: () => ({ speaking: false, stop: () => {} }) }));
vi.mock("../lib/useDictation", () => ({ useDictation: () => ({ listening: false, partial: "", toggle: () => {} }) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "companion_context") return contextReply.value;
    return cmd === "companion_list" || cmd === "companion_graduations" ? [] : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./MarkdownView", () => ({
  MarkdownView: ({ body, room, compact }: { body: string; room?: boolean; compact?: boolean }) => {
    markdownRenders.count++;
    return <div data-md data-room={String(!!room)} data-compact={String(!!compact)}>{body}</div>;
  },
}));
vi.mock("./StreamingBubble", () => ({ default: ({ text, room }: { text: string; room?: boolean }) => <div data-streaming data-room={String(!!room)}>{text}</div> }));
import { ChatRoom, type ChatRoomProps } from "./ChatRoom";
import { writeSharedDraft } from "../hooks/useSharedDraft";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
  contextReply.value = null;
  turn.status = "idle";
  turn.messages = [
    { id: "u1", role: "user", body: "Should the chat be warm?", status: "complete" },
    { id: "a1", role: "assistant", body: "Yes: keep a warm child per room.", status: "complete" },
  ];
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function render(props: Partial<ChatRoomProps> = {}) {
  await act(async () => root.render(<ChatRoom companionId="chat-1" cwd="/Users/me/redline" onSelectChat={() => {}} onEmpty={() => {}}
    dictationEnabled={false} onClose={() => {}} {...props} />));
}
const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === label);

describe("the chat as a brainstorm room", () => {
  it("reads at plate scale only when the room has the whole plate", async () => {
    await render();
    expect(Array.from(host.querySelectorAll("[data-md]")).map(el => el.getAttribute("data-room"))).toEqual(["false", "false"]);
    expect(host.querySelector("[data-chat-room]")!.hasAttribute("data-room")).toBe(false);

    await render({ expanded: true });
    expect(Array.from(host.querySelectorAll("[data-md]")).map(el => el.getAttribute("data-room"))).toEqual(["true", "true"]);
    expect(host.querySelector("[data-chat-room]")!.getAttribute("data-room")).toBe("true");
    // The user's turn is a right-aligned tinted block; the reply is prose.
    const user = host.querySelector<HTMLElement>('[data-chat-turn="user"]')!;
    const reply = host.querySelector<HTMLElement>('[data-chat-turn="assistant"]')!;
    expect(user.style.alignSelf).toBe("flex-end");
    expect(reply.style.alignSelf).toBe("");
    expect(host.querySelector<HTMLElement>("[data-chat-messages] > div")!.style.maxWidth).toBe("820px");
    expect(host.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea")!.style.fontSize).toBe("15px");

    turn.status = "streaming";
    await render({ expanded: true });
    expect(host.querySelector("[data-streaming]")!.getAttribute("data-room")).toBe("true");
  });

  it("lists what the last turn injected in a collapsible Context chip", async () => {
    contextReply.value = {
      companionId: "chat-1", delivery: "delta", briefBytes: 900, memory: "Found 2 notes", at: 1,
      brief: {
        plans: [{ sessionId: "s-7", title: "Warm chat", project: "redline", status: "approved · not built", day: "2026-10-02" }],
        repos: [{ name: "redline", path: "/r", branch: "feature/run-it-batch", dirty: 3 }],
        readyCount: 4, ready: ["Ship it"], pages: [], decisions: [], mission: null,
      },
    };
    const onOpenPlan = vi.fn();
    await render({ onOpenPlan });
    const chip = host.querySelector<HTMLButtonElement>("[data-chat-context] button")!;
    expect(chip.textContent).toContain("Context· 1 plan · 1 repo · 4 ready · memory");
    expect(host.querySelector("[data-chat-context-panel]")).toBeNull();
    await act(async () => chip.click());
    const panel = host.querySelector("[data-chat-context-panel]")!;
    expect(panel.textContent).toContain("only what changed");
    expect(panel.textContent).toContain("feature/run-it-batch · 3 changed files");
    await act(async () => button("Warm chat")!.click());
    expect(onOpenPlan).toHaveBeenCalledWith("s-7");
  });

  it("captures a reply through the existing commands", async () => {
    const onDraft = vi.fn(), onPlan = vi.fn();
    await render({ onDraft, onPlan });
    expect(host.querySelectorAll("[data-reply-actions]").length).toBe(1);

    await act(async () => button("Save idea")!.click());
    const note = calls.find(c => c.cmd === "memory_note_write")!;
    const text = (note.args.write as { text: string }).text;
    expect(text).toContain("[chat:chat-1]");
    expect(text).toContain("project redline");
    expect(text).toContain("Yes: keep a warm child per room.");
    expect(button("Saved ✓")).toBeDefined();

    await act(async () => button("→ Draft")!.click());
    expect(onDraft).toHaveBeenCalledWith("Yes: keep a warm child per room.");

    await act(async () => button("→ Plan")!.click());
    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(onPlan.mock.calls[0][0].instruction).toContain("Yes: keep a warm child per room.");
  });

  // The card's composer is the room's input, and the room reads its sentence:
  // a keystroke re-renders the room, but the settled transcript sits it out.
  it("re-renders no settled reply while the card's composer is typed in", async () => {
    let composerRenders = 0;
    await render({ onPlan: vi.fn(), onDraft: vi.fn(), composer: { draftKey: "test.roomDraft", render: () => { composerRenders++; return null; } } });
    const settled = { markdown: markdownRenders.count, composer: composerRenders };
    for (const draft of ["W", "Wh", "Why warm?"]) await act(async () => writeSharedDraft("test.roomDraft", draft));
    expect(composerRenders).toBe(settled.composer + 3);
    expect(markdownRenders.count).toBe(settled.markdown);
    expect(host.querySelectorAll("[data-reply-actions]").length).toBe(1);
  });

  it("warms the room's agent on mount and lets it go on unmount", async () => {
    await render({ harness: { backend: "claude-code", model: null, effort: null } });
    expect(calls.find(c => c.cmd === "companion_prewarm")?.args).toMatchObject({ companionId: "chat-1", cwd: "/Users/me/redline" });
    await act(async () => root.unmount());
    expect(calls.some(c => c.cmd === "companion_release" && c.args.companionId === "chat-1")).toBe(true);
    root = createRoot(host);

    calls.length = 0;
    await render({ harness: { backend: "codex", model: null, effort: null } });
    expect(calls.some(c => c.cmd === "companion_prewarm")).toBe(false);
  });
});
