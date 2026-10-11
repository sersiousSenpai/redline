// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// One reply anatomy, pinned on every chat surface (design decisions 4–6):
// while a turn runs there is exactly ONE status line — the reply's own tail,
// never a progress strip or a second indicator — and no caret glyph; the
// reply streams and settles through `ReplyBlock`, the user's turn is a card
// with no "You"; Stop is the composer's one button and the field is never
// disabled; and a message queued behind the reply waits in a tray above the
// composer on every surface that queues, never in the transcript. Each
// surface runs on the real components over a synthetic `useAgentTurn`, so a
// surface that re-adds its own spinner or bubble fails here.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comment, Mission } from "../types";

const { turn, handlers, turnStore } = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  /** Re-renders every surface reading `turn`, memoized ones included — what a
   *  state change in the real hook does. */
  turnStore: { version: 0, listeners: new Set<() => void>() },
  turn: {
    messages: [] as Array<Record<string, unknown>>, queue: [] as Array<Record<string, unknown>>, liveText: "", status: "streaming", startedAt: 1_000, loaded: true,
    meter: null, activity: [] as unknown[], meters: {}, retrying: false, steerNotice: null,
    send: () => {}, cancel: () => {}, unqueue: async (id: string) => (id === "q-9" ? "and one more thing" : null), clear: () => {}, steer: async () => {}, promote: async () => {},
  },
}));
vi.mock("../hooks/useAgentTurn", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (fn: () => void) => { turnStore.listeners.add(fn); return () => { turnStore.listeners.delete(fn); }; };
  return { useAgentTurn: () => { useSyncExternalStore(subscribe, () => turnStore.version); return turn; } };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, fn: (e: { payload: unknown }) => void) => {
    handlers.set(event, fn);
    return () => handlers.delete(event);
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("../audio/useReadAloud", () => ({ useReadAloud: () => ({ speaking: false, stop: () => {}, speak: () => {} }) }));
vi.mock("../lib/dictationComposer", () => ({ useDictationComposer: () => ({ listening: false, toggle: () => {} }) }));
vi.mock("./DiscussModelChip", () => ({ DiscussModelChip: () => null }));

import { ChatRoom } from "./ChatRoom";
import { BrowserChat } from "./BrowserChat";
import { MissionChat } from "./MissionChat";
import { MemoryAsk } from "./MemoryAsk";
import { CommentThread } from "./CommentThread";
import { ReviewThread } from "./ReviewThread";
import { DraftThread } from "./DrafterSidecar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
const comment: Comment = { id: "c-1", type: "feedback", anchorId: "A.1", body: "This anchor drifts.", createdAt: 1, status: "draft" };
const mission = { missionId: "m-1", title: "Splat survey", goal: "Compare pipelines", createdAt: 1, updatedAt: 1, status: "active" } as unknown as Mission;
const ids = { sessionId: "s-1", commentId: "c-1", companionId: "chat-1", browseId: "b-1", missionId: "m-1" };
/** The question in flight, filed under the view it was asked in. */
const asked = (mode?: "chat") => [{ ...ids, id: "q-1", role: "user", body: "Why there?", status: "complete", createdAt: 2, mode }];
/** …and its answer, settled. */
const answered = (mode?: "chat") => [...asked(mode), { ...ids, id: "a-1", role: "assistant", body: "Because the parser needs it first.", status: "complete", createdAt: 3, mode }];

interface Surface {
  name: string;
  render: () => ReturnType<typeof createElement>;
  /** Enter during a reply queues the message (the rest reject while busy). */
  queues: boolean;
  /** An empty box shows the mic rather than a send with nothing to send. */
  mic?: boolean;
  /** Which view a turn files under, for the plan comment's two. */
  mode?: "chat";
  setup?: () => void;
}
const SURFACES: Surface[] = [
  { name: "ChatRoom", queues: true, render: () => createElement(ChatRoom, { companionId: "chat-1", onSelectChat: noop, onEmpty: noop, cwd: null, onClose: noop }) },
  { name: "BrowserChat", queues: true, mic: true, render: () => createElement(BrowserChat, { conversation: { kind: "tab", browseId: "b-1", title: "Page", targetLabel: "browser-b1", targetBrowseId: "b-1", targetTitle: "Page", targetNumber: 1, scope: "pinned-page", anchoredFrom: null, exception: false }, workspace: "regular", onClose: noop }) },
  { name: "MissionChat", queues: true, render: () => createElement(MissionChat, { mission, findings: [], onClose: noop, onRemoveFinding: noop, onEditGoal: noop }) },
  { name: "MemoryAsk", queues: true, render: () => createElement(MemoryAsk, { onCite: noop }) },
  { name: "CommentThread report view", queues: false, render: () => createElement(CommentThread, { sessionId: "s-1", comment, autoOpen: true }) },
  {
    name: "CommentThread chat view",
    queues: false,
    mode: "chat",
    setup: () => localStorage.setItem("redline.sidecarView.s-1.c-1", "chat"),
    render: () => createElement(CommentThread, { sessionId: "s-1", comment, autoOpen: true }),
  },
  { name: "ReviewThread", queues: false, render: () => createElement(ReviewThread, { reviewId: "r-1", annotationId: "a-1" }) },
  { name: "DraftThread", queues: false, render: () => createElement(DraftThread, { draftId: "d-1", commentId: "c-1" }) },
];

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  handlers.clear();
  Object.assign(turn, { messages: [], queue: [], liveText: "", status: "streaming", startedAt: Date.now(), activity: [], retrying: false });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const mount = (element: ReturnType<typeof createElement>) => act(async () => root.render(element));
const statuses = () => Array.from(host.querySelectorAll("[role=status]")).map((el) => el.textContent?.trim());
/** Every place the thread says it is working — announced or not. */
const workingWords = () => host.textContent?.match(/working…|Thinking|Preparing your reply/g) ?? [];
const field = () => Array.from(host.querySelectorAll("textarea")).pop()!;

describe.each(SURFACES)("$name", ({ render, setup, queues, mic, mode }) => {
  beforeEach(() => {
    setup?.();
    turn.messages = asked(mode);
  });

  it("shows one status line while the reply waits for its first token, and no progress strip", async () => {
    await mount(render());
    expect(statuses()).toEqual(["Preparing your reply"]);
    expect(workingWords()).toHaveLength(1);
    expect(host.querySelector("[data-chat-progress]")).toBeNull();
    // That line is the live reply's own tail.
    expect(host.querySelector('[data-reply="live"] [data-reply-tail] [role=status]')).not.toBeNull();
  });

  it("streams the reply through the shared anatomy with no caret glyph after it", async () => {
    turn.liveText = "Because the anchor\n\nmoves with";
    await mount(render());
    expect(host.querySelector('[data-reply="live"] .rl-reply-text')?.textContent).toContain("moves with");
    expect(host.textContent).not.toContain("▌");
    expect(statuses()).toEqual(["Writing the reply"]);
  });

  it("puts Stop in the composer's one button and never disables the field", async () => {
    await mount(render());
    expect(field().disabled).toBe(false);
    const stop = host.querySelector<HTMLButtonElement>('.rl-send[data-send="stop"]');
    expect(stop).not.toBeNull();
    expect(stop!.disabled).toBe(false);
    expect(Array.from(host.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Stop")).toEqual([]);
    // Stopped from the keyboard, the reply ends on an empty box: the same
    // button turns into a Send with nothing to send (or the mic, where the
    // box takes speech), and the focus stays in the composer. A `disabled`
    // button would drop it to the document.
    stop!.focus();
    turn.status = "idle";
    await act(async () => { turnStore.version++; turnStore.listeners.forEach((fn) => fn()); });
    const send = host.querySelector<HTMLButtonElement>(".rl-send")!;
    expect(send).toBe(stop);
    expect(send.dataset.send).toBe(mic ? "mic" : "send");
    expect(send.disabled).toBe(false);
    expect(send.getAttribute("aria-disabled")).toBe(mic ? null : "true");
    expect([send, field()]).toContain(document.activeElement);
  });

  it("settles a reply through the anatomy, under the question as a card with no You", async () => {
    Object.assign(turn, { status: "idle", messages: answered(mode) });
    await mount(render());
    expect(host.querySelector('[data-reply="settled"] .rl-reply-text')?.textContent).toContain("Because the parser needs it first.");
    expect(host.querySelector('[data-reply="settled"] .rl-reply-byline')?.textContent).toBe("Claude");
    expect(host.querySelector("[data-user-turn]")?.textContent).toContain("Why there?");
    expect(host.textContent).not.toMatch(/\bYou\b/);
    expect(statuses()).toEqual([]);
  });

  if (queues) {
    it("shows a queued message in the tray above the composer, and × puts it back in the field", async () => {
      turn.queue = [{ ...ids, id: "q-9", role: "user", body: "and one more thing", status: "queued", createdAt: 4 }];
      await mount(render());
      const tray = host.querySelector('[aria-label="Queued messages"]')!;
      expect(tray.textContent).toContain("1 queued");
      expect(tray.textContent).toContain("and one more thing");
      // Over the thread, not in it: no queued row joins the transcript.
      expect(tray.closest(".rl-queue-anchor")).not.toBeNull();
      expect(host.querySelectorAll("[data-user-turn]")).toHaveLength(1);
      await act(async () => tray.querySelector<HTMLButtonElement>(".rl-queue-pill")!.click());
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Unqueue and one more thing"]')!.click());
      expect(field().value).toContain("and one more thing");
    });
  }
});

describe("MemoryAsk", () => {
  it("narrates its retrieval in the reply's one status line", async () => {
    await mount(createElement(MemoryAsk, { onCite: noop }));
    await act(async () => handlers.get("memchat-status")?.({ payload: { threadId: "memchat", label: "Searching the lake for seats" } }));
    expect(statuses()).toEqual(["Searching the lake for seats"]);
  });
});

describe("in-turn notices", () => {
  it("end the chat room's thread as a quiet note instead of a bar above it", async () => {
    Object.assign(turn, { messages: asked(), steerNotice: "Interrupted the previous turn and sent your instruction next" });
    try {
      await mount(createElement(ChatRoom, { companionId: "chat-1", onSelectChat: noop, onEmpty: noop, cwd: null, onClose: noop }));
      const note = host.querySelector(".rl-thread-note")!;
      expect(note.textContent).toContain("Interrupted the previous turn");
      // Inside the scrolling thread, after the live reply.
      expect(note.closest("[data-chat-messages]")).not.toBeNull();
      expect(note.previousElementSibling?.matches('[data-reply="live"]')).toBe(true);
      expect(statuses()).toHaveLength(1);
    } finally {
      turn.steerNotice = null;
    }
  });
});
