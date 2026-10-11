// SPDX-License-Identifier: Apache-2.0
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowseMessage } from "../types";
const { turn, invokeMock, config, captureMock, dictation, markdown } = vi.hoisted(() => ({
  dictation: { listening: false, toggle: vi.fn() },
  markdown: { renders: 0 },
  config: { current: null as null | {
    buildSendArgs: (text: string) => Promise<Record<string, unknown>>;
    onSent?: (args: Record<string, unknown>, outcome?: { started: boolean; queued: boolean; messageId: string }) => void;
    makeMessage: (seed: { id: string; role: "user" | "assistant"; body: string; status: "complete" | "error"; backend?: string }) => BrowseMessage;
  } },
  captureMock: vi.fn(async (label: string) => `snapshot:${label}`),
  // The preflight probe finds a ready Codex: a Codex last pick is inherited
  // only when this machine can run it.
  invokeMock: vi.fn(async (cmd?: string): Promise<unknown> => cmd === "preflight_status"
    ? { codex: { found: true, usable: true, signedIn: true, authState: "signed-in" }, hook: {}, skill: {} }
    : []),
  turn: { messages: [] as BrowseMessage[], queue: [] as BrowseMessage[], liveText: "", status: "idle", startedAt: null as number | null, loaded: true,
    send: vi.fn(), cancel: vi.fn(), unqueue: vi.fn(async (_id: string): Promise<string | null> => null), clear: vi.fn(), meter: null,
    activity: null as null | { at: number; kind: string; label: string }[], meters: {} as Record<string, unknown> },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../lib/dictationComposer", async (actual) => ({
  ...(await actual<typeof import("../lib/dictationComposer")>()),
  useDictationComposer: () => ({ listening: dictation.listening, toggle: dictation.toggle }),
}));
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: (options: typeof config.current) => { config.current = options; return turn; } }));
vi.mock("../lib/domSnapshot", () => ({ captureSnapshotOrCached: captureMock }));
vi.mock("./MarkdownView", () => ({ MarkdownView: () => { markdown.renders++; return null; } }));
vi.mock("./StreamingText", () => ({ StreamingText: ({ text, className }: { text: string; className?: string }) => <div className={className}>{text}</div> }));
import { BrowserChat } from "./BrowserChat";
import { placeText, targetFor } from "../audio/dictationTarget";
import { writeSharedDraft } from "../hooks/useSharedDraft";
import type { ResolvedConversation } from "../lib/browserChat/scope";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); turn.messages = []; turn.queue = []; turn.status = "idle"; turn.liveText = ""; turn.activity = null; turn.meters = {};
  // Drafts live in a store shared across mounts, and so across tests.
  for (const key of ["rl.chatDraft.browse.thread", "rl.chatChips.browse.thread"]) writeSharedDraft(key, "");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || (item.querySelector(".rb-menu-label") ?? item).textContent === label);
  expect(match, `button ${label}`).toBeDefined();
  return match!;
}
async function click(label: string) { await act(async () => button(label).click()); }
/** A tab's own chat on the page it is about, as the structure layer resolves it. */
const tabChat = (over: Partial<ResolvedConversation> = {}): ResolvedConversation => ({
  kind: "tab", browseId: "thread", title: "Source page", targetLabel: "browser-page", targetBrowseId: "page", targetTitle: "Source page", targetNumber: 1,
  scope: "pinned-page", anchoredFrom: null, exception: false, ...over,
});
const sharedChat = (over: Partial<ResolvedConversation> = {}) => tabChat({ kind: "shared", title: "Browser chat", scope: "following-tabs", ...over });
const chat = (props: Partial<ComponentProps<typeof BrowserChat>> = {}) =>
  <BrowserChat conversation={tabChat()} workspace="regular" onClose={() => {}} {...props}/>;
