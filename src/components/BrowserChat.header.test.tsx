// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowseMessage } from "../types";
const { turn, invokeMock, config, captureMock } = vi.hoisted(() => ({
  config: { current: null as null | { buildSendArgs: (text: string) => Promise<Record<string, unknown>> } },
  captureMock: vi.fn(async (label: string) => `snapshot:${label}`),
  invokeMock: vi.fn(async () => []),
  turn: { messages: [] as BrowseMessage[], liveText: "", status: "idle", startedAt: null, loaded: true,
    send: vi.fn(), cancel: vi.fn(), unqueue: vi.fn(), clear: vi.fn(), meter: null, activity: null, meters: {} },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: (options: typeof config.current) => { config.current = options; return turn; } }));
vi.mock("../lib/domSnapshot", () => ({ captureSnapshotOrCached: captureMock }));
vi.mock("./MarkdownView", () => ({ MarkdownView: () => null }));
vi.mock("./StreamingBubble", () => ({ default: () => null }));
vi.mock("./TurnFooter", () => ({ default: () => null, ThreadMeterStrip: () => null }));
import { BrowserChat } from "./BrowserChat";

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
describe("page conversation header", () => {
  it("re-grounds a shared conversation when the targeted page changes", async () => {
    turn.messages = [{ id: "prior", browseId: "thread", role: "assistant", body: "Prior answer", status: "complete", createdAt: 1 }];
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-a" linked onClose={() => {}}/>));
    expect(await config.current!.buildSendArgs("First question")).toMatchObject({ targetLabel: "browser-a", snapshot: "snapshot:browser-a" });
    expect(await config.current!.buildSendArgs("Follow-up")).toMatchObject({ targetLabel: "browser-a", snapshot: undefined });
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-b" linked onClose={() => {}}/>));
    expect(await config.current!.buildSendArgs("Compare this page")).toMatchObject({ targetLabel: "browser-b", snapshot: "snapshot:browser-b" });
    expect(captureMock.mock.calls.map(([label]) => label)).toEqual(["browser-a", "browser-b"]);
  });
  it("shows the title, chat toggle, three menu rows and an empty-state mission link", async () => {
    const research = vi.fn(), close = vi.fn(), toggle = vi.fn();
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-page" title="Source page" onClose={close} onToggleTabChat={toggle} onResearch={research}/>));
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

  it("names the linked origin", async () => {
    const toggle = vi.fn();
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-page" linked anchoredFromTitle="Origin" onToggleTabChat={toggle} onClose={() => {}}/>));
    expect(host.querySelector("[data-browser-chat-header]")?.textContent).toContain("Browser chat");
    await click("Tab chat"); expect(toggle).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Following Origin");
  });

  it("switches linked mode from the header and marks a tab chat only when it is the exception", async () => {
    const mode = vi.fn();
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-page" title="Source page" onToggleTabChat={() => {}} onToggleLinkedMode={mode} onClose={() => {}}/>));
    expect(button("Linked mode").getAttribute("aria-pressed")).toBe("false");
    expect(button("Linked mode").textContent).toBe("⛓️‍💥");
    expect(button("Linked mode").title).toContain("each tab opens its own chat");
    await click("Linked mode"); expect(mode).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("This tab’s own chat");
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-page" title="Source page" linkedMode onToggleTabChat={() => {}} onToggleLinkedMode={mode} onClose={() => {}}/>));
    expect(button("Linked mode").getAttribute("aria-pressed")).toBe("true");
    expect(button("Linked mode").textContent).toBe("🔗");
    expect(button("Linked mode").title).toContain("stay in the shared chat");
    expect(button("Shared chat")).toBeDefined();
    expect(host.textContent).toContain("This tab’s own chat");
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-page" linked linkedMode onToggleTabChat={() => {}} onToggleLinkedMode={mode} onClose={() => {}}/>));
    expect(button("Tab chat")).toBeDefined();
    expect(host.textContent).not.toContain("This tab’s own chat");
  });

  it("clears only this thread through the existing backend action", async () => {
    turn.messages = [{ id: "message", browseId: "thread", role: "user", body: "A prior question", status: "done", createdAt: 1 }];
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-page" onClose={() => {}} />));
    await click("Conversation actions"); await click("Clear history");
    expect(invokeMock).toHaveBeenCalledWith("browse_discard", { browseId: "thread" });
    expect(turn.clear).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("puts the model picker in one row under the header, with the context on its right", async () => {
    turn.messages = [{ id: "reply", browseId: "thread", role: "assistant", body: "An answer", status: "complete", createdAt: 1 }];
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-page" anchoredFromTitle="Origin" linkedMode onToggleTabChat={() => {}} onToggleLinkedMode={() => {}} onClose={() => {}}/>));
    const header = host.querySelector("[data-browser-chat-header]")!;
    const row = header.nextElementSibling!;
    expect(row.matches("[data-browser-chat-harness]")).toBe(true);
    expect(row.nextElementSibling?.matches("[data-browser-chat-messages]")).toBe(true);
    expect(row.firstElementChild?.getAttribute("aria-label")).toBe("Chat model and effort");
    expect(header.querySelector('[aria-label="Chat model and effort"]')).toBeNull();
    expect([...row.querySelectorAll(".rb-thread-context span")].map(span => span.textContent)).toEqual(["This tab’s own chat", "From Origin"]);
    expect(host.querySelectorAll(".rb-thread-context")).toHaveLength(1);
    // The reply is attributed to the chat's provider.
    expect(host.querySelector("[data-browser-chat-messages]")?.textContent).toContain("Claude");
  });

  it("stores an inherited pick before the first turn, and forgets it with the history", async () => {
    localStorage.setItem("redline.browse.lastHarness", JSON.stringify({ backend: "claude-code", model: "opus", effort: null }));
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-page" onClose={() => {}}/>));
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
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-page" onClose={() => {}}/>));
    await click("Conversation actions"); await click("Clear history");
    await act(async () => { await config.current!.buildSendArgs("After clearing"); });
    expect(sets()).toHaveLength(2);
  });

  it("bounds a long composer without moving it into the scrolling transcript", async () => {
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-page" onClose={() => {}} />));
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
