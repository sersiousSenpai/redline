// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The flow Feedback tab against board 5a's own session: the threads it
// shows, in the words the board uses, and every action wired to the command
// the classic comment pane already sends — nothing new on the backend.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { boardComments, boardSession } from "../../fixtures/flow-feedback-qa/board";
import { resetShellFlagForTests, SHELL_KEY } from "../lib/shellFlag";
import type { Comment, ReviewSession } from "../types";
import FeedbackPanel, { FeedbackComposer, FeedbackTabs, sessionModelLabel } from "./FeedbackPanel";

let host: HTMLDivElement;
let root: Root;

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const text = () => host.textContent ?? "";
const render = async (el: ReactElement) => {
  await act(async () => root.render(el));
  await flush();
};
const button = (label: string, scope: ParentNode = host) => {
  const found = [...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label);
  if (!found) throw new Error(`no button "${label}" in: ${text()}`);
  return found;
};
const cards = () => [...host.querySelectorAll<HTMLElement>("[data-comment-id]")];
const card = (id: string) => host.querySelector<HTMLElement>(`[data-comment-id="${id}"]`)!;
const calls = (command: string) => invokeMock.mock.calls.filter((c) => c[0] === command).map((c) => c[1]);
const type = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

const panel = (over: Partial<Parameters<typeof FeedbackPanel>[0]> = {}) =>
  createElement(FeedbackPanel, {
    session: boardSession,
    viewingVersion: 1,
    onJumpToAnchor: () => {},
    ...over,
  });

