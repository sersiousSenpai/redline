// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The follow rule every chat thread shares. A new token is not the only thing
// that moves the bottom: a queue tray or a notice shrinks the viewport and a
// status line grows the last row, and a reader parked at the bottom must be
// re-pinned through each — while one who scrolled up to re-read is left alone.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStickToBottom } from "./useStickToBottom";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom lays nothing out: each scroller's geometry is set by hand. */
interface Box { scrollHeight: number; clientHeight: number }
const boxes = new WeakMap<Element, Box>();
const box = (el: Element) => boxes.get(el) ?? { scrollHeight: 0, clientHeight: 0 };

let observers: Array<{ callback: () => void; targets: Element[] }>;
let host: HTMLDivElement;
let root: Root;
let api: ReturnType<typeof useStickToBottom<HTMLDivElement>>;

beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry: { callback: () => void; targets: Element[] };
      constructor(callback: () => void) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(el: Element) { this.entry.targets.push(el); }
      disconnect() { this.entry.targets = []; }
    },
  );
  for (const prop of ["scrollHeight", "clientHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get() { return box(this)[prop]; } });
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  for (const prop of ["scrollHeight", "clientHeight"] as const) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
});

function Thread({ rows, text }: { rows: string[]; text: string }) {
  api = useStickToBottom<HTMLDivElement>([rows, text]);
  return (
    <div data-scroller ref={api.ref} onScroll={api.onScroll}>
      {rows.map((row) => <p key={row}>{row}</p>)}
      {text && <p data-live>{text}</p>}
    </div>
  );
}
const scroller = () => host.querySelector("[data-scroller]") as HTMLDivElement;
const render = (rows: string[], text = "") => act(async () => root.render(<Thread rows={rows} text={text} />));
/** Fire every live observer, as a layout pass with a size change would. */
const resize = () => act(async () => { for (const o of observers) if (o.targets.length) o.callback(); });
const watched = () => observers.flatMap((o) => o.targets);

describe("useStickToBottom", () => {
  it("pins a new row to the bottom", async () => {
    await render(["a"]);
    boxes.set(scroller(), { scrollHeight: 400, clientHeight: 300 });
    await render(["a", "b"]);
    expect(scroller().scrollTop).toBe(400);
  });

  it("re-pins when the viewport shrinks under a tray, with no new token", async () => {
    await render(["a", "b"], "streaming");
    boxes.set(scroller(), { scrollHeight: 600, clientHeight: 300 });
    await render(["a", "b"], "streaming more");
    expect(scroller().scrollTop).toBe(600);
    // The queue tray takes 52 px of the viewport: the bottom moves, the
    // stream does not.
    boxes.set(scroller(), { scrollHeight: 652, clientHeight: 248 });
    await resize();
    expect(scroller().scrollTop).toBe(652);
  });

  it("leaves a reader who scrolled up to re-read where they are", async () => {
    await render(["a", "b"], "streaming");
    boxes.set(scroller(), { scrollHeight: 900, clientHeight: 300 });
    scroller().scrollTop = 200;
    await act(async () => scroller().dispatchEvent(new Event("scroll")));
    boxes.set(scroller(), { scrollHeight: 960, clientHeight: 248 });
    await resize();
    await render(["a", "b"], "streaming on");
    expect(scroller().scrollTop).toBe(200);
    // Re-armed by a send, it follows again.
    api.stick();
    await render(["a", "b", "c"]);
    expect(scroller().scrollTop).toBe(960);
  });

  it("watches the viewport and the last row, re-aimed only when that row changes", async () => {
    await render(["a"], "s");
    const live = host.querySelector("[data-live]")!;
    expect(watched()).toEqual([scroller(), live]);
    // A token is not a new row: nothing is re-observed.
    await render(["a"], "st");
    await render(["a"], "str");
    expect(watched()).toEqual([scroller(), live]);
    expect(observers).toHaveLength(1);
    // The reply settles into a row of its own: the watch moves to it.
    await render(["a", "b"]);
    expect(watched()).toEqual([scroller(), host.querySelector("p:last-child")]);
    expect(observers).toHaveLength(1);
  });

  it("stops watching when the thread goes", async () => {
    await render(["a"]);
    expect(watched()).not.toEqual([]);
    await act(async () => root.unmount());
    expect(watched()).toEqual([]);
    root = createRoot(host);
  });
});
