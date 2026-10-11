// SPDX-License-Identifier: Apache-2.0
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const region = vi.hoisted(() => vi.fn());
vi.mock("../hooks/useNativeOverlayRegion", () => ({ useNativeOverlayRegion: region }));
import MonochatCard from "./MonochatCard";
import { ISLAND_EASE_IN, ISLAND_FADE_MS, ISLAND_SPRING_MS, SWAP_SPRING } from "../lib/springSwap";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const pill = createRef<HTMLButtonElement>();
const onClose = vi.fn(), onRelease = vi.fn(), onGone = vi.fn();
let reduced = false;
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  onClose.mockClear(); onRelease.mockClear(); onGone.mockClear(); region.mockClear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as { animate?: unknown }).animate; });

function render(hovered = true, { open = true, growing = false } = {}) {
  act(() => root.render(<>
    <button ref={pill}><span className="rl-portal-membrane">Redline</span></button>
    <MonochatCard pill={pill} open={open} growing={growing} hovered={() => hovered} onClose={onClose} onRelease={onRelease} onGone={onGone}><textarea aria-label="Prompt" defaultValue=""/></MonochatCard>
  </>));
}
const card = () => host.querySelector<HTMLElement>(".rl-monochat-float")!;
const leave = () => act(() => { card().dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })); });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

const last = <T,>(list: T[]) => list[list.length - 1];
/** Web Animations, recorded: who animated what, how, and a way to finish it. */
function flights() {
  const calls: Array<{ element: Element; frames: Keyframe[]; options: KeyframeAnimationOptions; animation: { cancel: () => void; onfinish: null | (() => void); cancelled: boolean } }> = [];
  (HTMLElement.prototype as { animate?: unknown }).animate = function (this: Element, frames: Keyframe[], options: number | KeyframeAnimationOptions) {
    const animation = { cancelled: false, onfinish: null as null | (() => void), cancel() { this.cancelled = true; } };
    calls.push({ element: this, frames, options: typeof options === "number" ? { duration: options } : options, animation });
    return animation;
  };
  return calls;
}

