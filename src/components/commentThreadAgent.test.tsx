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

/** The small uppercase speaker labels above each bubble. */
const bylines = () =>
  [...host.querySelectorAll("span")]
    .filter((el) => el.style.textTransform === "uppercase")
    .map((el) => el.textContent);

/** Types into a React-controlled textarea the way a keystroke would. */
const type = (ta: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, value);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
};

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
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  localStorage.clear();
  statusReply = idle;
  history = [];
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
  invokeMock.mockImplementation((cmd: string, args?: { backend?: string }) => {
    // The live catalog command (`useModelCatalogs`); the per-backend
    // commands below are what it replaced.
    if (cmd === "model_catalog_snapshot") return Promise.resolve({
      models: args?.backend === "codex"
        ? [{ slug: "gpt-fixture", displayName: "Fixture GPT", description: "", defaultEffort: "high", efforts: ["high", "ultra"] }]
        : [{ slug: "opus", displayName: "opus", description: "", defaultEffort: null, efforts: [] }],
      checkedAt: 1, source: "harness", warning: null,
    });
    if (cmd === "fork_thread_model") return Promise.resolve([null, null]);
    if (cmd === "get_agent_seats") return Promise.resolve({ seats: { fork_plan: { model: "opus", effort: "xhigh" } } });
    if (cmd === "claude_model_catalog") return Promise.resolve([{ id: "opus", label: "opus", alias: true }, { id: "sonnet", label: "sonnet", alias: true }]);
    if (cmd === "codex_model_catalog") return Promise.resolve([{ slug: "gpt-fixture", displayName: "Fixture GPT", description: "", defaultEffort: "high", efforts: ["high", "ultra"] }]);
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
  vi.unstubAllGlobals();
});

