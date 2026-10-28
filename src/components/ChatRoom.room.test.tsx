// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { turn, calls, contextReply, markdownRenders, readAloud } = vi.hoisted(() => ({
  readAloud: {
    speaking: false,
    stop: () => {},
    warm: vi.fn(),
    onFallback: null as ((note: string | null) => void) | null,
  },
  turn: { messages: [] as { id: string; role: string; body: string; status: string }[], queue: [], liveText: "", status: "idle", startedAt: null, loaded: true,
    send: vi.fn(), cancel: vi.fn(), unqueue: vi.fn(), meter: null, activity: [], meters: {} },
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  contextReply: { value: null as unknown },
  markdownRenders: { count: 0 },
}));
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: () => turn }));
vi.mock("../hooks/useStickToBottom", () => ({ useStickToBottom: () => ({ ref: { current: null }, onScroll: () => {}, stick: () => {} }) }));
vi.mock("../audio/useReadAloud", () => ({
  useReadAloud: (o: { onFallback?: (note: string | null) => void }) => {
    readAloud.onFallback = o.onFallback ?? null;
    return readAloud;
  },
}));
vi.mock("../lib/dictationComposer", () => ({ useDictationComposer: () => ({ listening: false, toggle: () => {} }) }));
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
vi.mock("./StreamingText", () => ({ StreamingText: ({ text, room }: { text: string; room?: boolean }) => <div data-streaming data-room={String(!!room)}>{text}</div> }));
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
    onClose={() => {}} {...props} />));
}
const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === label);

describe("reading replies aloud", () => {
  it("starts the voice engine on a hover or a press that turns it on, never on mount", async () => {
    readAloud.warm.mockClear();
    await render();
    expect(readAloud.warm).not.toHaveBeenCalled();
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Read replies aloud"]')!;
    await act(async () => toggle.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(readAloud.warm).toHaveBeenCalledTimes(1);
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(readAloud.warm).toHaveBeenCalledTimes(2);
    expect(toggle.getAttribute("style")).toContain("border: 1px solid var(--color-info)");
    // Turning it off is no intent to hear anything — and the toggle goes
    // back to its rule, not to a border with no colour.
    await act(async () => toggle.click());
    expect(readAloud.warm).toHaveBeenCalledTimes(2);
    expect(toggle.getAttribute("style")).toContain("border: 1px solid var(--color-rule)");
    expect(toggle.style.color).toBe("var(--color-ink)");
  });
});

describe("the chat as a brainstorm room", () => {
  it("reads at plate scale only when the room has the whole plate", async () => {
    await render();
    expect(Array.from(host.querySelectorAll("[data-md]")).map(el => el.getAttribute("data-room"))).toEqual(["false", "false"]);
    expect(host.querySelector("[data-chat-room]")!.hasAttribute("data-room")).toBe(false);

    await render({ expanded: true });
    expect(Array.from(host.querySelectorAll("[data-md]")).map(el => el.getAttribute("data-room"))).toEqual(["true", "true"]);
    expect(host.querySelector("[data-chat-room]")!.getAttribute("data-room")).toBe("true");
    // The user's turn is a card with no byline; the reply is prose under its
    // provider's name, both at plate scale.
    const user = host.querySelector<HTMLElement>("[data-user-turn]")!;
    const reply = host.querySelector<HTMLElement>('[data-reply="settled"]')!;
    expect(user.className).toBe("rl-user-turn");
    expect(user.getAttribute("data-room")).toBe("true");
    expect(user.textContent).not.toMatch(/\bYou\b/);
    expect(reply.getAttribute("data-room")).toBe("true");
    expect(reply.querySelector(".rl-reply-byline")?.textContent).toBe("Claude");
    expect(host.querySelector<HTMLElement>("[data-chat-messages] > div")!.style.maxWidth).toBe("768px");
    expect(host.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea")!.style.fontSize).toBe("15px");

    turn.status = "streaming";
    await render({ expanded: true });
    expect(host.querySelector("[data-streaming]")!.getAttribute("data-room")).toBe("true");
  });

  it("reaches the raw stream from a reply still streaming, a new thread's first included", async () => {
    turn.messages = [{ id: "u1", role: "user", body: "Should the chat be warm?", status: "complete" }];
    turn.status = "streaming";
    await render();
    expect(host.querySelector('[data-reply="live"] [data-reply-tail] [aria-label="More for this reply"]')).not.toBeNull();
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
  // A read-aloud reply the studio voice's stand-in reads says why on the
  // notice line, and only until the studio voice reads again.
  it("clears the studio voice's stand-in note when it speaks again, and no other notice", async () => {
    await render();
    const note = () => host.querySelector(".rl-thread-note")?.textContent ?? null;
    await act(async () => readAloud.onFallback!("Studio voice warming · Kokoro reading"));
    expect(note()).toBe("Studio voice warming · Kokoro reading");
    await act(async () => readAloud.onFallback!(null));
    expect(note()).toBeNull();
    await act(async () => readAloud.onFallback!("Memory tight · Kokoro reading"));
    const steered = "Interrupted the previous turn and sent your instruction next";
    Object.assign(turn, { steerNotice: steered });
    await render();
    // Another notice took its place: the studio voice speaking leaves it.
    await act(async () => readAloud.onFallback!(null));
    expect(note()).toBe(steered);
    Object.assign(turn, { steerNotice: undefined });
  });
});