/** The board session with v1's comments replaced. */
const withComments = (comments: Comment[]): ReviewSession => ({
  ...boardSession,
  revisions: boardSession.revisions.map((r) => (r.versionNumber === 1 ? { ...r, comments } : r)),
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  localStorage.clear();
  localStorage.setItem(SHELL_KEY, "flow");
  resetShellFlagForTests();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "get_thread") return Promise.resolve([]);
    if (cmd === "fork_thread_status") return Promise.resolve({ streaming: false, startedAt: null, partial: null, seq: 0, queued: [] });
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

describe("board 5a's threads", () => {
  it("one open thread, three resolved, and the rest folded", async () => {
    await render(panel());
    expect(cards().map((c) => c.dataset.commentId)).toEqual(["c-001", "c-002", "c-003", "c-004"]);
    expect(button("12 more resolved")).toBeTruthy();
  });

  it("the open thread reads as the board's: anchor, voice note, status, note, reply, actions", async () => {
    await render(panel());
    const open = card("c-001");
    expect(open.querySelector(".rl-fb-meta")!.textContent).toBe("Context · ¶3·voice noteResolved in v2");
    expect(open.className).toContain("is-current");
    expect(open.className).toContain("rl-glass-sheet");
    expect(open.querySelector(".rl-fb-note")!.textContent).toContain("The pilot firm is my own firm.");
    expect(open.querySelector(".rl-fb-reply")!.textContent).toContain("Done. §3 and §4 now treat R1");
    expect([...open.querySelectorAll(".rl-fb-actions button")].map((b) => b.textContent)).toEqual(["Accept", "Reopen", "Discuss"]);
  });

  it("resolved threads collapse to their anchor, status and note — no actions", async () => {
    await render(panel());
    const labels = ["c-002", "c-003", "c-004"].map((id) => card(id).querySelector(".rl-fb-anchor")!.textContent);
    expect(labels).toEqual(["§4 · step 4", "§4 · releases", "§4"]);
    for (const id of ["c-002", "c-003", "c-004"]) {
      expect(card(id).className).toContain("is-settled");
      expect(card(id).querySelector(".rl-fb-status")!.textContent).toBe("Resolved in v2");
      expect(card(id).querySelector(".rl-fb-actions")).toBeNull();
    }
    expect(card("c-002").querySelector(".rl-fb-note")!.textContent).toBe(
      "Use one shared type-coercion helper for extraction output and human corrections, validated against the call's pinned config.",
    );
  });

  it("never shows a comment's c-0xx id", async () => {
    await render(panel());
    expect(text()).not.toMatch(/c-0\d\d/);
  });

  it("“12 more resolved” brings the rest, and Show fewer folds them", async () => {
    await render(panel());
    await act(async () => button("12 more resolved").click());
    expect(cards()).toHaveLength(16);
    await act(async () => button("Show fewer").click());
    expect(cards()).toHaveLength(4);
  });

  it("an empty revision says how to begin", async () => {
    await render(panel({ viewingVersion: 4 }));
    expect(text()).toContain("Select text in the plan to mark it, or type feedback below.");
  });
});

describe("the actions are the existing comment commands", () => {
  it("✓ Accept accepts the resolution", async () => {
    await render(panel());
    await act(async () => button("Accept", card("c-001")).click());
    expect(calls("accept_resolution")).toEqual([{ sessionId: "qa-dialcrown", commentId: "c-001" }]);
  });

  it("Reopen asks for an optional note, then reopens with it", async () => {
    await render(panel());
    await act(async () => button("Reopen", card("c-001")).click());
    const note = card("c-001").querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => type(note, "  Counsel must be outside the firm.  "));
    await act(async () => button("Reopen", card("c-001")).click());
    expect(calls("reopen_resolution")).toEqual([
      { sessionId: "qa-dialcrown", commentId: "c-001", note: "Counsel must be outside the firm." },
    ]);
  });

  it("Accept and Reopen wait out a Send in flight", async () => {
    await render(panel({ submitInFlight: true }));
    expect(button("Accept", card("c-001")).disabled).toBe(true);
    expect(button("Reopen", card("c-001")).disabled).toBe(true);
  });

  it("an answered question can become a change", async () => {
    const question = { ...boardComments[0], type: "question" as const };
    await render(panel({ session: withComments([question]) }));
    await act(async () => button("Make it a change").click());
    await act(async () => type(card("c-001").querySelector("textarea")!, "Use outside counsel."));
    await act(async () => button("Make it a change").click());
    expect(calls("reopen_resolution")).toEqual([
      { sessionId: "qa-dialcrown", commentId: "c-001", note: "Use outside counsel.", asChange: true },
    ]);
  });

  it("a draft can be edited and deleted", async () => {
    const draft: Comment = { id: "c-100", type: "feedback", anchorId: "A.1.p1", body: "old words", createdAt: 1, status: "draft" };
    await render(panel({ session: withComments([draft]) }));
    expect(card("c-100").querySelector(".rl-fb-status")!.textContent).toBe("Not sent yet");
    await act(async () => button("Edit").click());
    await act(async () => type(card("c-100").querySelector("textarea")!, "new words"));
    await act(async () => button("Save").click());
    expect(calls("update_comment")).toEqual([{ sessionId: "qa-dialcrown", commentId: "c-100", update: { body: "new words" } }]);
    await act(async () => button("Delete").click());
    expect(calls("delete_comment")).toEqual([{ sessionId: "qa-dialcrown", commentId: "c-100" }]);
  });

  it("an agent's suggestion offers Reject, and Accept only when the stage can settle it in the plan", async () => {
    const suggestion: Comment = {
      id: "c-200", type: "edit", anchorId: "A.1.p1", body: "(edit)", createdAt: 1, status: "draft",
      author: "agent-1", edit: { original: "launch-first", revised: "launch-led" },
    };
    await render(panel({ session: withComments([suggestion]) }));
    expect([...card("c-200").querySelectorAll(".rl-fb-actions button")].map((b) => b.textContent)).toEqual(["Reject", "Discuss"]);
    const acceptSuggestion = vi.fn();
    await render(panel({ session: withComments([suggestion]), actions: { acceptSuggestion } }));
    await act(async () => button("Accept").click());
    expect(acceptSuggestion).toHaveBeenCalledWith(suggestion);
  });

  it("the stage's own handlers replace the commands", async () => {
    const accept = vi.fn();
    await render(panel({ actions: { accept } }));
    await act(async () => button("Accept", card("c-001")).click());
    expect(accept).toHaveBeenCalledWith("c-001");
    expect(calls("accept_resolution")).toEqual([]);
  });

  it("💬 Discuss starts the comment's discussion fork on the comment itself", async () => {
    await render(panel());
    await act(async () => button("Discuss", card("c-001")).click());
    await flush();
    const sends = calls("fork_thread_send") as { sessionId: string; commentId: string; text: string }[];
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ sessionId: "qa-dialcrown", commentId: "c-001", text: boardComments[0].body });
  });
});

describe("a click jumps to the anchor", () => {
  it("an open thread's body jumps; its buttons don't", async () => {
    const onJumpToAnchor = vi.fn();
    await render(panel({ onJumpToAnchor }));
    await act(async () => (card("c-001").querySelector(".rl-fb-note") as HTMLElement).click());
    expect(onJumpToAnchor).toHaveBeenLastCalledWith("A.1.p3", "c-001");
    onJumpToAnchor.mockClear();
    await act(async () => button("Reopen", card("c-001")).click());
    expect(onJumpToAnchor).not.toHaveBeenCalled();
  });

  it("a resolved thread jumps and opens to its reply and Reopen", async () => {
    const onJumpToAnchor = vi.fn();
    await render(panel({ onJumpToAnchor }));
    await act(async () => card("c-002").click());
    expect(onJumpToAnchor).toHaveBeenCalledWith("A.4.p1", "c-002");
    expect(card("c-002").className).not.toContain("is-settled");
    expect(card("c-002").querySelector(".rl-fb-reply")!.textContent).toContain("Step 4 now names one helper");
    expect([...card("c-002").querySelectorAll(".rl-fb-actions button")].map((b) => b.textContent)).toEqual(["Reopen", "Discuss"]);
  });

  it("a highlight focused in the plan brings its thread out from the fold", async () => {
    await render(panel({ focusedCommentId: "c-016" }));
    expect(cards()).toHaveLength(16);
    expect(card("c-016").className).not.toContain("is-settled");
  });
});

