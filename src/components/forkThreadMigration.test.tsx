// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// T3.2–T3.4 — the three fork-thread consumers on the shared streaming
// lifecycle, tested through the DOM they actually render.
//
// `fork` is the second-busiest prompt surface in the app, and until this batch
// all three consumers hand-rolled their own `listen("fork-*")` blocks:
// appending deltas blindly, discarding the `seq` and `partial` the backend
// already emits. That cost them exactly two things, and this file pins both:
//
//   1. **StrictMode double-subscribe.** Setup→cleanup→setup with an async
//      unlisten leaves two live handlers for a beat; a blind append then
//      doubles the streamed text. (CommentThread documented this by hand with
//      an `alive` closure flag.)
//   2. **A remount mid-turn loses the reply.** The old code probed only
//      `{streaming, startedAt}` and threw away `partial`/`seq`, so reopening a
//      thread mid-turn showed a spinner over a blank bubble and then appended
//      the tail of a sentence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { Comment, DraftComment, TurnStatus } from "../types";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { CommentThread } from "./CommentThread";
import { DrafterSidecar } from "./DrafterSidecar";
import { ReviewThread } from "./ReviewThread";

type Handler = (e: { payload: unknown }) => void;

/** Handlers kept in an ARRAY, not a map: the whole point is to notice when a
 *  component leaves two subscriptions live for the same event. */
let handlers: Map<string, Handler[]>;
let statusReply: TurnStatus;

const idle: TurnStatus = {
  streaming: false,
  startedAt: null,
  partial: null,
  seq: 0,
  queued: [],
};

const emit = (event: string, payload: unknown) => {
  for (const fn of [...(handlers.get(event) ?? [])]) fn({ payload });
};

const SESSION = "s-1";
const ITEM = "c-001";

const comment: Comment = {
  id: ITEM,
  type: "feedback",
  anchorId: "A.1",
  body: "This anchor drifts.",
  createdAt: 1,
  status: "draft",
};

const draftComment: DraftComment = {
  id: ITEM,
  draftId: SESSION,
  blockId: null,
  selCharStart: null,
  selCharEnd: null,
  selQuotedText: "the socket",
  body: "Why a socket here?",
  author: null,
  createdAt: 1,
  forkSessionId: null,
};

/** The three consumers, each with whatever it takes to get its thread on
 *  screen. `open` runs after the first render for a surface that starts
 *  collapsed. */
const CONSUMERS: ReadonlyArray<{
  name: string;
  element: () => ReactElement;
  open?: (host: HTMLElement) => void;
}> = [
  {
    name: "CommentThread",
    element: () =>
      createElement(CommentThread, { sessionId: SESSION, comment }),
  },
  {
    name: "DrafterSidecar",
    element: () =>
      createElement(DrafterSidecar, {
        draftId: SESSION,
        comments: [draftComment],
        focusedId: null,
        onSelect: () => {},
        onDelete: () => {},
        onClose: () => {},
      }),
    // Cards stay cheap until opened — the thread (and its subscription) mounts
    // on the Discuss click.
    open: (host) => {
      const btn = [...host.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes("Discuss"),
      );
      btn?.click();
    },
  },
  {
    name: "ReviewThread",
    element: () =>
      createElement(ReviewThread, { reviewId: SESSION, annotationId: ITEM }),
  },
];

let host: HTMLDivElement;
let root: Root;

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

async function mount(el: ReactElement, open?: (h: HTMLElement) => void) {
  await act(async () => {
    root.render(createElement(StrictMode, null, el));
  });
  await flush();
  if (open) {
    await act(async () => {
      open(host);
    });
    await flush();
  }
}

beforeEach(() => {
  handlers = new Map();
  statusReply = idle;
  listenMock.mockImplementation((event: string, fn: Handler) => {
    const arr = handlers.get(event) ?? [];
    arr.push(fn);
    handlers.set(event, arr);
    return Promise.resolve(() => {
      const cur = handlers.get(event) ?? [];
      const i = cur.indexOf(fn);
      if (i >= 0) cur.splice(i, 1);
    });
  });
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "get_thread") return Promise.resolve([]);
    if (cmd === "fork_thread_status") return Promise.resolve(statusReply);
    return Promise.resolve(null);
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.clearAllMocks();
});

describe.each(CONSUMERS)("$name on the shared turn lifecycle", ({ element, open }) => {
  it("appends a delta exactly once under StrictMode's double mount", async () => {
    // A live turn so the thread body is on screen for every consumer.
    statusReply = { ...idle, streaming: true, startedAt: 500 };
    await mount(element(), open);

    // The stale generation must have unsubscribed. (It is allowed to have
    // registered — StrictMode guarantees it did — but not to still be live.)
    expect(handlers.get("fork-delta")?.length ?? 0).toBe(1);

    await act(async () => {
      emit("fork-delta", {
        sessionId: SESSION,
        commentId: ITEM,
        text: "ZQZQ",
        seq: 1,
      });
    });
    const hits = (host.textContent ?? "").split("ZQZQ").length - 1;
    expect(hits, "a double-subscribed delta renders twice").toBe(1);
  });

  it("restores the partial reply on a remount mid-turn and folds only new deltas", async () => {
    // The turn started, streamed "AB", and the user switched away and back.
    statusReply = { ...idle, streaming: true, startedAt: 500, partial: "AB", seq: 2 };
    await mount(element(), open);
    expect(
      host.textContent,
      "the probe's partial text is the reply so far — dropping it is the bug",
    ).toContain("AB");

    await act(async () => {
      // Already folded into `partial`: the seq guard drops it.
      emit("fork-delta", { sessionId: SESSION, commentId: ITEM, text: "B", seq: 2 });
      emit("fork-delta", { sessionId: SESSION, commentId: ITEM, text: "C", seq: 3 });
    });
    expect(host.textContent).toContain("ABC");
    expect(
      (host.textContent ?? "").includes("ABBC"),
      "a delta the probe already folded in was appended a second time",
    ).toBe(false);
  });

  it("ignores an event for a different thread in the same session", async () => {
    statusReply = { ...idle, streaming: true, startedAt: 500 };
    await mount(element(), open);
    await act(async () => {
      emit("fork-delta", {
        sessionId: SESSION,
        commentId: "c-999",
        text: "WRONGTHREAD",
        seq: 1,
      });
    });
    expect(host.textContent).not.toContain("WRONGTHREAD");
  });

  it("probes the fork registry with scopeId/itemId, not sessionId/commentId", async () => {
    await mount(element(), open);
    const probe = invokeMock.mock.calls.find((c) => c[0] === "fork_thread_status");
    expect(probe?.[1]).toEqual({ scopeId: SESSION, itemId: ITEM });
  });
});
