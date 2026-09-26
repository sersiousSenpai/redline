// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowseMessage } from "../types";
const { turn, invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => []),
  turn: { messages: [] as BrowseMessage[], liveText: "", status: "idle", startedAt: null, loaded: true,
    send: vi.fn(), cancel: vi.fn(), unqueue: vi.fn(), clear: vi.fn(), meter: null, activity: null, meters: {} },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: () => turn }));
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
  it("shows the title, linked toggle, three menu rows and an empty-state mission link", async () => {
    const research = vi.fn(), close = vi.fn(), linked = vi.fn();
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-page" title="Source page" onClose={close} onToggleLinked={linked} onResearch={research}/>));
    expect(host.querySelector("[data-browser-chat-header]")?.textContent).toContain("Source page");
    expect(host.querySelector("[data-browser-chat-header]")?.querySelectorAll("button")).toHaveLength(3);
    expect(button("Linked").getAttribute("aria-pressed")).toBe("false");
    await click("Linked"); expect(linked).toHaveBeenCalledOnce();
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
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-page" linked anchoredFromTitle="Origin" onClose={() => {}}/>));
    expect(button("Linked").getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("🔗 Linked · from Origin");
  });

  it("clears only this thread through the existing backend action", async () => {
    turn.messages = [{ id: "message", browseId: "thread", role: "user", body: "A prior question", status: "done", createdAt: 1 }];
    await act(async () => root.render(<BrowserChat browseId="thread" label="browser-page" onClose={() => {}} />));
    await click("Conversation actions"); await click("Clear history");
    expect(invokeMock).toHaveBeenCalledWith("browse_discard", { browseId: "thread" });
    expect(turn.clear).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
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
