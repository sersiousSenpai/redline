// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../hooks/useNativeOverlayRegion", () => ({ useNativeOverlayRegion: vi.fn() }));
import FloatingBrowserIsland from "./FloatingBrowserIsland";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.useFakeTimers(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
function render(busy = false) { act(() => root.render(<FloatingBrowserIsland busy={busy}><textarea aria-label="Prompt" defaultValue=""/></FloatingBrowserIsland>)); }
function pointer(node: Element, type: string, relatedTarget: EventTarget | null = null) { act(() => { node.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget })); }); }
function advance(ms: number) { act(() => vi.advanceTimersByTime(ms)); }
it("opens after deliberate hover without stealing focus or making the page inert", () => {
  const page = document.createElement("button"); document.body.append(page); page.focus(); render();
  pointer(host.querySelector("button")!, "pointerover"); advance(119); expect(host.querySelector("textarea")).toBeNull();
  advance(1); expect(host.querySelector("textarea")).not.toBeNull(); expect(document.activeElement).toBe(page); expect(page.inert).toBeFalsy();
  pointer(host.querySelector(".rl-browser-island")!, "pointerout", document.body); advance(400); expect(host.querySelector("textarea")).toBeNull(); page.remove();
});
it("keeps a draft open on leave, but Escape always collapses", () => {
  render(); act(() => host.querySelector<HTMLButtonElement>("button")!.click());
  const field = host.querySelector("textarea")!; expect(document.activeElement).toBe(field); field.value = "Keep this draft"; field.blur();
  pointer(host.querySelector(".rl-browser-island")!, "pointerout", document.body); advance(800); expect(host.querySelector("textarea")).toBe(field);
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); expect(host.querySelector("textarea")).toBeNull();
});
it("supports the summon chord and stays open while busy", () => {
  render(true); act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })));
  expect(document.activeElement).toBe(host.querySelector("textarea")); host.querySelector("textarea")!.blur();
  pointer(host.querySelector(".rl-browser-island")!, "pointerout", document.body); advance(500); expect(host.querySelector("textarea")).not.toBeNull();
});