describe("the header row", () => {
  it("Chat | Feedback 16 … All resolved", async () => {
    const onTab = vi.fn();
    await render(createElement(FeedbackTabs, { tab: "feedback", onTab, count: 16, allResolved: true }));
    const tabs = [...host.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["Chat", "Feedback16"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(text()).toContain("All resolved");
    await act(async () => (tabs[0] as HTMLButtonElement).click());
    expect(onTab).toHaveBeenCalledWith("chat");
  });

  it("says nothing on the right while a thread is still open", async () => {
    await render(createElement(FeedbackTabs, { tab: "chat", onTab: () => {}, count: 3, allResolved: false }));
    expect(text()).not.toContain("All resolved");
  });
});

describe("the composer", () => {
  it("shows the board's hint and model", async () => {
    await render(createElement(FeedbackComposer, { session: boardSession }));
    expect(host.querySelector(".rl-fb-composer-hint")!.textContent).toBe("Select text in the plan, or type feedback…");
    expect(host.querySelector(".rl-fb-composer-model")!.textContent).toBe("Opus 4.5 · High");
  });

  it("↵ adds a note on the plan as a whole through add_comment", async () => {
    await render(createElement(FeedbackComposer, { session: boardSession }));
    const field = host.querySelector("textarea")!;
    await act(async () => type(field, "Ship the iOS track first."));
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(calls("add_comment")).toEqual([
      {
        sessionId: "qa-dialcrown",
        request: { type: "feedback", anchorId: "A", blockId: "blk-title", body: "Ship the iOS track first.", selection: undefined },
      },
    ]);
    expect(field.value).toBe("");
  });

  it("with text selected in the plan, anchors there and says where", async () => {
    const onSubmit = vi.fn();
    const onClearSelection = vi.fn();
    const selection = { anchorId: "A.4.p1", text: "Prove the E911 path", charStart: 120, charEnd: 139, subBlockId: "blk-steps.l5" };
    await render(createElement(FeedbackComposer, { session: boardSession, selection, onSubmit, onClearSelection, modelLabel: "Opus 4.7 · High" }));
    expect(host.querySelector(".rl-fb-composer-anchor")!.textContent).toBe("§4 · step 5");
    expect(host.querySelector(".rl-fb-composer-model")!.textContent).toBe("Opus 4.7 · High");
    const field = host.querySelector("textarea")!;
    await act(async () => type(field, "Before the inbox."));
    await act(async () => button("").click());
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({
      type: "feedback",
      anchorId: "A.4.p1",
      blockId: "blk-steps",
      body: "Before the inbox.",
      selection: { charStart: 120, charEnd: 139, quotedText: "Prove the E911 path", subBlockId: "blk-steps.l5" },
    });
    expect(onClearSelection).toHaveBeenCalled();
    expect(calls("add_comment")).toEqual([]);
  });

  it("the panel brings its own composer unless the stage hands it one", async () => {
    await render(panel());
    expect(host.querySelector(".rl-fb-composer")).not.toBeNull();
    await render(panel({ composer: createElement("div", { id: "stage-composer" }) }));
    expect(host.querySelector("#stage-composer")).not.toBeNull();
    expect(host.querySelector(".rl-fb-composer")).toBeNull();
    await render(panel({ composer: null }));
    expect(host.querySelector(".rl-fb-composer-wrap")).toBeNull();
  });
});

describe("the model chip off the session", () => {
  it.each([
    [{ model: "claude-opus-4-5-20251101", effort: "high", backend: "claude-code" }, "Opus 4.5 · High"],
    [{ model: "claude-sonnet-4-5[1m]", effort: null, backend: null }, "Sonnet 4.5"],
    [{ model: "opus", effort: "xhigh", backend: null }, "Opus · Xhigh"],
    [{ model: "gpt-5.6-sol", effort: "medium", backend: "codex" }, "GPT-5.6-sol · Medium"],
    [{ model: null, effort: null, backend: "codex" }, "Codex"],
    [{ model: null, effort: null, backend: null }, "Claude"],
  ])("%j reads %j", (session, expected) => {
    expect(sessionModelLabel(session)).toBe(expected);
  });
});
