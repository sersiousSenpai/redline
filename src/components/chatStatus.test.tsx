// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// One reply anatomy, pinned on every chat surface (design decision 4): while
// a turn waits for its first token there is exactly ONE status line — the
// bubble's own, never a second indicator stacked under it — and once text
// streams, no caret glyph trails it. Each surface runs on the real bubble
// over a synthetic `useAgentTurn`, so a surface that re-adds its own spinner
// fails here.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comment, Mission } from "../types";

const { turn, handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  turn: {
    messages: [] as Array<Record<string, unknown>>, liveText: "", status: "streaming", startedAt: 1_000, loaded: true,
    meter: null, activity: [] as unknown[], meters: {}, queue: [], retrying: false, steerNotice: null,
    send: () => {}, cancel: () => {}, unqueue: async () => null, clear: () => {}, steer: async () => {}, promote: async () => {},
  },
}));
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: () => turn }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, fn: (e: { payload: unknown }) => void) => {
    handlers.set(event, fn);
    return () => handlers.delete(event);
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("../audio/useReadAloud", () => ({ useReadAloud: () => ({ speaking: false, stop: () => {}, speak: () => {} }) }));
vi.mock("../lib/useDictation", () => ({ useDictation: () => ({ listening: false, partial: "", toggle: () => {} }) }));
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
/** The question in flight, filed under the view it was asked in. */
const asked = (mode?: "chat") => [{ id: "q-1", sessionId: "s-1", commentId: "c-1", role: "user", body: "Why there?", status: "complete", createdAt: 2, mode }];

const SURFACES: Array<{ name: string; render: () => ReturnType<typeof createElement>; setup?: () => void }> = [
  { name: "BrowserChat", render: () => createElement(BrowserChat, { browseId: "b-1", label: "browser-b1", title: "Page", onClose: noop }) },
  { name: "MissionChat", render: () => createElement(MissionChat, { mission, findings: [], onClose: noop, onRemoveFinding: noop, onEditGoal: noop }) },
  { name: "MemoryAsk", render: () => createElement(MemoryAsk, { onCite: noop }) },
  { name: "CommentThread report view", setup: () => { turn.messages = asked(); }, render: () => createElement(CommentThread, { sessionId: "s-1", comment, autoOpen: true }) },
  {
    name: "CommentThread chat view",
    setup: () => { turn.messages = asked("chat"); localStorage.setItem("redline.sidecarView.s-1.c-1", "chat"); },
    render: () => createElement(CommentThread, { sessionId: "s-1", comment, autoOpen: true }),
  },
  { name: "ReviewThread", render: () => createElement(ReviewThread, { reviewId: "r-1", annotationId: "a-1" }) },
  { name: "DraftThread", render: () => createElement(DraftThread, { draftId: "d-1", commentId: "c-1" }) },
];

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  handlers.clear();
  Object.assign(turn, { messages: [], liveText: "", status: "streaming", activity: [], retrying: false });
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
/** Every place the thread says it is working — announced or not. The bubble's
 *  "working…" used to sit unannounced above a second, announced "Thinking". */
const workingWords = () => host.textContent?.match(/working…|Thinking/g) ?? [];

describe.each(SURFACES)("$name", ({ render, setup }) => {
  beforeEach(() => setup?.());

  it("shows one status line while the reply waits for its first token", async () => {
    await mount(render());
    expect(statuses()).toHaveLength(1);
    expect(workingWords()).toHaveLength(1);
  });

  it("streams the reply with no caret glyph after it", async () => {
    turn.liveText = "Because the anchor\n\nmoves with";
    await mount(render());
    expect(host.textContent).toContain("moves with");
    expect(host.textContent).not.toContain("▌");
  });
});

describe("MemoryAsk", () => {
  it("narrates its retrieval in the bubble's one status line", async () => {
    await mount(createElement(MemoryAsk, { onCite: noop }));
    await act(async () => handlers.get("memchat-status")?.({ payload: { threadId: "memchat", label: "Searching the lake for seats" } }));
    expect(statuses()).toEqual(["▸Searching the lake for seats"]);
  });
});

describe("ChatRoom", () => {
  const room = () => createElement(ChatRoom, {
    companionId: "chat-1", onSelectChat: noop, onEmpty: noop, cwd: null, dictationEnabled: false, onClose: noop,
  });

  it("streams the reply with no caret glyph after it", async () => {
    turn.liveText = "Because the anchor\n\nmoves with";
    await mount(room());
    expect(host.textContent).toContain("moves with");
    expect(host.textContent).not.toContain("▌");
  });

  // KNOWN VIOLATION (lane C step 2): the progress strip under the thread
  // (`ChatTurnProgress`) is a second status beside the bubble's. Step 2
  // deletes it — Stop moves into the composer's primary button and the
  // status into the reply's tail row — and flips this to `it`.
  it.fails("shows one status line while the reply waits, and no progress strip", async () => {
    await mount(room());
    expect(host.querySelector("[data-chat-progress]")).toBeNull();
    expect(statuses()).toHaveLength(1);
  });
});
