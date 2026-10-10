// SPDX-License-Identifier: Apache-2.0
//
// Typing touches only the component being typed in. The reply box's draft
// used to live on the thread, so every keystroke re-rendered the whole
// transcript (and its markdown) above the box.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Comment, ThreadMessage } from "../types";

const { history, markdownRenders } = vi.hoisted(() => ({
  history: [] as unknown[],
  markdownRenders: { count: 0 },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "get_thread") return Promise.resolve(history);
    if (cmd === "fork_thread_status") return Promise.resolve({ streaming: false, startedAt: null, partial: null, seq: 0, queued: [] });
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("./DiscussModelChip", () => ({ DiscussModelChip: () => null }));
vi.mock("./MarkdownView", () => ({
  MarkdownView: ({ body }: { body: string }) => {
    markdownRenders.count++;
    return createElement("div", null, body);
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { CommentThread } from "./CommentThread";
import { readSharedDraft } from "../hooks/useSharedDraft";

const comment: Comment = { id: "c-1", type: "feedback", anchorId: "A.1", body: "This anchor drifts.", createdAt: 1, status: "draft" };
const row = (id: string, role: "user" | "assistant", body: string): ThreadMessage =>
  ({ id, sessionId: "s-1", commentId: "c-1", role, body, status: "complete", createdAt: 2 });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  history.splice(0, history.length, row("m-1", "user", comment.body), row("m-2", "assistant", "Because the parser needs it first."), row("m-3", "user", "And after that?"), row("m-4", "assistant", "It settles."));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const type = (ta: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, value);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
};

it("re-renders the reply box per keystroke, never the transcript above it", async () => {
  await act(async () => root.render(createElement(CommentThread, { sessionId: "s-1", comment })));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Discussion"))!.click());
  expect(host.textContent).toContain("It settles.");
  const settled = markdownRenders.count;
  const ta = host.querySelector("textarea")!;
  for (const value of ["W", "Wh", "Why there?"]) await act(async () => type(ta, value));
  expect(ta.value).toBe("Why there?");
  expect(markdownRenders.count).toBe(settled);
  // The box still owns the shared draft the inline anchor and island read.
  expect(readSharedDraft("redline.sidecarDraft.s-1.c-1")).toBe("Why there?");
});
