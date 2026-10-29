// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalWallSlot, useSlotsRevision, useWallsDock } from "./TerminalLayer";
import type { WallFrame } from "./wall";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// W5 walk: after ⌘\ in a wall, or a closed pane, the SECOND wall went blank
// until a tab switch. A tree change remounts a wall's slot as a new element
// under the same pane id; the layer's frames were measured and observed
// against the old, detached one (a box of zeros), and nothing re-ran.

let root: Root;
let host: HTMLDivElement;
/** Each wall's box, by pane id: a detached element measures as zeros, as in
 *  a real document. */
const boxes = new Map<string, DOMRect>();
let observers: { fire: () => void; live: boolean }[] = [];
const fireResize = () => act(() => { for (const o of observers) if (o.live) o.fire(); });

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  boxes.clear();
  observers = [];
  vi.stubGlobal("ResizeObserver", class {
    entry: { fire: () => void; live: boolean };
    constructor(fn: () => void) { this.entry = { fire: fn, live: true }; observers.push(this.entry); }
    observe() {}
    disconnect() { this.entry.live = false; }
  });
  // Frames, not animation frames: the dock coalesces observer bursts.
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { fn(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const id = this.dataset.wbWallSlot;
    if (id) return this.isConnected ? (boxes.get(id) ?? new DOMRect()) : new DOMRect();
    return new DOMRect(0, 0, 1440, 900);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let seen: Map<string, WallFrame> | null = null;
/** Two walls side by side (or the second remounted under `bKey`), and the
 *  layer reading their frames the way TerminalLayer does. */
function Walls({ bKey, placement }: { bKey: string; placement: string }) {
  const layer = useRef<HTMLDivElement | null>(null);
  const rev = useSlotsRevision();
  seen = useWallsDock(layer, "a b", `${rev}|${placement}`);
  return (
    <main style={{ position: "relative" }}>
      <div ref={layer} />
      <TerminalWallSlot paneId="a" active />
      <div key={bKey}><TerminalWallSlot paneId="b" active /></div>
    </main>
  );
}

describe("several walls on screen: the layer's frames (W5 fix)", () => {
  it("a wall's slot remounted as a new element is measured and observed afresh", async () => {
    boxes.set("a", new DOMRect(0, 40, 400, 600));
    boxes.set("b", new DOMRect(400, 40, 400, 600));
    await act(async () => root.render(<Walls bKey="1" placement="split" />));
    expect(seen?.get("b")).toEqual({ left: 0.5, top: 0, width: 0.5, height: 1 });
    // ⌘\\ in the first wall: the tree changes and b's slot is a new element.
    await act(async () => root.render(<Walls bKey="2" placement="split|door" />));
    // The divider moves afterwards: only a live observer of the NEW slot can
    // see it. Against the old element b would measure as zeros.
    boxes.set("a", new DOMRect(0, 40, 300, 600));
    boxes.set("b", new DOMRect(300, 40, 500, 600));
    fireResize();
    expect(seen?.get("a")).toEqual({ left: 0, top: 0, width: 0.375, height: 1 });
    expect(seen?.get("b")).toEqual({ left: 0.375, top: 0, width: 0.625, height: 1 });
  });

  it("a slot moved by the tree without changing size is placed again on the layout commit", async () => {
    boxes.set("a", new DOMRect(0, 40, 400, 600));
    boxes.set("b", new DOMRect(400, 40, 400, 600));
    await act(async () => root.render(<Walls bKey="1" placement="k1" />));
    // A pane to the left of both closed: each wall moved, neither resized,
    // so no observer fires. The layout commit re-places the layer.
    boxes.set("a", new DOMRect(200, 40, 400, 600));
    boxes.set("b", new DOMRect(600, 40, 400, 600));
    const layer = host.querySelector("main > div") as HTMLElement;
    await act(async () => root.render(<Walls bKey="1" placement="k2" />));
    expect(layer.style.left).toBe("200px");
    expect(seen?.get("b")).toEqual({ left: 0.5, top: 0, width: 0.5, height: 1 });
  });
});
