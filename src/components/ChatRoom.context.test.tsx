// SPDX-License-Identifier: Apache-2.0
// What the Redline card attaches to a chat travels out of band: `contextFor`
// is read per send and reaches `companion_send` as `context`, while the bubble
// is only what was typed. These pin the room's half of that contract.
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
vi.mock("../lib/useDictation", () => ({ useDictation: () => ({ listening: false, partial: "", toggle: () => {} }) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => (cmd === "companion_list" || cmd === "companion_graduations" ? [] : null),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => { listeners.set(event, handler); return () => listeners.delete(event); },
}));
vi.mock("./MarkdownView", () => ({ MarkdownView: ({ body }: { body: string }) => <div>{body}</div> }));
vi.mock("./StreamingBubble", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));
import { ChatRoom, type ChatRoomProps, type ChatWorkbenchComposer } from "./ChatRoom";

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

const PLAN = "## Context — This plan (v3, Warm chat)\n\nPlan session: s-7\n\n# Warm chat";

async function render(props: Partial<ChatRoomProps> = {}, typed = "is this sound?") {
  await act(async () => root.render(<ChatRoom companionId="chat-1" cwd="/Users/me/redline" onSelectChat={() => {}} onEmpty={() => {}}
    dictationEnabled={false} onClose={() => {}}
    composer={{ text: typed, onTextChange: () => {}, render: (_actions, wb) => { workbench = wb; return null; } }}
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
    const contextFor = vi.fn(async () => PLAN);
    await render({ contextFor });
    const { text, opts } = await submit();
    expect(opts.localBody).toBe("is this sound?");
    expect(text).not.toContain("Plan session");
    // Read as the send goes out, not when the room rendered.
    expect(contextFor).not.toHaveBeenCalled();
    const args = await cfg.current!.buildSendArgs(text, opts.extra);
    expect(contextFor).toHaveBeenCalledTimes(1);
    expect(args).toMatchObject({ companionId: "chat-1", text: "is this sound?", mode: "chat", context: PLAN });
  });

  it("attaches nothing without a source, or when the read fails", async () => {
    await render();
    let args = await cfg.current!.buildSendArgs("hi", { mode: "chat" });
    expect(args.context).toBeNull();

    await render({ contextFor: () => Promise.reject(new Error("snapshot timed out")) });
    args = await cfg.current!.buildSendArgs("hi", { mode: "chat" });
    expect(args.text).toBe("hi");
    expect(args.context).toBeNull();
  });

  it("sends the seed with the attachment read when it left the card", async () => {
    const contextFor = vi.fn(async () => "a later read");
    await render({ seed: "what about the beta?", seedId: "seed-1", seedContext: PLAN, contextFor }, "");
    const [text, opts] = lastSend();
    expect(text).toBe("what about the beta?");
    const args = await cfg.current!.buildSendArgs(text, (opts as { extra?: unknown }).extra);
    expect(args.context).toBe(PLAN);
    expect(contextFor).not.toHaveBeenCalled();
  });

  it("a seed with nothing attached stays empty-handed", async () => {
    const contextFor = vi.fn(async () => PLAN);
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
    const remove = () => host.querySelector<HTMLButtonElement>('[aria-label="Delete and now?"]')!;
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
