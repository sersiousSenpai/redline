// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useResizablePane } from "./useResizablePane";
import { RELEASE_EVENT } from "../lib/pressRelease";
import { endResizeSession, isResizing } from "../lib/resizeSession";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// LAST2 walk: the rail's seam dragged shut stayed captured — the sidebar
// ignored clicks and the next click pulled the rail back open. Folding the
// column mid-drag ended the hook's drag but left the seam holding the
// pointer, and a release that never reached the document ended nothing.

let root: Root;
let host: HTMLDivElement;
let widths: number[];
let collapsed: number;

function Rail() {
  const { startDrag } = useResizablePane({
    width: 400,
    onWidthChange: (w) => widths.push(w),
    min: 280,
    onCollapse: () => { collapsed += 1; },
  });
  return <div className="grab" onPointerDown={startDrag} />;
}

const pointer = (type: string, clientX: number) => {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 10 }) as MouseEvent & { pointerId: number };
  Object.defineProperty(ev, "pointerId", { value: 7 });
  return ev;
};

let grab: HTMLElement;
let captured: boolean;
beforeEach(async () => {
  widths = [];
  collapsed = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Rail />));
  grab = host.querySelector<HTMLElement>(".grab")!;
  // jsdom has no pointer capture: the seam takes it at the press.
  captured = true;
  grab.hasPointerCapture = () => captured;
  grab.releasePointerCapture = vi.fn(() => { captured = false; });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  while (isResizing()) endResizeSession();
});

describe("a seam drag always ends (LAST2)", () => {
  it("dragged shut: the column folds, the session closes and the seam lets go of the pointer before any release", async () => {
    await act(async () => { grab.dispatchEvent(pointer("pointerdown", 1000)); });
    expect(isResizing()).toBe(true);
    // The rail is a trailing pane: dragging right shrinks it, far past its minimum.
    await act(async () => { window.dispatchEvent(pointer("pointermove", 1300)); });
    expect(collapsed).toBe(1);
    expect(isResizing()).toBe(false);
    expect(grab.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(captured).toBe(false);
  });

  it("a release the document never hears as a pointerup still ends the drag at the last width", async () => {
    await act(async () => { grab.dispatchEvent(pointer("pointerdown", 1000)); });
    await act(async () => { window.dispatchEvent(pointer("pointermove", 960)); });
    await act(async () => { window.dispatchEvent(new Event(RELEASE_EVENT)); });
    expect(isResizing()).toBe(false);
    expect(widths[widths.length - 1]).toBe(440);
    expect(captured).toBe(false);
    // Later presses elsewhere start nothing.
    await act(async () => { window.dispatchEvent(pointer("pointermove", 900)); });
    expect(widths[widths.length - 1]).toBe(440);
  });

  it("the seam losing its capture (its column unmounted it) ends the drag; a cancel does too", async () => {
    await act(async () => { grab.dispatchEvent(pointer("pointerdown", 1000)); });
    await act(async () => { grab.dispatchEvent(new Event("lostpointercapture")); });
    expect(isResizing()).toBe(false);
    captured = true;
    await act(async () => { grab.dispatchEvent(pointer("pointerdown", 1000)); });
    await act(async () => { window.dispatchEvent(pointer("pointercancel", 1000)); });
    expect(isResizing()).toBe(false);
  });
});
