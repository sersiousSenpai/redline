// SPDX-License-Identifier: Apache-2.0
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowseMessage } from "../types";
const { turn, invokeMock, config, captureMock } = vi.hoisted(() => ({
  config: { current: null as null | {
    buildSendArgs: (text: string) => Promise<Record<string, unknown>>;
    onSent?: (args: Record<string, unknown>) => void;
    makeMessage: (seed: { id: string; role: "user" | "assistant"; body: string; status: "complete" | "error"; backend?: string }) => BrowseMessage;
  } },
  captureMock: vi.fn(async (label: string) => `snapshot:${label}`),
  // The preflight probe finds a ready Codex: a Codex last pick is inherited
  // only when this machine can run it.
  invokeMock: vi.fn(async (cmd?: string) => cmd === "preflight_status"
    ? { codex: { found: true, usable: true, signedIn: true, authState: "signed-in" }, hook: {}, skill: {} }
    : []),
  turn: { messages: [] as BrowseMessage[], queue: [], liveText: "", status: "idle", startedAt: null, loaded: true,
    send: vi.fn(), cancel: vi.fn(), unqueue: vi.fn(), clear: vi.fn(), meter: null, activity: null, meters: {} },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: (options: typeof config.current) => { config.current = options; return turn; } }));
vi.mock("../lib/domSnapshot", () => ({ captureSnapshotOrCached: captureMock }));
vi.mock("./MarkdownView", () => ({ MarkdownView: () => null }));
vi.mock("./StreamingText", () => ({ StreamingText: () => null }));
import { BrowserChat } from "./BrowserChat";
import type { ResolvedConversation } from "../lib/browserChat/scope";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); turn.messages = [];
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
  kind: "tab", browseId: "thread", title: "Source page", targetLabel: "browser-page", targetTitle: "Source page", targetNumber: 1,
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

  it("re-grounds the turn after a send that never reached the backend", async () => {
    turn.messages = [{ id: "prior", browseId: "thread", role: "assistant", body: "Prior answer", status: "complete", createdAt: 1 }];
    await show({ conversation: sharedChat({ targetLabel: "browser-a" }) });
    // Built, but the backend never took it: no onSent.
    expect(await config.current!.buildSendArgs("Lost question")).toMatchObject({ snapshot: "snapshot:browser-a" });
    expect(await sendTurn("Asked again")).toMatchObject({ snapshot: "snapshot:browser-a" });
    expect(await sendTurn("Follow-up")).not.toHaveProperty("snapshot");
  });
  it("shows the title, chat toggle, three menu rows and an empty-state mission link", async () => {
    const research = vi.fn(), close = vi.fn(), toggle = vi.fn();
    await show({ onClose: close, onToggleTabChat: toggle, onResearch: research });
    expect(host.querySelector("[data-browser-chat-header]")?.textContent).toContain("Source page");
    expect(host.querySelector("[data-browser-chat-header]")?.querySelectorAll("button")).toHaveLength(3);
    // A tab's own chat offers the way to the shared one.
    await click("Shared chat"); expect(toggle).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("This tab’s own chat");
    const composer = host.querySelector("textarea");
    await click("Conversation actions");
    expect([...document.querySelector('[role="menu"]')!.children].map(row => row.textContent)).toEqual(["Start a research mission", "Text sizeA−A+", "Clear history"]);
    expect(button("Clear history").disabled).toBe(true);
    await click("Larger text"); expect(localStorage.getItem("redline.browseZoom")).toBe("1.1");
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menu"] button')!.click());
    expect(research).toHaveBeenCalledOnce();
    expect(host.querySelector("textarea")).toBe(composer);
    expect(host.querySelector("[data-browser-chat-composer]")?.textContent).toContain("Start a research mission");
    await click("Close discussion"); expect(close).toHaveBeenCalledOnce();
  });

  it("names the page a shared chat is on, never the shared chat itself as where it came from", async () => {
    const toggle = vi.fn();
    await show({ conversation: sharedChat({ targetNumber: 2, targetTitle: "Docs", exception: true }), onToggleTabChat: toggle });
    expect(host.querySelector("[data-browser-chat-header]")?.textContent).toContain("Browser chat");
    await click("Tab chat"); expect(toggle).toHaveBeenCalledOnce();
    expect([...host.querySelectorAll(".rb-thread-context span")].map(span => span.textContent)).toEqual(["Shared chat", "On tab 2 — Docs"]);
    expect(host.textContent).not.toContain("Following");
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
    expect(button("Shared chat")).toBeDefined();
    expect(host.textContent).toContain("This tab’s own chat");
    await show({ conversation: sharedChat(), linkedMode: true, onToggleTabChat: () => {}, onToggleLinkedMode: mode });
    expect(button("Tab chat")).toBeDefined();
    expect(host.textContent).not.toContain("This tab’s own chat");
  });

  it("clears only this thread through the existing backend action", async () => {
    turn.messages = [{ id: "message", browseId: "thread", role: "user", body: "A prior question", status: "done", createdAt: 1 }];
    await show();
    await click("Conversation actions"); await click("Clear history");
    expect(invokeMock).toHaveBeenCalledWith("browse_discard", { browseId: "thread" });
    expect(turn.clear).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("puts the model picker in one row under the header, with the context on its right", async () => {
    turn.messages = [{ id: "reply", browseId: "thread", role: "assistant", body: "An answer", status: "complete", createdAt: 1 }];
    await show({ conversation: tabChat({ exception: true, anchoredFrom: "Origin", targetNumber: 3, targetTitle: "Opened" }), linkedMode: true, onToggleTabChat: () => {}, onToggleLinkedMode: () => {} });
    const header = host.querySelector("[data-browser-chat-header]")!;
    const row = header.nextElementSibling!;
    expect(row.matches("[data-browser-chat-harness]")).toBe(true);
    expect(row.nextElementSibling?.matches("[data-browser-chat-messages]")).toBe(true);
    expect(row.firstElementChild?.getAttribute("aria-label")).toBe("Chat model and effort");
    expect(header.querySelector('[aria-label="Chat model and effort"]')).toBeNull();
    expect([...row.querySelectorAll(".rb-thread-context span")].map(span => span.textContent)).toEqual(["This tab’s own chat", "On tab 3 — Opened", "From Origin"]);
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
    await act(async () => { await config.current!.buildSendArgs("Question"); });
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

  it("bounds a long composer without moving it into the scrolling transcript", async () => {
    await show();
    const textarea = host.querySelector("textarea")!;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 2000 });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Long draft\n".repeat(100));
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(textarea.style.height).toBe("160px");
    expect(textarea.style.overflowY).toBe("auto");
    expect(host.querySelector("[data-browser-chat-messages] textarea")).toBeNull();
    expect(host.querySelector("[data-browser-chat-composer]")?.classList.contains("shrink-0")).toBe(true);
    expect(host.querySelector("[data-browser-chat]")?.classList.contains("overflow-hidden")).toBe(true);
  });
});

describe("seeds", () => {
  const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  it("takes the caret only for a gesture whose point is typing next, and sends a one-tap intent", async () => {
    // Its own thread: drafts live in a store shared across mounts.
    const seeded = tabChat({ browseId: "seeded" });
    await show({ conversation: seeded, seed: { text: "> A passage", nonce: 1, source: { kind: "selection", action: "ask" } } });
    await frame();
    const box = host.querySelector("textarea")!;
    expect(box.value).toBe("> A passage");
    expect(document.activeElement).toBe(box);
    box.blur();
    await show({ conversation: seeded, seed: { text: "> Define it", nonce: 2, source: { kind: "selection", action: "define" } } });
    await frame();
    expect(turn.send).toHaveBeenCalledWith("> Define it");
    expect(document.activeElement).not.toBe(box);
    expect(box.value).toBe("> A passage");
    // A plan Search sends its research turn without moving the caret either.
    await show({ conversation: seeded, seed: { text: "Research token buckets", nonce: 3, source: { kind: "plan-search" } } });
    await frame();
    expect(turn.send).toHaveBeenLastCalledWith("Research token buckets");
    expect(document.activeElement).not.toBe(box);
  });
});
