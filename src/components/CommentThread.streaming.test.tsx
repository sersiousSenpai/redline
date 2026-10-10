// SPDX-License-Identifier: Apache-2.0
//
// Where the two halves of a thread's per-frame work meet. `useAgentTurn`
// renders a reply's deltas once a frame and `StreamingText` /
// `StreamingBubble` re-parse only its open block; the settled rows above are
// memoized and the reply box owns its own draft. A memo must never hold a live
// reply still, and neither a frame of the reply nor a keystroke may re-render
// a settled row. (That a frame re-parses only the open block is pinned in
// StreamingBubble.test.tsx.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Comment, ThreadMessage, TurnStatus } from "../types";

const { invokeMock, listenMock, renders } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  renders: new Map<string, number>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("./DiscussModelChip", () => ({ DiscussModelChip: () => null }));
// The real view (the live tail is appended into its container, so it has to
// be the real markup), behind a counter that is NOT memoized: it counts every
// render of the row around it, by body.
vi.mock("./MarkdownView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MarkdownView")>();
  const { createElement: h } = await import("react");
  type Props = Parameters<typeof actual.MarkdownView>[0];
  const Counted = (props: Props) => {
    renders.set(props.body, (renders.get(props.body) ?? 0) + 1);
    return h(actual.MarkdownView, props);
  };
  return { ...actual, MarkdownView: Counted };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { CommentThread } from "./CommentThread";

type Handler = (e: { payload: unknown }) => void;
let handlers: Map<string, Handler[]>;
let history: ThreadMessage[];
const emit = (event: string, payload: Record<string, unknown>) => {
  for (const fn of [...(handlers.get(event) ?? [])]) fn({ payload: { sessionId: "s-1", commentId: "c-1", ...payload } });
};
const streaming: TurnStatus = { streaming: true, startedAt: 500, partial: null, seq: 0, queued: [] };

const comment: Comment = { id: "c-1", type: "feedback", anchorId: "A.1", body: "This anchor drifts.", createdAt: 1, status: "draft" };
const row = (id: string, role: "user" | "assistant", body: string, mode?: "chat"): ThreadMessage =>
  ({ id, sessionId: "s-1", commentId: "c-1", role, body, status: "complete", createdAt: 2, mode });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  renders.clear();
  localStorage.clear();
  handlers = new Map();
  listenMock.mockImplementation((event: string, fn: Handler) => {
    handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    return Promise.resolve(() => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== fn)));
  });
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "get_thread") return Promise.resolve(history);
    if (cmd === "fork_thread_status") return Promise.resolve(streaming);
    return Promise.resolve(null);
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const delta = (text: string, seq: number) => act(async () => { emit("fork-delta", { text, seq }); await nextFrame(); });
const type = (ta: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, value);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
};

describe.each([
  { view: "report", settledBody: "It settles.", mode: undefined },
  { view: "chat", settledBody: "Short answer.", mode: "chat" as const },
])("the $view view streams past its memoized rows", ({ view, settledBody, mode }) => {
  beforeEach(() => {
    if (view === "chat") localStorage.setItem("redline.sidecarView.s-1.c-1", "chat");
    history = [
      row("m-1", "user", comment.body),
      row("m-2", "user", "Why there?", mode),
      row("m-3", "assistant", settledBody, mode),
      row("m-4", "user", "And after that?", mode),
    ];
  });

  it("advances the live reply every frame while the settled rows sit still", async () => {
    await act(async () => root.render(createElement(CommentThread, { sessionId: "s-1", comment })));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    await delta("First block.\n\nSecond bl", 1);
    expect(host.textContent).toContain("Second bl");
    const settled = renders.get(settledBody);
    expect(settled).toBeGreaterThan(0);

    await delta("ock grows", 2);
    expect(host.textContent).toContain("Second block grows");
    expect(renders.get(settledBody), "a frame of the reply re-rendered a settled row").toBe(settled);

    // Typing while it streams: the box re-renders, nothing above it does.
    const ta = host.querySelector("textarea")!;
    for (const value of ["S", "St", "Stop"]) await act(async () => type(ta, value));
    expect(ta.value).toBe("Stop");
    expect(renders.get(settledBody)).toBe(settled);

    await delta("\n\nThird", 3);
    expect(host.textContent).toContain("Third");
    expect(renders.get(settledBody)).toBe(settled);

    // Done settles the reply into a memoized row of its own, whole.
    const full = "First block.\n\nSecond block grows\n\nThird";
    await act(async () => emit("fork-done", { messageId: "m-5", body: full }));
    expect(renders.get(full)).toBe(1);
    expect(host.textContent?.split("Third").length).toBe(2);
    expect(renders.get(settledBody)).toBe(settled);
  });
});