describe("CommentThread names the agent that will actually answer", () => {
  it.each(["cursor", "antigravity"])("offers a clearly named Claude sidecar for %s without relabeling the author", async (backend) => {
    await mount(backend);
    expect(text()).toContain("Discuss with Claude sidecar");
    expect(text()).toContain(`this ${backend === "cursor" ? "Cursor" : "Antigravity"} plan`);
    expect(text()).not.toContain(`Discuss with ${backend === "cursor" ? "Cursor" : "Antigravity"}`);
  });

  it("attributes a fallback transcript to Claude sidecar", async () => {
    history = [seed, reply];
    await mount("antigravity");
    expect(text()).toContain("Claude sidecar: Because the parser needs it first.");
    await act(async () => clickWith("Discussion"));
    await flush();
    await act(async () => clickWith("Attach to next submit"));
    await flush();
    const attach = invokeMock.mock.calls.find((call) => call[0] === "attach_discussion");
    expect((attach?.[1] as { note: string }).note).toContain("Following a discussion with Claude sidecar:");
  });

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
    expect(text()).toContain(reply.body);
    expect(bylines()).toEqual(["Codex"]);
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

describe("per-comment discussion model", () => {
  it.each(["claude-code", "codex", "cursor", "antigravity"])("shows a picker beside Discuss for %s", async backend => {
    await mount(backend);
    expect(host.querySelector('[aria-label="Discussion model and effort"]')).not.toBeNull();
    expect(text()).toContain(backend === "codex" ? "Default (Plan model)" : "Default (opus · xhigh)");
  });
  it("persists the comment pick and uses the Codex model's own efforts", async () => {
    await mount("codex");
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Discussion model and effort"]')!;
    trigger.getBoundingClientRect = () => ({ left: 20, right: 220, top: 20, bottom: 48, width: 200, height: 28, x: 20, y: 20, toJSON: () => ({}) });
    await act(async () => trigger.click());
    await flush();
    const model = document.querySelector<HTMLSelectElement>('[aria-label="Discussion model"]')!;
    expect([...model.options].map(option => option.value)).toContain("gpt-fixture");
    await act(async () => { model.value = "gpt-fixture"; model.dispatchEvent(new Event("change", { bubbles: true })); });
    const effort = document.querySelector<HTMLSelectElement>('[aria-label="Discussion effort"]')!;
    expect([...effort.options].map(option => option.value)).toEqual(["", "high", "ultra"]);
    await act(async () => { effort.value = "ultra"; effort.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(invokeMock).toHaveBeenCalledWith("fork_thread_set_model", { sessionId: SESSION, commentId: ITEM, model: "gpt-fixture", effort: "ultra" });
  });
});

describe("one-press Send starts the discussion", () => {
  const sends = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "fork_thread_send");
  const render = (props: Record<string, unknown>, c: Comment = comment) =>
    act(async () => {
      root.render(createElement(CommentThread, { sessionId: SESSION, comment: c, backend: null, ...props }));
    });

  it("sends the comment as the first message exactly once, and survives a remount", async () => {
    const c = { ...comment, id: "c-send-1" };
    const consumed = vi.fn();
    await render({ autoDiscuss: true, onAutoDiscussConsumed: consumed }, c);
    await flush();
    expect(sends()).toHaveLength(1);
    expect(sends()[0][1]).toMatchObject({ commentId: "c-send-1", text: comment.body });
    expect(consumed).toHaveBeenCalled();
    // A remount before the parent cleared the flag must not send it again.
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ autoDiscuss: true, onAutoDiscussConsumed: consumed }, c);
    await flush();
    expect(sends()).toHaveLength(1);
  });

  it("leaves a thread that already has its seed alone", async () => {
    history = [seed, reply];
    await render({ autoDiscuss: true, onAutoDiscussConsumed: () => {} }, { ...comment, id: "c-send-2" });
    await flush();
    expect(sends()).toHaveLength(0);
  });

  it("does nothing without the flag — Save only stays a plain save", async () => {
    await render({}, { ...comment, id: "c-send-3" });
    await flush();
    expect(sends()).toHaveLength(0);
    expect(text()).toContain("Discuss with Claude");
  });
});


describe("discussion modes", () => {
  it("defaults to conversation and sends the mode without changing the user text", async () => {
    await mount("codex");
    expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Conversation");
    await act(async () => clickWith("Discuss with"));
    const send = invokeMock.mock.calls.find(([cmd]) => cmd === "fork_thread_send");
    expect(send?.[1]).toMatchObject({ mode: "conversation", text: comment.body });
  });
  it("persists the toggle and writes a report only on an explicit click", async () => {
    history = [seed, reply];
    await mount(null);
    await act(async () => clickWith("Discussion"));
    expect(text()).not.toContain("Write it up");
    await act(async () => clickWith("Report"));
    expect(localStorage.getItem(`redline.sidecarMode.${SESSION}.${ITEM}`)).toBe("report");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fork_thread_send")).toHaveLength(0);
    expect(text()).toContain("Write it up →");
    await act(async () => clickWith("Write it up"));
    expect(invokeMock.mock.calls.find(([cmd]) => cmd === "fork_thread_send")?.[1]).toMatchObject({ mode: "report", text: "Write this up — the full answer to my original comment given everything we've discussed." });
    expect(text()).not.toContain("Write it up →");
  });
  it("reports visible discussion and promotes questions with their transcript", async () => {
    history = [seed, reply];
    const onHasDiscussion = vi.fn();
    await act(async () => root.render(createElement(CommentThread, { sessionId: SESSION, comment: { ...comment, type: "question" }, autoOpen: true, onHasDiscussion })));
    await flush();
    expect(onHasDiscussion).toHaveBeenCalledWith(true);
    await act(async () => clickWith("Make this a change"));
    expect(invokeMock.mock.calls.find(([cmd]) => cmd === "attach_discussion")?.[1]).toMatchObject({ asChange: true });
  });
});

describe("the discussion reads like a discussion", () => {
  const sends = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "fork_thread_send");

  it("heads the thread \"Discussion\" with no mechanism copy or message count", async () => {
    history = [seed, reply];
    await mount(null);
    const label = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Discussion"))!;
    expect(label.textContent).toBe("▸Discussion");
    expect(label.title).toBe("");
    expect(text()).not.toMatch(/forked|read-only|· 1/);
  });

  it("keeps the controls in the heading row, beside the label", async () => {
    history = [seed, reply];
    await mount(null);
    await act(async () => clickWith("Discussion"));
    const heading = host.querySelector(".rl-thread-heading")!;
    expect(heading.querySelector('[aria-label="Discussion model and effort"]')).not.toBeNull();
    expect([...heading.querySelectorAll("button")].map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["▾Discussion", "A−", "A+", "⤡"]),
    );
  });

  it.each(["cursor", "antigravity"])("says a %s thread is a separate read-only sidecar on hover only", async (backend) => {
    history = [seed, reply];
    await mount(backend);
    const label = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Discussion"))!;
    expect(label.title).toMatch(/separate read-only sidecar/i);
    expect(text()).not.toContain("read-only");
  });

  it("bylines every bubble: You, then the agent", async () => {
    const followUp: ThreadMessage = { ...seed, id: "m-3", body: "And the reader?", createdAt: 4 };
    history = [seed, reply, followUp];
    await mount(null);
    await act(async () => clickWith("Discussion"));
    expect(bylines()).toEqual(["Claude", "You"]);
  });

  it("shows the reply box without a click", async () => {
    history = [seed, reply];
    await mount(null);
    await act(async () => clickWith("Discussion"));
    expect(host.querySelector("textarea")).not.toBeNull();
    expect(text()).not.toContain("Reply…");
  });

  it("lets the reviewer type ahead while a reply streams; only Send waits", async () => {
    history = [seed, reply];
    statusReply = { ...idle, streaming: true, startedAt: 500, partial: "Well,", seq: 1 };
    await mount(null);
    await flush();
    const ta = host.querySelector("textarea")!;
    expect(ta.disabled).toBe(false);
    await act(async () => type(ta, "Next question"));
    expect(ta.value).toBe("Next question");
    await act(async () => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(sends()).toHaveLength(0);
    expect(ta.value).toBe("Next question");
    expect(text()).toContain("Stop");
  });
});

describe("the thread loads without a jump", () => {
  it("holds the entry row's place, invisibly, until the thread has loaded", async () => {
    let release: (rows: ThreadMessage[]) => void = () => {};
    const pending = new Promise<ThreadMessage[]>((resolve) => {
      release = resolve;
    });
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((cmd: string, args?: { backend?: string }) =>
      cmd === "get_thread" ? pending : base(cmd, args),
    );
    await mount(null);
    const row = host.querySelector<HTMLElement>(".rl-thread-entry");
    expect(row, "the row renders before get_thread resolves").not.toBeNull();
    expect(row!.style.visibility).toBe("hidden");
    expect(row!.getAttribute("aria-hidden")).toBe("true");
    await act(async () => release([]));
    await flush();
    const loaded = host.querySelector<HTMLElement>(".rl-thread-entry")!;
    expect(loaded.style.visibility).toBe("");
    expect(loaded.hasAttribute("aria-hidden")).toBe(false);
    expect(text()).toContain("Discuss with Claude");
  });
});
