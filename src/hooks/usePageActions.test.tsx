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
const ack = (label: string, status: string) => act(async () => handlers.get("browser-action")?.({ payload: { label, kind: "click", tab: 2, status } }));

describe("usePageActions", () => {
  it("knows the running action by its page, and keeps the page's dot until a turn ends", async () => {
    await act(async () => root.render(<Probe />));
    await ack("browser-t2", "accepted");
    expect(probe().getAttribute("data-running")).toBe("browser-t2:click:2");
    expect(probe().getAttribute("data-acting")).toBe("browser-t2");
    await ack("browser-t2", "interrupted");
    expect(probe().getAttribute("data-running")).toBe("");
    expect(probe().getAttribute("data-acting")).toBe("browser-t2");
    await act(async () => handlers.get("browse-cancelled")?.({ payload: { browseId: "shared" } }));
    expect(probe().getAttribute("data-acting")).toBe("");
  });

  it("clears a finished action's dot on its own when no page-chat turn ends", async () => {
    await act(async () => root.render(<Probe />));
    await ack("browser-t1", "running");
    await ack("browser-t1", "completed");
    await act(async () => { vi.advanceTimersByTime(19_000); });
    expect(probe().getAttribute("data-acting")).toBe("browser-t1");
    // A turn ending clears only finished actions: one still running keeps its dot.
    await ack("browser-t3", "running");
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(probe().getAttribute("data-acting")).toBe("browser-t3");
    await act(async () => handlers.get("browse-done")?.({ payload: { browseId: "one" } }));
    expect(probe().getAttribute("data-acting")).toBe("browser-t3");
  });

  it("lets go of an action whose outcome never came, once the route's deadline has passed", async () => {
    // Stop kills the agent's request mid-action, and the route's handler goes
    // with it before it can say how the action ended.
    await act(async () => root.render(<Probe />));
    await ack("browser-t2", "accepted");
    await ack("browser-t2", "running");
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(probe().getAttribute("data-running")).toBe("browser-t2:click:2");
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(probe().getAttribute("data-running")).toBe("");
    expect(probe().getAttribute("data-acting")).toBe("");
    // An outcome that does come in time keeps its usual course.
    await ack("browser-t2", "running");
    await ack("browser-t2", "completed");
    await act(async () => { vi.advanceTimersByTime(19_000); });
    expect(probe().getAttribute("data-acting")).toBe("browser-t2");
  });
});
