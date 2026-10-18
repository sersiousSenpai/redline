// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The comment card and its discussion in the flow shell (C4): no c-0xx id
// chip, no per-thread model chip, the anchor by its human label, and a
// resolved card collapsed to two lines. The classic shell renders all of it
// exactly as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { Comment } from "../types";
import { resetShellFlagForTests, SHELL_KEY } from "../lib/shellFlag";
import { AnchorPill } from "./AnchorPill";
import { CommentCard } from "./CommentCard";
import { CommentThread } from "./CommentThread";

let host: HTMLDivElement;
let root: Root;

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const text = () => host.textContent ?? "";

const accepted: Comment = {
  id: "c-007",
  type: "feedback",
  anchorId: "A.4.p1",
  body: "Use one shared type-coercion helper for extraction output and human corrections, validated against the call's pinned config, everywhere.",
  createdAt: 1,
  status: "accepted",
  resolution: { body: "Done.", appearedInVersion: 2, acceptedAt: 1 },
};
const draft: Comment = { id: "c-008", type: "feedback", anchorId: "A.1", body: "Say why.", createdAt: 2, status: "draft" };

function shell(name: "classic" | "flow") {
  localStorage.setItem(SHELL_KEY, name);
  resetShellFlagForTests();
}

async function card(comment: Comment, anchorLabel?: string) {
  await act(async () =>
    root.render(
      createElement(CommentCard, {
        comment,
        sessionId: "s-1",
        anchorLabel,
        onDelete: () => {},
        onAccept: () => {},
        onReopen: () => {},
        onPromote: () => {},
      }),
    ),
  );
  await flush();
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  localStorage.clear();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "get_thread") return Promise.resolve([]);
    if (cmd === "fork_thread_status") return Promise.resolve({ streaming: false, startedAt: null, partial: null, seq: 0, queued: [] });
    if (cmd === "fork_thread_model") return Promise.resolve([null, null]);
    if (cmd === "get_agent_seats") return Promise.resolve({ seats: {} });
    if (cmd === "model_catalog_snapshot") return Promise.resolve({ models: [], checkedAt: 1, source: "harness", warning: null });
    return Promise.resolve(null);
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  resetShellFlagForTests();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("classic is unchanged", () => {
  beforeEach(() => shell("classic"));

  it("the card shows its id, its positional anchor and a one-line collapse", async () => {
    await card(accepted, "§4 · step 4");
    expect(text()).toContain("c-007");
    expect(text()).toContain("§A.4.p1");
    expect(text()).not.toContain("§4 · step 4");
    expect(host.querySelector(".truncate")).not.toBeNull();
    expect(host.querySelector(".rl-comment-preview-2")).toBeNull();
  });

  it("the discussion keeps its model chip", async () => {
    await card(draft);
    expect(host.querySelector(".rl-fd-model-chip")).not.toBeNull();
  });

  it("the pill names the id", async () => {
    await act(async () => root.render(createElement(AnchorPill, { anchorId: "A.1.p3", label: "Context · ¶3" })));
    expect(text()).toBe("§A.1.p3");
  });
});

describe("flow", () => {
  beforeEach(() => shell("flow"));

  it("the card drops the c-0xx chip and names its anchor", async () => {
    await card(accepted, "§4 · step 4");
    expect(text()).not.toContain("c-007");
    expect(text()).toContain("§4 · step 4");
    expect(text()).not.toContain("§A.4.p1");
  });

  it("a resolved card collapses to two clamped lines of its whole note", async () => {
    await card(accepted, "§4 · step 4");
    const preview = host.querySelector(".rl-comment-preview-2");
    expect(preview?.textContent).toBe(accepted.body);
    expect(host.querySelector(".truncate")).toBeNull();
  });

  it("the discussion has no per-thread model chip", async () => {
    await card(draft);
    expect(text()).toContain("Discuss with Claude");
    expect(host.querySelector(".rl-fd-model-chip")).toBeNull();
  });

  it("without a label the pill still names the id", async () => {
    await act(async () => root.render(createElement(AnchorPill, { anchorId: "A.1.p3" })));
    expect(text()).toBe("§A.1.p3");
  });
});

describe("a thread whose host owns the way in", () => {
  beforeEach(() => shell("flow"));

  const thread = (discussNonce: number) =>
    act(async () =>
      root.render(createElement(CommentThread, { sessionId: "s-1", comment: draft, hideEntry: true, discussNonce })),
    );

  it("renders nothing until there is a discussion", async () => {
    await thread(0);
    await flush();
    expect(host.innerHTML).toBe("");
  });

  it("each Discuss press opens it, starting it on the comment when empty", async () => {
    await thread(0);
    await flush();
    await thread(1);
    await flush();
    const sends = invokeMock.mock.calls.filter((c) => c[0] === "fork_thread_send");
    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toMatchObject({ sessionId: "s-1", commentId: "c-008", text: "Say why." });
    // A re-render with the same press sends nothing more.
    await thread(1);
    await flush();
    expect(invokeMock.mock.calls.filter((c) => c[0] === "fork_thread_send")).toHaveLength(1);
  });
});
