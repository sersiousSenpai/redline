// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { crossedDragThreshold, startTabPointerDrag, tabDropIndex } from "./browserTabDrag";
let strip: HTMLDivElement, nodes: HTMLElement[];
const pointer = (type: string, x: number, y = 12) => Object.assign(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }), { pointerId: 1 }) as PointerEvent;
beforeEach(() => {
  strip = document.createElement("div"); strip.innerHTML = '<div data-tab-id="a"></div><div data-tab-id="b"></div><div data-tab-id="c"></div>'; document.body.append(strip);
  nodes = [...strip.children] as HTMLElement[];
  nodes.forEach((node, i) => {
    node.getBoundingClientRect = () => ({ left: i * 100, right: (i + 1) * 100, width: 100 }) as DOMRect;
    node.setPointerCapture = vi.fn(); node.releasePointerCapture = vi.fn(); node.hasPointerCapture = () => true;
  });
  strip.getBoundingClientRect = () => ({ left: 0, right: 300, width: 300, top: 0, bottom: 30 }) as DOMRect;
  Object.defineProperties(strip, { scrollWidth: { configurable: true, value: 300 }, clientWidth: { configurable: true, value: 300 } });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => strip) });
});
afterEach(() => { strip.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("uses a four-pixel threshold and swaps at half a tab instead of a whole tab", () => {
  expect(crossedDragThreshold(3)).toBe(false); expect(crossedDragThreshold(4)).toBe(true);
  expect(tabDropIndex([50, 150, 250], 0, 99, 100)).toBe(0);
  expect(tabDropIndex([50, 150, 250], 0, 106, 100)).toBe(1);
  expect(tabDropIndex([50, 150, 250], 0, 206, 100)).toBe(2);
  expect(tabDropIndex([50, 150, 250], 2, 194, 100)).toBe(1);
});
it("holds the preview through jitter and supports unequal widths", () => {
  expect(tabDropIndex([50, 150, 250], 0, 99, 100, 1)).toBe(1);
  expect(tabDropIndex([50, 150, 250], 0, 95, 100, 1)).toBe(0);
  expect(tabDropIndex([75, 200, 350], 0, 130, 150)).toBe(1);
  expect(tabDropIndex([75, 200, 350], 0, 280, 150)).toBe(2);
});
it("suppresses text selection, captures the pointer and commits only on release", () => {
  const onDrop = vi.fn(), onDragging = vi.fn(), down = pointer("pointerdown", 50);
  startTabPointerDrag(down, nodes[0], { onDrop, onDragging });
  expect(down.defaultPrevented).toBe(true); expect(nodes[0].setPointerCapture).toHaveBeenCalledWith(1);
  window.dispatchEvent(pointer("pointermove", 53)); expect(onDragging).not.toHaveBeenCalled();
  window.dispatchEvent(pointer("pointermove", 260)); expect(onDrop).not.toHaveBeenCalled();
  window.dispatchEvent(pointer("pointerup", 260)); expect(onDrop).toHaveBeenCalledWith("c", null);
  expect(strip.classList.contains("rb-tabs-dragging")).toBe(false);
});
it("leaves a plain click alone and never commits a cancelled drag", () => {
  const onDrop = vi.fn();
  startTabPointerDrag(pointer("pointerdown", 50), nodes[0], { onDrop, onDragging: vi.fn() });
  window.dispatchEvent(pointer("pointerup", 52)); expect(onDrop).not.toHaveBeenCalled();
  startTabPointerDrag(pointer("pointerdown", 50), nodes[0], { onDrop, onDragging: vi.fn() });
  window.dispatchEvent(pointer("pointermove", 260)); window.dispatchEvent(new Event("pointercancel"));
  window.dispatchEvent(pointer("pointerup", 260)); expect(onDrop).not.toHaveBeenCalled();
});
it("assigns a strip tab to a tile on release", () => {
  const tile = document.createElement("section"); tile.dataset.tileIndex = "2"; strip.append(tile);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => tile });
  const onDrop = vi.fn(); startTabPointerDrag(pointer("pointerdown", 50), nodes[0], { onDrop, onDragging: vi.fn() });
  window.dispatchEvent(pointer("pointermove", 100, 150)); window.dispatchEvent(pointer("pointerup", 100, 150));
  expect(onDrop).toHaveBeenCalledWith("a", 2);
});

it.each([8, 50, 85])("reorders after the same travel when grabbed at x=%i", (grab) => {
  const onDrop = vi.fn(); startTabPointerDrag(pointer("pointerdown", grab), nodes[0], { onDrop, onDragging: vi.fn() });
  window.dispatchEvent(pointer("pointermove", grab + 58)); window.dispatchEvent(pointer("pointerup", grab + 58));
  expect(onDrop).toHaveBeenCalledWith("b", null);
});

it("accepts a diagonal release below the strip without stealing it for a tile", () => {
  const tile = document.createElement("section"); tile.dataset.tileIndex = "0"; strip.append(tile);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => tile });
  const onDrop = vi.fn(); startTabPointerDrag(pointer("pointerdown", 10), nodes[0], { onDrop, onDragging: vi.fn() });
  window.dispatchEvent(pointer("pointermove", 70, 60)); window.dispatchEvent(pointer("pointerup", 70, 60));
  expect(onDrop).toHaveBeenCalledWith("b", null);
});

it("keeps scrolling at an overflow edge without more pointer events", () => {
  Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 900 });
  let next = 0; const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const cleanup = startTabPointerDrag(pointer("pointerdown", 50), nodes[0], { onDrop: vi.fn(), onDragging: vi.fn() });
  window.dispatchEvent(pointer("pointermove", 298));
  const advance = (time: number) => { const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(time)); };
  advance(16); const first = strip.scrollLeft;
  advance(32); advance(48);
  expect(strip.scrollLeft).toBeGreaterThan(first); expect(first).toBeGreaterThan(0);
  cleanup(); expect(frames.size).toBe(0);
});
