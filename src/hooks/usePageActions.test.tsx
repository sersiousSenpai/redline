// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, fn: (event: { payload: unknown }) => void) => {
    handlers.set(name, fn);
    return () => handlers.delete(name);
  }),
}));
import { usePageActions } from "./usePageActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function Probe() {
  const { running, acting } = usePageActions();
  return <div data-running={[...running].map(([label, a]) => `${label}:${a.kind}:${a.tab}`).join()} data-acting={[...acting].join()} />;
}
const probe = () => host.firstElementChild!;
const ack = (label: string, status: string, turns?: string[]) => act(async () => handlers.get("browser-action")?.({ payload: { label, kind: "click", tab: 2, status, turns } }));
const ends = (event: string, browseId: string) => act(async () => handlers.get(event)?.({ payload: { browseId } }));
const acting = () => probe().getAttribute("data-acting");

describe("usePageActions", () => {
  it("knows the running action by its page, and keeps the page's dot until the turn that drove it ends", async () => {
    await act(async () => root.render(<Probe />));
    await ack("browser-t2", "accepted", ["shared"]);
    expect(probe().getAttribute("data-running")).toBe("browser-t2:click:2");
    expect(acting()).toBe("browser-t2");
    await ack("browser-t2", "interrupted", ["shared"]);
    expect(probe().getAttribute("data-running")).toBe("");
    expect(acting()).toBe("browser-t2");
    await ends("browse-cancelled", "shared");
    expect(acting()).toBe("");
  });

  it("clears a dot only for the turn that drove it: another turn ending leaves it", async () => {
    await act(async () => root.render(<Probe />));
    await ack("browser-t1", "accepted", ["tab-one"]);
    await ack("browser-t1", "completed", ["tab-one"]);
    await ack("browser-t2", "accepted", ["shared"]);
    await ack("browser-t2", "completed", ["shared"]);
    await ends("browse-done", "shared");
    expect(acting()).toBe("browser-t1");
    await ends("browse-error", "tab-one");
    expect(acting()).toBe("");
  });

  it("clears at once an outcome that lands after its turn has ended", async () => {
    // Stop ends the turn and drops the action's request; the route still
    // says how the action ended, a beat later.
    await act(async () => root.render(<Probe />));
    await ack("browser-t2", "running", ["shared"]);
    await ends("browse-cancelled", "shared");
    expect(acting()).toBe("browser-t2");
    await ack("browser-t2", "interrupted", ["shared"]);
    expect(acting()).toBe("");
  });

  it("holds a thread's new turn to its own end, not its last one's", async () => {
    await act(async () => root.render(<Probe />));
    await ack("browser-t2", "accepted", ["shared"]);
    await ack("browser-t2", "completed", ["shared"]);
    await ends("browse-done", "shared");
    expect(acting()).toBe("");
    await ack("browser-t2", "accepted", ["shared"]);
    await ack("browser-t2", "completed", ["shared"]);
    expect(acting()).toBe("browser-t2");
    await ends("browse-done", "shared");
    expect(acting()).toBe("");
  });

  it("clears a finished action's dot on its own when no page-chat turn drove it", async () => {
    await act(async () => root.render(<Probe />));
    await ack("browser-t1", "running");
    await ack("browser-t1", "completed");
    await act(async () => { vi.advanceTimersByTime(19_000); });
    expect(acting()).toBe("browser-t1");
    // No turn's end is this action's: one still running keeps its dot.
    await ack("browser-t3", "running", ["shared"]);
    await ends("browse-done", "shared");
    expect(acting()).toBe("browser-t1,browser-t3");
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(acting()).toBe("browser-t3");
  });
});