const show = (props: Partial<ComponentProps<typeof BrowserChat>> = {}) => act(async () => root.render(chat(props)));
/** One send as the turn hook makes it: build the args, and on success tell the chat. */
async function sendTurn(text: string) {
  const args = await config.current!.buildSendArgs(text);
  config.current!.onSent?.(args);
  return args;
}
describe("the transcript while a reply streams", () => {
  it("re-renders the live reply per delta and no settled message", async () => {
    turn.messages = [
      { id: "u1", browseId: "thread", role: "user", body: "What does it cost?", status: "complete", createdAt: 1 },
      { id: "a1", browseId: "thread", role: "assistant", body: "Prior answer", status: "complete", createdAt: 2 },
      { id: "u2", browseId: "thread", role: "user", body: "And yearly?", status: "complete", createdAt: 3 },
    ];
    Object.assign(turn, { status: "streaming", liveText: "It" });
    const onClose = () => {};
    await show({ onClose });
    const settled = markdown.renders;
    expect(settled).toBe(3);
    for (const text of ["It is", "It is $8", "It is $8 a seat"]) {
      turn.liveText = text;
      await show({ onClose, linkedMode: text.length % 2 === 0 });
    }
    expect(host.querySelector('[data-reply="live"]')?.textContent).toContain("It is $8 a seat");
    expect(markdown.renders).toBe(settled);
  });
});

