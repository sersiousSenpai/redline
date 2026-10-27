// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  },
}));
import { usePush, type UsePush } from "./usePush";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let push: UsePush;
let renders = 0;
let ahead = 1;
let visibility: DocumentVisibilityState;

function Probe({ repo }: { repo: string | null }) {
  push = usePush(repo, "review-1");
  renders++;
  return null;
}
const render = (repo: string | null) => act(async () => root.render(<Probe repo={repo} />));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const statusReads = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === "push_status").length;

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  ahead = 1;
  renders = 0;
  mocks.listeners.clear();
  mocks.invoke.mockReset().mockImplementation(async (command: string, args: { repo?: string }) => {
    if (command === "push_status") return { repo: args.repo, branch: "main", ahead, behind: 0, dirty: false };
    return null;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("usePush's status poll", () => {
  it("keeps the status object, and renders nothing, while git reports the same thing", async () => {
    await render("/repo");
    const first = push.status;
    expect(first).toMatchObject({ ahead: 1 });
    const settled = renders;
    await advance(180_000);
    expect(statusReads()).toBe(4);
    expect(push.status).toBe(first);
    expect(renders).toBe(settled);
    ahead = 0;
    await advance(60_000);
    expect(push.status).toMatchObject({ ahead: 0 });
  });

  it("a finished push re-reads at once, and a status that came back to an earlier value still lands", async () => {
    await render("/repo");
    ahead = 0;
    await act(async () => mocks.listeners.get("review-push-done")!({ payload: "review-1" }));
    expect(push.status).toMatchObject({ ahead: 0 });
    ahead = 1;
    await advance(60_000);
    expect(push.status).toMatchObject({ ahead: 1 });
  });

  it("stops while the window is hidden, and clears and re-reads when the repo changes", async () => {
    await render("/repo");
    visibility = "hidden";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    const reads = statusReads();
    await advance(60_000);
    expect(statusReads()).toBe(reads);
    visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(statusReads()).toBe(reads + 1);
    await render("/other");
    expect(push.status).toMatchObject({ repo: "/other" });
    await render(null);
    expect(push.status).toBeNull();
    const idle = statusReads();
    await advance(30_000);
    expect(statusReads()).toBe(idle);
  });
});
