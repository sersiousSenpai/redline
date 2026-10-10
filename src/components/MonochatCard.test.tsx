// SPDX-License-Identifier: Apache-2.0
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const region = vi.hoisted(() => vi.fn());
vi.mock("../hooks/useNativeOverlayRegion", () => ({ useNativeOverlayRegion: region }));
import MonochatCard from "./MonochatCard";
import { SWAP_MS, SWAP_SPRING } from "../lib/springSwap";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const pill = createRef<HTMLButtonElement>();
const onClose = vi.fn(), onRelease = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  onClose.mockClear(); onRelease.mockClear(); region.mockClear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function render(hovered = true) {
  act(() => root.render(<>
    <button ref={pill}><span className="rl-portal-membrane">Redline</span></button>
    <MonochatCard pill={pill} hovered={() => hovered} onClose={onClose} onRelease={onRelease}><textarea aria-label="Prompt" defaultValue=""/></MonochatCard>
  </>));
}
const card = () => host.querySelector<HTMLElement>(".rl-monochat-float")!;
const leave = () => act(() => { card().dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })); });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

it("springs out of the pill's membrane and stays cut out of the native page while it moves", () => {
  const animate = vi.fn((..._args: unknown[]) => ({ cancel() {}, onfinish: null }));
  (HTMLElement.prototype as { animate?: unknown }).animate = animate;
  try {
    render();
    expect(animate).toHaveBeenCalledOnce();
    expect(animate.mock.calls[0][1]).toEqual({ duration: SWAP_MS, easing: SWAP_SPRING });
    // The hole follows the spring frame by frame.
    expect(region).toHaveBeenLastCalledWith(expect.anything(), true, true);
  } finally { delete (HTMLElement.prototype as { animate?: unknown }).animate; }
});

it("leaves 350 ms after the pointer does, unless it comes back", () => {
  render();
  leave(); advance(349);
  expect(onClose).not.toHaveBeenCalled();
  act(() => { card().dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); });
  advance(500);
  expect(onClose).not.toHaveBeenCalled();
  leave(); advance(350);
  expect(onClose).toHaveBeenCalledOnce();
});

it("arriving after the pointer already left, it starts its leave at once", () => {
  render(false);
  advance(350);
  expect(onClose).toHaveBeenCalledOnce();
});

it("an old draft pins nothing; using it does", () => {
  render();
  host.querySelector("textarea")!.value = "Keep this draft";
  leave(); advance(400);
  expect(onClose).toHaveBeenCalledOnce();
  onClose.mockClear();
  act(() => { host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); });
  leave(); advance(800);
  expect(onClose).not.toHaveBeenCalled();
});

it("tells its owner, as it leaves, whether it held the caret", () => {
  render();
  act(() => host.querySelector("textarea")!.focus());
  act(() => root.render(<button ref={pill}/>));
  expect(onRelease).toHaveBeenCalledWith(true);
});

it("covers what is under it for a dropped file, and never scrolls sideways", () => {
  render();
  expect(card().hasAttribute("data-drop-cover")).toBe(true);
  const css = readFileSync(join(process.cwd(), "src/components/MonochatCard.css"), "utf8");
  const rule = css.match(/\.rl-monochat-float \{[^}]*\}/)?.[0] ?? "";
  expect(rule).toContain("overflow-x:hidden");
  expect(rule).toContain("pointer-events:auto");
});
