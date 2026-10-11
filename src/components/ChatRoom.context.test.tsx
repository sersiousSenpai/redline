// SPDX-License-Identifier: Apache-2.0
// What the Redline card attaches to a chat travels out of band: `contextFor`
// is read per send and reaches `companion_send` as `context` and `contextAll`,
// while the bubble is only what was typed. These pin the room's half of that
// contract.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { turn, cfg, listeners } = vi.hoisted(() => ({
  turn: { messages: [] as { id: string; role: string; body: string; status: string }[], liveText: "", status: "idle", startedAt: null, loaded: true,
    send: vi.fn(), cancel: vi.fn(), unqueue: vi.fn(), queue: [] as { id: string; body: string }[], meter: null, activity: [], meters: {} },
  cfg: { current: null as null | {
    buildSendArgs: (text: string, extra?: unknown) => Promise<Record<string, unknown>>;
    onSendFailed?: (text: string, error: unknown) => void;
  } },
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
}));
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: (config: typeof cfg.current) => { cfg.current = config; return turn; } }));
vi.mock("../hooks/useStickToBottom", () => ({ useStickToBottom: () => ({ ref: { current: null }, onScroll: () => {}, stick: () => {} }) }));
vi.mock("../audio/useReadAloud", () => ({ useReadAloud: () => ({ speaking: false, stop: () => {} }) }));
vi.mock("../lib/dictationComposer", () => ({ useDictationComposer: () => ({ listening: false, toggle: () => {} }) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => (cmd === "companion_list" || cmd === "companion_graduations" ? [] : null),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => { listeners.set(event, handler); return () => listeners.delete(event); },
}));
vi.mock("./MarkdownView", () => ({ MarkdownView: ({ body }: { body: string }) => <div>{body}</div> }));
vi.mock("./StreamingText", () => ({ StreamingText: ({ text }: { text: string }) => <div>{text}</div> }));
import { ChatRoom, type ChatRoomProps, type ChatWorkbenchComposer } from "./ChatRoom";
import { hasChildOverlay } from "./MonochatIsland";
import { writeSharedDraft } from "../hooks/useSharedDraft";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
let workbench: ChatWorkbenchComposer | null = null;
beforeEach(() => {
  localStorage.clear();
  listeners.clear();
  cfg.current = null;
  workbench = null;
  turn.send.mockReset();
  turn.unqueue.mockReset();
  turn.queue = [];
  turn.messages = [];
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const DRAFT = "## Context — This draft\n\n# Warm chat\n\nKeep the session warm between turns.";

async function render(props: Partial<ChatRoomProps> = {}, typed = "is this sound?") {
  writeSharedDraft("test.chatComposer", typed);
  await act(async () => root.render(<ChatRoom companionId="chat-1" cwd="/Users/me/redline" onSelectChat={() => {}} onEmpty={() => {}}
    onClose={() => {}}
    composer={{ draftKey: "test.chatComposer", render: (_actions, wb) => { workbench = wb; return null; } }}
    {...props} />));
}
const lastSend = () => turn.send.mock.calls[turn.send.mock.calls.length - 1];
/** Send what is in the composer, and return what the room handed the turn. */
async function submit() {
  await act(async () => workbench!.onSubmit());
  const [text, opts] = lastSend();
  return { text: text as string, opts: opts as { localBody?: string; extra?: unknown } };
}

describe("chat context, out of band", () => {
  it("reads the card's chips per send and passes them as `context`, never in the bubble", async () => {
    const contextFor = vi.fn(async () => ({ context: DRAFT }));
    await render({ contextFor });
    const { text, opts } = await submit();
    expect(opts.localBody).toBe("is this sound?");
    expect(text).not.toContain("Keep the session warm");
    // Read as the send goes out, not when the room rendered.
    expect(contextFor).not.toHaveBeenCalled();
    const args = await cfg.current!.buildSendArgs(text, opts.extra);
    expect(contextFor).toHaveBeenCalledTimes(1);
    expect(args).toMatchObject({ companionId: "chat-1", text: "is this sound?", mode: "chat", context: DRAFT, contextAll: null });
  });

  it("passes every pressed chip as `contextAll`, for a send that starts a fresh session", async () => {
    const PAGE = "## Context — This page (Docs)\n\nhttps://docs.test";
    // The draft went out on an earlier turn; this send adds only the page.
    await render({ contextFor: async () => ({ context: PAGE, contextAll: `${DRAFT}\n\n${PAGE}` }) });
    const args = await cfg.current!.buildSendArgs("and now?", { mode: "chat" });
    expect(args).toMatchObject({ context: PAGE, contextAll: `${DRAFT}\n\n${PAGE}` });
  });

  it("attaches nothing without a source, or when the read fails", async () => {
    await render();
    let args = await cfg.current!.buildSendArgs("hi", { mode: "chat" });
    expect(args.context).toBeNull();
    expect(args.contextAll).toBeNull();

    await render({ contextFor: () => Promise.reject(new Error("snapshot timed out")) });
    args = await cfg.current!.buildSendArgs("hi", { mode: "chat" });
    expect(args.text).toBe("hi");
    expect(args.context).toBeNull();
    expect(args.contextAll).toBeNull();
  });

  it("sends the seed with the attachment read when it left the card", async () => {
    const contextFor = vi.fn(async () => ({ context: "a later read" }));
    await render({ seed: "what about the beta?", seedId: "seed-1", seedContext: DRAFT, contextFor }, "");
    const [text, opts] = lastSend();
    expect(text).toBe("what about the beta?");
    const args = await cfg.current!.buildSendArgs(text, (opts as { extra?: unknown }).extra);
    expect(args.context).toBe(DRAFT);
    expect(contextFor).not.toHaveBeenCalled();
  });

  it("a seed with nothing attached stays empty-handed", async () => {
    const contextFor = vi.fn(async () => ({ context: DRAFT }));
    await render({ seed: "hello", seedId: "seed-2", contextFor }, "");
    const [text, opts] = lastSend();
    const args = await cfg.current!.buildSendArgs(text, (opts as { extra?: unknown }).extra);
    expect(args.context).toBeNull();
    expect(contextFor).not.toHaveBeenCalled();
  });

  it("reports an attachment that may never have arrived", async () => {
    const onContextLost = vi.fn();
    await render({ onContextLost });

    // A send that failed before reaching the agent.
    act(() => cfg.current!.onSendFailed?.("is this sound?", new Error("busy")));
    expect(onContextLost).toHaveBeenCalledTimes(1);
    expect(onContextLost).toHaveBeenLastCalledWith("unsent");

    // A queued send pulled back out; one that already advanced is not lost.
    turn.queue = [{ id: "m-queued", body: "and now?" }];
    turn.unqueue.mockResolvedValueOnce("and now?").mockResolvedValueOnce(null);
    await render({ onContextLost });
    await act(async () => host.querySelector<HTMLButtonElement>(".rl-queue-pill")!.click());
    const remove = () => host.querySelector<HTMLButtonElement>('[aria-label="Unqueue and now?"]')!;
    await act(async () => remove().click());
    expect(turn.unqueue).toHaveBeenCalledWith("m-queued");
    expect(onContextLost).toHaveBeenCalledTimes(2);
    expect(onContextLost).toHaveBeenLastCalledWith("unsent");
    await act(async () => remove().click());
    expect(turn.unqueue).toHaveBeenCalledTimes(2);
    expect(onContextLost).toHaveBeenCalledTimes(2);
  });

  it("a fresh CLI session after a reply means the earlier attachments are gone", async () => {
    const onContextLost = vi.fn();
    await render({ onContextLost });
    const emit = (companionId: string, delivery: string) =>
      act(() => listeners.get("companion-context")!({ payload: { companionId, delivery, brief: null } }));

    // Turn one's whole brief is the session that receives the attachment.
    emit("chat-1", "full");
    expect(onContextLost).not.toHaveBeenCalled();

    turn.messages = [
      { id: "u1", role: "user", body: "is this sound?", status: "complete" },
      { id: "a1", role: "assistant", body: "Mostly.", status: "complete" },
    ];
    await render({ onContextLost });
    emit("chat-1", "unchanged");
    emit("chat-1", "delta");
    emit("chat-OTHER", "full");
    expect(onContextLost).not.toHaveBeenCalled();
    // A rotation or a provider handoff starts the session over.
    emit("chat-1", "full");
    expect(onContextLost).toHaveBeenCalledTimes(1);
    expect(onContextLost).toHaveBeenLastCalledWith("fresh-session");
  });
});

// A new chat learns its context during its first turn. The chip that says so
// arrives in the header row and its list hangs over the thread: nothing
// arriving then may push the reply down under the reader.
describe("the Context chip", () => {
  const CONTEXT = {
    companionId: "chat-1", delivery: "full", briefBytes: 900, memory: null, at: 1,
    brief: { plans: [{ sessionId: "s-7", title: "Warm chat", project: "redline", status: "approved", day: "2026-10-02" }], repos: [], readyCount: 0, ready: [], pages: [], decisions: [], mission: null },
  };

  it("arrives in the header mid-turn, and lists over the thread rather than moving it", async () => {
    Object.assign(turn, { status: "streaming", liveText: "Looking at the plan" });
    try {
      await render({}, "");
      const room = host.querySelector("[data-chat-room]")!;
      const before = Array.from(room.children);
      const unmoved = () => {
        const now = Array.from(room.children);
        expect(now.length).toBe(before.length);
        now.forEach((row, i) => expect(row).toBe(before[i]));
      };
      await act(async () => listeners.get("companion-context")!({ payload: CONTEXT }));
      unmoved();
      const chip = host.querySelector<HTMLButtonElement>("[data-chat-context] button")!;
      expect(chip.closest("[data-chat-toolbar]")).not.toBeNull();
      expect(chip.textContent).toBe("Context· 1 plan");

      await act(async () => chip.click());
      const list = host.querySelector<HTMLElement>("[data-chat-context-panel]")!;
      expect(list.closest("[data-chat-toolbar]")).not.toBeNull();
      expect(list.style.position).toBe("absolute");
      unmoved();
      // Open, it is over the room like a menu: the door's paper and the
      // pill's hover card leave the first press and Esc to it.
      expect(hasChildOverlay()).toBe(true);
      // Esc shuts the list and goes no further; a press elsewhere shuts it too.
      const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      await act(async () => list.dispatchEvent(escape));
      expect(escape.defaultPrevented).toBe(true);
      expect(host.querySelector("[data-chat-context-panel]")).toBeNull();
      expect(hasChildOverlay()).toBe(false);
      await act(async () => chip.click());
      await act(async () => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
      expect(host.querySelector("[data-chat-context-panel]")).toBeNull();
    } finally {
      Object.assign(turn, { status: "idle", liveText: "" });
    }
  });

  it("shuts on the first Esc wherever the caret is, before the door hears it", async () => {
    // A click never focuses a button in WebKit, so the caret is still in the
    // composer when the list is open; the door listens on the document.
    await render({}, "");
    await act(async () => listeners.get("companion-context")!({ payload: CONTEXT }));
    await act(async () => host.querySelector<HTMLButtonElement>("[data-chat-context] button")!.click());
    const composer = document.createElement("textarea");
    host.append(composer);
    composer.focus();
    const door = vi.fn();
    document.addEventListener("keydown", door);
    try {
      const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      await act(async () => composer.dispatchEvent(escape));
      expect(host.querySelector("[data-chat-context-panel]")).toBeNull();
      expect(door).not.toHaveBeenCalled();
      // Shut, it leaves the next Esc to the door.
      await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(door).toHaveBeenCalledTimes(1);
      // An IME's Esc cancels its composition, nothing else.
      await act(async () => host.querySelector<HTMLButtonElement>("[data-chat-context] button")!.click());
      await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true })));
      expect(host.querySelector("[data-chat-context-panel]")).not.toBeNull();
    } finally {
      document.removeEventListener("keydown", door);
      composer.remove();
    }
  });
});
