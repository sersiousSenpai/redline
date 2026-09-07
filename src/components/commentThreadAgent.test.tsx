// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A plan comment's discussion forks the session that WROTE the plan, so a
// Codex-authored plan is discussed with Codex (`fork.rs`). The thread is where
// the user learns that, and it has five places to say it — the entry button,
// the assistant bubble, the streaming bubble, the collapsed summary, and the
// transcript that rides back into the next submit. All five must agree, and a
// session with no recorded backend (every plan written before the column
// existed) must still read "Claude".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { Comment, ThreadMessage, TurnStatus } from "../types";

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

const SESSION = "s-1";
const ITEM = "c-001";

const idle: TurnStatus = {
  streaming: false,
  startedAt: null,
  partial: null,
  seq: 0,
  queued: [],
};

const comment: Comment = {
  id: ITEM,
  type: "feedback",
  anchorId: "A.1",
  body: "This anchor drifts.",
  createdAt: 1,
  status: "draft",
};

const reply: ThreadMessage = {
  id: "m-2",
  sessionId: SESSION,
  commentId: ITEM,
  role: "assistant",
  body: "Because the parser needs it first.",
  status: "complete",
  createdAt: 3,
};

/** The seed turn the card already renders as the comment body — the thread
 *  hides it, so history is [hidden seed, reply]. */
const seed: ThreadMessage = {
  id: "m-1",
  sessionId: SESSION,
  commentId: ITEM,
  role: "user",
  body: comment.body,
  status: "complete",
  createdAt: 2,
};

let host: HTMLDivElement;
let root: Root;
let statusReply: TurnStatus;
let history: ThreadMessage[];

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const text = () => host.textContent ?? "";

const clickWith = (needle: string) => {
  const btn = [...host.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(needle),
  );
  if (!btn) throw new Error(`no button matching ${needle}: ${text()}`);
  btn.click();
};

async function mount(backend: string | null) {
  await act(async () => {
    root.render(createElement(CommentThread, { sessionId: SESSION, comment, backend }));
  });
  await flush();
}

beforeEach(() => {
  statusReply = idle;
  history = [];
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "get_thread") return Promise.resolve(history);
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

describe("CommentThread names the agent that will actually answer", () => {
  it("offers Codex on a Codex-authored plan and Claude on a Claude one", async () => {
    await mount("codex");
    expect(text()).toContain("Discuss with Codex");
    expect(text()).not.toContain("Discuss with Claude");

    await act(async () => {
      root.render(
        createElement(CommentThread, {
          sessionId: SESSION,
          comment,
          backend: "claude-code",
        }),
      );
    });
    await flush();
    expect(text()).toContain("Discuss with Claude");
  });

  it("reads Claude for a session with no recorded backend", async () => {
    // Every plan written before `sessions.backend` existed is a Claude plan,
    // and `fork.rs` resolves the same absence the same way.
    await mount(null);
    expect(text()).toContain("Discuss with Claude");
    expect(text()).not.toContain("Codex");
  });

  it("attributes the collapsed summary and the assistant bubble to Codex", async () => {
    history = [seed, reply];
    await mount("codex");

    // Collapsed: the one-line summary.
    expect(text()).toContain("Codex: Because the parser needs it first.");

    // Expanded: the bubble's own speaker label.
    await act(async () => clickWith("Discussion"));
    await flush();
    expect(text()).toContain("Codex");
    expect(text()).not.toContain("Claude");
  });

  it("labels the streaming bubble with the same agent", async () => {
    history = [seed, reply];
    statusReply = { ...idle, streaming: true, startedAt: 500, partial: "Well," , seq: 1 };
    await mount("codex");
    await flush();
    // A live turn auto-expands the thread, so the streaming bubble is on
    // screen with its speaker label.
    expect(text()).toContain("Well,");
    expect(text()).not.toContain("Claude");
  });

  it("escalates a transcript attributed to the agent that wrote it", async () => {
    history = [seed, reply];
    await mount("codex");
    await act(async () => clickWith("Discussion"));
    await flush();
    await act(async () => clickWith("Attach to next submit"));
    await flush();

    const attach = invokeMock.mock.calls.find((c) => c[0] === "attach_discussion");
    expect(attach, "the escalation must reach the backend").toBeTruthy();
    const note = (attach?.[1] as { note: string }).note;
    expect(note).toContain("Following a discussion with Codex:");
    expect(note).toContain("Codex: Because the parser needs it first.");
    expect(note).not.toContain("Claude");
  });
});