it("springs out of the pill's membrane by transform alone, the content following 80 ms behind", () => {
  const calls = flights();
  render();
  const [shell, corners, content] = calls;
  expect(shell.element).toBe(card());
  expect(shell.options).toEqual({ duration: ISLAND_SPRING_MS, easing: SWAP_SPRING });
  expect(ISLAND_SPRING_MS).toBe(420);
  expect(shell.frames.map(f => Object.keys(f))).toEqual([["transform"], ["transform"]]);
  // The corners are paint, so they settle within the 300 ms budget.
  expect(Object.keys(corners.frames[0])).toEqual(["borderRadius"]);
  expect(corners.options.duration).toBeLessThanOrEqual(300);
  expect(content.element.parentElement).toBe(card());
  expect(content.options).toMatchObject({ delay: 80, duration: ISLAND_SPRING_MS - 80, fill: "backwards" });
  expect(content.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  // The hole follows the spring frame by frame, and rests once it lands.
  expect(region).toHaveBeenLastCalledWith(expect.anything(), true, true);
  act(() => shell.animation.onfinish?.());
  expect(region).toHaveBeenLastCalledWith(expect.anything(), true, false);
});

it("goes back into the pill before it is gone — quick, accelerating, the content out first", () => {
  const calls = flights();
  render();
  calls.length = 0;
  render(true, { open: false });
  const [shell, corners, content] = calls;
  expect(shell.options).toEqual({ duration: 220, easing: ISLAND_EASE_IN, fill: "forwards" });
  expect(last(shell.frames)).toMatchObject({ opacity: 0 });
  expect(corners.options.duration).toBe(220);
  expect(content.options).toMatchObject({ duration: 100, fill: "forwards" });
  // Still on screen, see-through to the pointer, and tracked in the page.
  expect(card().hasAttribute("data-leaving")).toBe(true);
  expect(region).toHaveBeenLastCalledWith(expect.anything(), true, true);
  expect(onGone).not.toHaveBeenCalled();
  act(() => shell.animation.onfinish?.());
  expect(onGone).toHaveBeenCalledOnce();
});

it("turned round on its way back, it springs out again from where it got to", () => {
  const calls = flights();
  render();
  render(true, { open: false });
  const back = calls[calls.length - 3];
  calls.length = 0;
  render(true, { open: true });
  expect(back.animation.cancelled).toBe(true);
  expect(onGone).not.toHaveBeenCalled();
  // The content picks up from its fade rather than blinking out first.
  expect(calls[2].options.delay).toBe(0);
  expect(card().hasAttribute("data-leaving")).toBe(false);
});

it("under reduced motion it crossfades in 120 ms, both ways", () => {
  const calls = flights();
  reduced = true;
  render();
  expect(calls).toHaveLength(1);
  expect(calls[0].frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  expect(calls[0].options.duration).toBe(ISLAND_FADE_MS);
  render(true, { open: false });
  expect(last(calls).frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
  act(() => last(calls).animation.onfinish?.());
  expect(onGone).toHaveBeenCalledOnce();
});

it("as the door grows out of it, it hands over its box and its field's selection, and is gone at once", () => {
  const calls = flights();
  render();
  const field = host.querySelector("textarea")!;
  act(() => { field.focus(); field.value = "Plan the export"; field.setSelectionRange(5, 8); });
  calls.length = 0;
  render(true, { open: false, growing: true });
  expect(calls).toHaveLength(0);
  expect(onGone).toHaveBeenCalledOnce();
  expect(onRelease).toHaveBeenCalledWith({ caret: true, rect: expect.objectContaining({ width: expect.any(Number) }), selection: [5, 8, expect.any(String)] });
});

it("a field it never used carries no selection", () => {
  render();
  render(true, { open: false });
  expect(onRelease).toHaveBeenCalledWith(expect.objectContaining({ caret: false, selection: null }));
});

it("speaks once as it starts to leave — never on the way out", () => {
  render();
  expect(onRelease).not.toHaveBeenCalled();
  act(() => host.querySelector("textarea")!.focus());
  render(true, { open: false });
  expect(onRelease).toHaveBeenCalledOnce();
  expect(onRelease.mock.calls[0][0].caret).toBe(true);
  // Without Web Animations there is nothing to wait for.
  expect(onGone).toHaveBeenCalledOnce();
});

it("closed before its chunk even landed, it puts nothing away", () => {
  const calls = flights();
  render(true, { open: false });
  expect(calls).toHaveLength(0);
  expect(onGone).toHaveBeenCalledOnce();
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

it("is a region named by its own heading, which only a screen reader hears: the pill under it already says it", () => {
  render();
  const heading = document.getElementById(card().getAttribute("aria-labelledby")!);
  expect(heading?.tagName).toBe("H2");
  expect(heading?.textContent).toBe("Plan a build");
  expect(heading?.classList.contains("sr-only")).toBe(true);
  // No mark on the card: the brand is the pill's.
  expect(card().querySelector(".rl-float-heading svg:not(.lucide-chevron-down)")).toBeNull();
  expect(card().getAttribute("role")).toBe("region");
  // Collapse is still there, in the corner.
  expect(card().querySelector('.rl-float-heading button[aria-label="Collapse"]')).not.toBeNull();
});

it("covers what is under it for a dropped file, and never scrolls sideways", () => {
  render();
  expect(card().hasAttribute("data-drop-cover")).toBe(true);
  const css = readFileSync(join(process.cwd(), "src/components/MonochatCard.css"), "utf8");
  const rule = css.match(/\.rl-monochat-float \{[^}]*\}/)?.[0] ?? "";
  expect(rule).toContain("overflow-x:hidden");
  expect(rule).toContain("pointer-events:auto");
  expect(css).toMatch(/\.rl-monochat-float\[data-leaving\] \{ pointer-events:none; \}/);
});