describe("page conversation header", () => {
  it("re-grounds a shared conversation when the targeted page changes", async () => {
    turn.messages = [{ id: "prior", browseId: "thread", role: "assistant", body: "Prior answer", status: "complete", createdAt: 1 }];
    await show({ conversation: sharedChat({ targetLabel: "browser-a" }) });
    expect(await sendTurn("First question")).toMatchObject({ targetLabel: "browser-a", followingTabs: true, snapshot: "snapshot:browser-a" });
    const followUp = await sendTurn("Follow-up");
    expect(followUp).toMatchObject({ targetLabel: "browser-a" });
    expect(followUp).not.toHaveProperty("snapshot");
    await show({ conversation: sharedChat({ targetLabel: "browser-b" }) });
    expect(await sendTurn("Compare this page")).toMatchObject({ targetLabel: "browser-b", snapshot: "snapshot:browser-b" });
    expect(captureMock.mock.calls.map(([label]) => label)).toEqual(["browser-a", "browser-b"]);
  });

  it("keeps the page each row was about, and pins a reply to that page after you move on (BC-24)", async () => {
    await show({ conversation: sharedChat({ targetLabel: "browser-a", targetBrowseId: "a" }) });
    // Yours is about the page you send against…
    expect(config.current!.makeMessage({ id: "u", role: "user", body: "Hi", status: "complete" }).targetBrowseId).toBe("a");
    await sendTurn("What is on this page?");
    // …and the reply about the page its turn was sent against, though the
    // chat now follows another tab.
    turn.status = "streaming";
    await show({ conversation: sharedChat({ targetLabel: "browser-b", targetBrowseId: "b" }) });
    expect(config.current!.makeMessage({ id: "r", role: "assistant", body: "A table", status: "complete" }).targetBrowseId).toBe("a");
    turn.status = "idle";
    const pin = vi.fn(async () => true);
    turn.messages = [{ id: "r", browseId: "thread", role: "assistant", body: "A table", status: "complete", createdAt: 1, targetBrowseId: "a" }];
    await show({ conversation: sharedChat({ targetLabel: "browser-b", targetBrowseId: "b" }), onAddToMission: pin });
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Pin this reply to the active mission"]')!.click());
    expect(pin).toHaveBeenCalledWith("A table", "a");
  });

  it("re-grounds the turn after a send that never reached the backend", async () => {
    turn.messages = [{ id: "prior", browseId: "thread", role: "assistant", body: "Prior answer", status: "complete", createdAt: 1 }];
    await show({ conversation: sharedChat({ targetLabel: "browser-a" }) });
    // Built, but the backend never took it: no onSent.
    expect(await config.current!.buildSendArgs("Lost question")).toMatchObject({ snapshot: "snapshot:browser-a" });
    expect(await sendTurn("Asked again")).toMatchObject({ snapshot: "snapshot:browser-a" });
    expect(await sendTurn("Follow-up")).not.toHaveProperty("snapshot");
  });
  it("draws one header row: what it follows, ⋯ and ×, with the chat switch and the rest in ⋯", async () => {
    const research = vi.fn(), close = vi.fn(), toggle = vi.fn();
    await show({ onClose: close, onToggleTabChat: toggle, onResearch: research });
    const header = host.querySelector("[data-browser-chat-header]")!;
    expect(header.textContent).toContain("Source page");
    expect([...header.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Conversation actions", "Close discussion"]);
    // The thread comes straight after it: no second row.
    expect(header.nextElementSibling?.matches("[data-browser-chat-messages]")).toBe(true);
    expect(host.textContent).not.toContain("This tab’s own chat");
    const composer = host.querySelector("textarea");
    await click("Conversation actions");
    expect([...document.querySelector('[role="menu"]')!.children].map(row => row.textContent)).toEqual(["Open the shared chat", "Start a research mission", "Text sizeA−A+", "Show the raw stream", "Clear history"]);
    expect(button("Clear history").disabled).toBe(true);
    await click("Larger text"); expect(localStorage.getItem("redline.browseZoom")).toBe("1.1");
    // A tab's own chat offers the way to the shared one.
    await click("Open the shared chat"); expect(toggle).toHaveBeenCalledOnce();
    await click("Conversation actions");
    await click("Start a research mission"); expect(research).toHaveBeenCalledOnce();
    expect(host.querySelector("textarea")).toBe(composer);
    await click("Close discussion"); expect(close).toHaveBeenCalledOnce();
  });

  it("starts a new chat from the composer with a few things to do and one tip", async () => {
    const research = vi.fn();
    await show({ onResearch: research });
    const empty = host.querySelector("[data-browser-chat-empty]")!;
    expect([...empty.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Summarize this page", "Extract a table", "Start a mission"]);
    expect(empty.querySelector(".rb-tip")?.textContent).toContain("choose Ask");
    await click("Summarize this page");
    expect(turn.send).toHaveBeenCalledWith("Summarize this page.");
    await click("Start a mission"); expect(research).toHaveBeenCalledOnce();
    // Nothing took the caret.
    expect(document.activeElement).not.toBe(host.querySelector("textarea"));
  });

  it("names the page a shared chat is on, never the shared chat itself as where it came from", async () => {
    const toggle = vi.fn();
    await show({ conversation: sharedChat({ targetNumber: 2, targetTitle: "Docs", exception: true }), onToggleTabChat: toggle });
    expect([...host.querySelectorAll("[data-browser-chat-header] .rb-thread-context span")].map(span => span.textContent)).toEqual(["Shared chat", "On tab 2 — Docs"]);
    expect(host.textContent).not.toContain("Following");
    await click("Conversation actions");
    await click("Open this tab’s own chat"); expect(toggle).toHaveBeenCalledOnce();
  });

  it("switches linked mode from the header and marks a tab chat only when it is the exception", async () => {
    const mode = vi.fn();
    await show({ onToggleTabChat: () => {}, onToggleLinkedMode: mode });
    expect(button("Linked mode").getAttribute("aria-pressed")).toBe("false");
    expect(button("Linked mode").textContent).toBe("⛓️‍💥");
    expect(button("Linked mode").title).toContain("each tab opens its own chat");
    await click("Linked mode"); expect(mode).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("This tab’s own chat");
    await show({ conversation: tabChat({ exception: true }), linkedMode: true, onToggleTabChat: () => {}, onToggleLinkedMode: mode });
    expect(button("Linked mode").getAttribute("aria-pressed")).toBe("true");
    expect(button("Linked mode").textContent).toBe("🔗");
    expect(button("Linked mode").title).toContain("stay in the shared chat");
    expect(host.querySelector("[data-browser-chat-header]")?.textContent).toContain("This tab’s own chat");
    await show({ conversation: sharedChat(), linkedMode: true, onToggleTabChat: () => {}, onToggleLinkedMode: mode });
    expect(host.textContent).not.toContain("This tab’s own chat");
    // The header row holds the linked icon, ⋯ and × and nothing else (BC-36).
    expect(host.querySelector("[data-browser-chat-header]")?.querySelectorAll("button")).toHaveLength(3);
  });

  it("clears only this thread through the existing backend action", async () => {
    turn.messages = [{ id: "message", browseId: "thread", role: "user", body: "A prior question", status: "done", createdAt: 1 }];
    await show();
    await click("Conversation actions"); await click("Clear history");
    expect(invokeMock).toHaveBeenCalledWith("browse_discard", { browseId: "thread" });
    expect(turn.clear).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("puts the model picker in the composer's footer as quiet text, and the context in the header row", async () => {
    turn.messages = [{ id: "reply", browseId: "thread", role: "assistant", body: "An answer", status: "complete", createdAt: 1 }];
    await show({ conversation: tabChat({ exception: true, anchoredFrom: "Origin", targetNumber: 3, targetTitle: "Opened" }), linkedMode: true, onToggleTabChat: () => {}, onToggleLinkedMode: () => {} });
    const header = host.querySelector("[data-browser-chat-header]")!;
    expect(header.querySelector('[aria-label="Chat model and effort"]')).toBeNull();
    const picker = host.querySelector('[data-browser-chat-composer] [aria-label="Chat model and effort"]')!;
    expect(picker.hasAttribute("data-quiet")).toBe(true);
    expect([...header.querySelectorAll(".rb-thread-context span")].map(span => span.textContent)).toEqual(["This tab’s own chat", "On tab 3 — Opened", "From Origin"]);
    expect(host.querySelectorAll(".rb-thread-context")).toHaveLength(1);
    // The reply is attributed to the chat's provider.
    expect(host.querySelector("[data-browser-chat-messages]")?.textContent).toContain("Claude");
  });

  it("stores an inherited pick before the first turn, and forgets it with the history", async () => {
    localStorage.setItem("redline.browse.lastHarness", JSON.stringify({ backend: "claude-code", model: "opus", effort: null }));
    await show();
    expect(button("Chat model and effort").textContent).toContain("opus");
    // The hoisted mock is typed without parameters; read its calls as sent.
    const calls = () => invokeMock.mock.calls as unknown as [string, unknown?][];
    const sets = () => calls().filter(([cmd]) => cmd === "browse_thread_set_harness");
    expect(sets()).toEqual([]);
    await act(async () => { await config.current!.buildSendArgs("First question"); });
    expect(sets()).toEqual([["browse_thread_set_harness", { browseId: "thread", backend: "claude-code", model: "opus", effort: null }]]);
    // Stored before the page is captured, so the turn reads it at start.
    const setOrder = invokeMock.mock.invocationCallOrder[calls().findIndex(([cmd]) => cmd === "browse_thread_set_harness")];
    expect(setOrder).toBeLessThan(captureMock.mock.invocationCallOrder[0]);
    await act(async () => { await config.current!.buildSendArgs("Follow-up"); });
    expect(sets()).toHaveLength(1);
    turn.messages = [{ id: "message", browseId: "thread", role: "user", body: "A prior question", status: "complete", createdAt: 1 }];
    await show();
    await click("Conversation actions"); await click("Clear history");
    await act(async () => { await config.current!.buildSendArgs("After clearing"); });
    expect(sets()).toHaveLength(2);
  });

  it("captures the page again while the provider differs from the last reply's", async () => {
    const msg = (id: string, role: string, body: string, backend?: string | null): BrowseMessage => ({ id, browseId: "thread", role, body, status: "complete", createdAt: 1, backend });
    // The last reply came from Codex; the chat is back on Claude (its default).
    turn.messages = [msg("q", "user", "Question"), msg("a", "assistant", "Codex's answer", "codex")];
    await show({ conversation: tabChat({ targetLabel: "browser-a" }) });
    expect(await sendTurn("First on Claude")).toMatchObject({ snapshot: "snapshot:browser-a" });
    expect(await sendTurn("Sent again before a reply")).toMatchObject({ snapshot: "snapshot:browser-a" });
    // Once Claude has answered, a follow-up is just a follow-up.
    turn.messages = [...turn.messages, msg("b", "assistant", "Claude's answer", "claude-code")];
    await show({ conversation: tabChat({ targetLabel: "browser-a" }) });
    expect(await sendTurn("Follow-up")).not.toHaveProperty("snapshot");
    // A reply from before Codex page chats was Claude's.
    turn.messages = [msg("old", "assistant", "An old answer")];
    await show({ conversation: tabChat({ targetLabel: "browser-a" }) });
    expect(await sendTurn("Follow-up")).not.toHaveProperty("snapshot");
    expect(captureMock).toHaveBeenCalledTimes(2);

    // A chat now on Codex after Claude's replies: Codex needs the page too.
    await act(async () => root.unmount());
    localStorage.setItem("redline.browse.lastHarness", JSON.stringify({ backend: "codex", model: null, effort: null }));
    root = createRoot(host);
    await show({ conversation: tabChat({ targetLabel: "browser-a" }) });
    await act(async () => { await sendTurn("Prime the label"); });
    expect(await sendTurn("First on Codex")).toMatchObject({ snapshot: "snapshot:browser-a" });
  });

  it("signs each reply with the provider that wrote it", async () => {
    localStorage.setItem("redline.browse.lastHarness", JSON.stringify({ backend: "codex", model: null, effort: null }));
    turn.messages = [
      { id: "a1", browseId: "thread", role: "assistant", body: "", status: "complete", createdAt: 1, backend: "claude-code" },
      { id: "a2", browseId: "thread", role: "assistant", body: "", status: "complete", createdAt: 2, backend: "codex" },
      { id: "a3", browseId: "thread", role: "assistant", body: "", status: "complete", createdAt: 3 },
      { id: "e1", browseId: "thread", role: "assistant", body: "codex ended without producing a reply", status: "error", createdAt: 4 },
    ];
    await show();
    // The inherited Codex pick lands once the probe answers.
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    const bylines = [...host.querySelectorAll("[data-browser-chat-messages] .rl-reply-byline")].map(span => span.textContent);
    // An error row is Redline's note about this chat's current turn.
    expect(bylines).toEqual(["Claude", "Codex", "Claude", "Codex"]);
    // A reply settling live keeps the provider its done event named.
    expect(config.current!.makeMessage({ id: "live", role: "assistant", body: "Done", status: "complete", backend: "codex" })).toMatchObject({ backend: "codex" });
    expect(config.current!.makeMessage({ id: "mine", role: "user", body: "Hi", status: "complete" })).toMatchObject({ backend: null });
  });

  it("bylines the streaming reply with the provider it was sent to, not a pick made since", async () => {
    await show();
    await act(async () => { await sendTurn("Question"); });
    // A pick changed mid-reply applies to the next message.
    await click("Chat model and effort");
    const codex = [...document.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Provider"] button')][1];
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    await act(async () => codex.click());
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(host.querySelector('[aria-label="Chat model and effort"]')?.textContent).toContain("Codex");
    turn.status = "streaming";
    try {
      await show();
      expect(host.querySelector('[data-reply="live"] .rl-reply-byline')?.textContent).toBe("Claude");
    } finally {
      turn.status = "idle";
    }
  });

  it("grows the composer to 40% of the panel, then scrolls it, without moving it into the transcript", async () => {
    await show();
    Object.defineProperty(host.querySelector("[data-browser-chat]"), "clientHeight", { configurable: true, value: 500 });
    const textarea = host.querySelector("textarea")!;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 2000 });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Long draft\n".repeat(100));
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(textarea.style.height).toBe("200px");
    expect(textarea.style.overflowY).toBe("auto");
    expect(host.querySelector("[data-browser-chat-messages] textarea")).toBeNull();
    expect(host.querySelector("[data-browser-chat-composer]")?.classList.contains("shrink-0")).toBe(true);
    expect(host.querySelector("[data-browser-chat]")?.classList.contains("overflow-hidden")).toBe(true);
  });

  it("BC-27 keeps one round button: the mic on an empty box, send with text, stop while a reply runs", async () => {
    await show();
    const face = () => host.querySelector<HTMLButtonElement>("[data-browser-chat-composer] .rl-send")!;
    expect(face().dataset.send).toBe("mic");
    await act(async () => face().click());
    expect(dictation.toggle).toHaveBeenCalledOnce();
    // What was heard lands in the box as the dictation host writes it, and
    // the button becomes send.
    await act(async () => void placeText(targetFor(host.querySelector("textarea"))!, "compare the plans"));
    expect(host.querySelector("textarea")!.value).toBe("Compare the plans");
    expect(face().dataset.send).toBe("send");
    await act(async () => face().click());
    expect(turn.send).toHaveBeenCalledWith("Compare the plans");
    turn.status = "streaming";
    await show();
    expect(face().dataset.send).toBe("stop");
    await act(async () => face().click());
    expect(turn.cancel).toHaveBeenCalledOnce();
  });

  it("BC-27 keeps the mic on the button while it listens, so dictation can always be stopped", async () => {
    dictation.listening = true;
    try {
      await show();
      const face = () => host.querySelector<HTMLButtonElement>("[data-browser-chat-composer] .rl-send")!;
      const box = host.querySelector("textarea")!;
      // Typing beside a hot mic must not trade the only way to stop it for send.
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "and also");
        box.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(face().dataset.send).toBe("mic");
      expect(face().getAttribute("aria-label")).toBe("Stop dictating");
      // Nor does a reply that starts meanwhile turn it into Stop.
      turn.status = "streaming";
      await show();
      expect(face().dataset.send).toBe("mic");
      await act(async () => face().click());
      expect(dictation.toggle).toHaveBeenCalledOnce();
      expect(turn.cancel).not.toHaveBeenCalled();
    } finally {
      dictation.listening = false;
      turn.status = "idle";
    }
  });

  it("BC-26 keeps the reply in flight signed by its provider when a message queued behind it went to another", async () => {
    await show();
    turn.messages = [{ id: "u1", browseId: "thread", role: "user", body: "Question", status: "complete", createdAt: 1 }];
    await act(async () => { config.current!.onSent?.(await config.current!.buildSendArgs("Question"), { started: true, queued: false, messageId: "u1" }); });
    await click("Chat model and effort");
    const codex = [...document.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Provider"] button')][1];
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    await act(async () => codex.click());
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    turn.status = "streaming";
    try {
      await show();
      // The follow-up is typed and queued on Codex while Claude still writes.
      await act(async () => { config.current!.onSent?.(await config.current!.buildSendArgs("Follow-up"), { started: false, queued: true, messageId: "u2" }); });
      turn.queue = [{ id: "u2", browseId: "thread", role: "user", body: "Follow-up", status: "queued", createdAt: 2 }];
      await show();
      const byline = () => host.querySelector('[data-reply="live"] .rl-reply-byline')?.textContent;
      expect(byline()).toBe("Claude");
      // Its own turn, once it starts, is Codex's.
      turn.messages = [...turn.messages, { id: "a1", browseId: "thread", role: "assistant", body: "Answer", status: "complete", createdAt: 3 }, { id: "u2", browseId: "thread", role: "user", body: "Follow-up", status: "complete", createdAt: 4 }];
      turn.queue = [];
      await show();
      expect(byline()).toBe("Codex");
    } finally {
      turn.status = "idle";
    }
  });
});

describe("the thread", () => {
  const steps = (...labels: string[]) => labels.map((label, i) => ({ at: i + 1, kind: "tool", label }));
  const rows = () => [...host.querySelectorAll("[data-work-rows] > li")].map((li) => li.textContent);

  it("draws a reply's steps as rows under its text, the same live and once settled", async () => {
    const ring = steps("reading the page…", "searching the web…", "clicking…", "Clicked “Buy” · tab 2");
    Object.assign(turn, { status: "streaming", startedAt: 1, liveText: "Done — it is in the cart.", activity: ring });
    turn.messages = [{ id: "q", browseId: "thread", role: "user", body: "Buy it", status: "complete", createdAt: 1 }];
    await show();
    const live = rows();
    expect(live).toEqual(["Explored 1 page, 1 search", "Clicked “Buy” · tab 2"]);
    // Under the text, never above it.
    const reply = host.querySelector('[data-reply="live"]')!;
    expect(reply.querySelector(".rl-reply-text")!.compareDocumentPosition(reply.querySelector("[data-work-rows]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No steps line in the head as well.
    expect(reply.querySelector("[data-reply-steps]")).toBeNull();
    Object.assign(turn, { status: "idle", liveText: "", activity: null, meters: { a: { toolCalls: 4, steps: ring } } });
    turn.messages = [...turn.messages, { id: "a", browseId: "thread", role: "assistant", body: "Done — it is in the cart.", status: "complete", createdAt: 2 }];
    await show();
    expect(rows()).toEqual(live);
  });

  it("names the step running now in the one live line, a page action by its kind and tab", async () => {
    Object.assign(turn, { status: "streaming", startedAt: 1, liveText: "", activity: steps("acting on the page…") });
    turn.messages = [{ id: "q", browseId: "thread", role: "user", body: "Buy it", status: "complete", createdAt: 1 }];
    await show({ pageActions: new Map([["browser-page", { kind: "click", tab: 2, at: Date.now() }]]) });
    expect([...host.querySelectorAll("[role=status]")].map((el) => el.textContent?.trim())).toEqual(["Clicking · tab 2"]);
    // A running step is the live line, not yet a row.
    expect(rows()).toEqual([]);
  });

  it("keeps a step running until the reply writes past it, however the text and the step arrive", async () => {
    // A remount restores the text and the step together, a beat after both
    // happened: the step is still the one running.
    Object.assign(turn, { status: "streaming", startedAt: 1, liveText: "Let me check the page.", activity: [{ at: Date.now() - 2000, kind: "tool", label: "reading the page…" }] });
    turn.messages = [{ id: "q", browseId: "thread", role: "user", body: "Is it in stock?", status: "complete", createdAt: 1 }];
    await show();
    const status = () => [...host.querySelectorAll("[role=status]")].map((el) => el.textContent?.trim());
    expect(status()).toEqual(["Reading the page"]);
    expect(rows()).toEqual([]);
    // More text: the step is done, and reads as its row.
    turn.liveText += " It is in stock.";
    await show();
    expect(rows()).toEqual(["Read the page"]);
    expect(status()).not.toContain("Reading the page");
    // The self-heal probe hands back the same steps as new objects: still done.
    turn.activity = turn.activity!.map((step) => ({ ...step }));
    await show();
    expect(rows()).toEqual(["Read the page"]);
  });

  it("shows the context a message carried as chips in its card, after a reload too", async () => {
    turn.messages = [{ id: "q", browseId: "thread", role: "user", body: "> Token buckets refill\n\nWhy?", status: "complete", createdAt: 1 }];
    await show();
    const card = host.querySelector("[data-user-turn]")!;
    expect(card.querySelector(".rb-chip")?.textContent).toBe("Token buckets refill");
    expect(card.querySelector(".rb-chip")?.getAttribute("data-kind")).toBe("quote");
  });
});

describe("the status rail", () => {
  it("BC-39 sits outside the thread: the queue opens upward, Esc closes it, and × puts the text back", async () => {
    turn.status = "streaming";
    turn.queue = [{ id: "q-1", browseId: "thread", role: "user", body: "> A passage\n\nand one more thing", status: "queued", createdAt: 2 }];
    turn.unqueue.mockResolvedValueOnce("> A passage\n\nand one more thing");
    await show();
    const rail = host.querySelector("[data-browser-chat-rail]")!;
    expect(rail.closest("[data-browser-chat-messages]")).toBeNull();
    await act(async () => rail.querySelector<HTMLButtonElement>(".rl-queue-pill")!.click());
    expect(rail.querySelector('[data-tray="queue"]')).not.toBeNull();
    await act(async () => { host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(rail.querySelector("[data-tray]")).toBeNull();
    await act(async () => rail.querySelector<HTMLButtonElement>(".rl-queue-pill")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label^="Unqueue"]')!.click());
    expect(host.querySelector("textarea")!.value).toBe("and one more thing");
    expect(host.querySelector("[data-browser-chat-composer] .rb-chip")?.textContent).toContain("A passage");
  });

  it("BC-39 closes a tray whose rows ran out, so it never reopens by itself", async () => {
    turn.status = "streaming";
    turn.queue = [{ id: "q-1", browseId: "thread", role: "user", body: "one more thing", status: "queued", createdAt: 2 }];
    await show();
    await act(async () => host.querySelector<HTMLButtonElement>("[data-browser-chat-rail] .rl-queue-pill")!.click());
    expect(host.querySelector('[data-tray="queue"]')).not.toBeNull();
    // The queue drains into the thread.
    turn.queue = [];
    await show();
    expect(host.querySelector("[data-tray]")).toBeNull();
    // A later message queues: its pill shows, its tray waits to be asked for.
    turn.queue = [{ id: "q-2", browseId: "thread", role: "user", body: "and another", status: "queued", createdAt: 3 }];
    await show();
    expect(host.querySelector("[data-browser-chat-rail] .rl-queue-pill")).not.toBeNull();
    expect(host.querySelector("[data-tray]")).toBeNull();
  });

  it("counts the open Task-list items and opens the list; a mission shows its goal with Synthesize", async () => {
    invokeMock.mockImplementation(async (cmd?: string) => cmd === "browse_list_get"
      ? { list: {}, items: [{ id: "i1", body: "Fix the hero", done: false, pageTitle: "Home" }, { id: "i2", body: "Done one", done: true, pageTitle: "Home" }] }
      : []);
    const openTasks = vi.fn(), synthesize = vi.fn(), openMission = vi.fn();
    await show({ taskList: { nonce: 0, onOpen: openTasks }, mission: { title: "Rate limits", goal: "Compare token buckets", findings: 2, onOpen: openMission, onSynthesize: synthesize } });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    await click("Task list · 1");
    expect(host.querySelector('[data-tray="tasks"]')?.textContent).toContain("Fix the hero");
    await click("Open the Task list"); expect(openTasks).toHaveBeenCalledOnce();
    await act(async () => host.querySelector<HTMLButtonElement>("[data-mission]")!.click());
    const card = host.querySelector('[data-tray="mission"]')!;
    expect(card.textContent).toContain("Compare token buckets");
    expect(card.textContent).toContain("2 findings");
    await click("Synthesize"); expect(synthesize).toHaveBeenCalledOnce();
  });
});

describe("seeds", () => {
  const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  it("takes the caret only for a gesture whose point is typing next, and sends a one-tap intent", async () => {
    // Its own thread: drafts live in a store shared across mounts.
    const seeded = tabChat({ browseId: "seeded" });
    await show({ conversation: seeded, seed: { text: "> A passage\n\n", nonce: 1, source: { kind: "selection", action: "ask" } } });
    await frame();
    const box = host.querySelector("textarea")!;
    // The passage is a chip, not raw text in the field (BC-40).
    expect(box.value).toBe("");
    expect(host.querySelector("[data-browser-chat-composer] .rb-chip")?.textContent).toContain("A passage");
    expect(document.activeElement).toBe(box);
    box.blur();
    await show({ conversation: seeded, seed: { text: "> Define it", nonce: 2, source: { kind: "selection", action: "define" } } });
    await frame();
    expect(turn.send).toHaveBeenCalledWith("> Define it");
    expect(document.activeElement).not.toBe(box);
    expect(host.querySelectorAll("[data-browser-chat-composer] .rb-chip")).toHaveLength(1);
    // A plan Search sends its research turn without moving the caret either.
    await show({ conversation: seeded, seed: { text: "Research token buckets", nonce: 3, source: { kind: "plan-search" } } });
    await frame();
    expect(turn.send).toHaveBeenLastCalledWith("Research token buckets");
    expect(document.activeElement).not.toBe(box);
    // Sent, the chip and the question go as one message, and both clear.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "What does it mean?");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(turn.send).toHaveBeenLastCalledWith("> A passage\n\nWhat does it mean?");
    expect(box.value).toBe("");
    expect(host.querySelector("[data-browser-chat-composer] .rb-chip")).toBeNull();
  });

  it("puts a picked element in a chip with the caret after it, merging below what was typed", async () => {
    const seeded = tabChat({ browseId: "picked" });
    await show({ conversation: seeded });
    const box = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "half a thought");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await show({ conversation: seeded, seed: { text: 'Inspect this element:\n\n```json\n{"tag":"button","accessibleName":"Buy"}\n```', nonce: 4, source: { kind: "element" } } });
    await frame();
    expect(box.value).toBe("half a thought");
    expect(host.querySelector("[data-browser-chat-composer] .rb-chip")?.textContent).toContain("<button> Buy");
    expect(document.activeElement).toBe(box);
  });
});
