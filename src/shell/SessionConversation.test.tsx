// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConvoBatch, ConvoEvent, SubmitResult } from "../lib/convo/types";

const { api, log } = vi.hoisted(() => {
  const log: string[] = [];
  const api = {
    batches: new Map<string, (batch: ConvoBatch) => void>(),
    snapshot: [] as ConvoEvent[],
    submit: { status: "sent" } as SubmitResult,
    /** Holds `convo_subscribe`'s reply until released. */
    hold: null as null | (() => void),
  };
  return { api, log };
});
vi.mock("../lib/convo/api", () => ({
  convoSubscribe: vi.fn(async (terminalId: string, onBatch: (batch: ConvoBatch) => void) => {
    log.push(`subscribe ${terminalId}`);
    api.batches.set(terminalId, onBatch);
    if (api.hold) await new Promise<void>((resolve) => (api.hold = resolve));
    return { subscriptionId: `sub-${terminalId}`, events: api.snapshot, hasOlder: false };
  }),
  convoUnsubscribe: vi.fn(async (terminalId: string, id: string) => void log.push(`unsubscribe ${terminalId} ${id}`)),
  convoPage: vi.fn(async () => ({ events: [], hasOlder: false })),
  convoExpect: vi.fn(async (terminalId: string, nonce: string, text: string) => void log.push(`expect ${terminalId} ${text} ${nonce.length > 0}`)),
  ptySubmit: vi.fn(async (terminalId: string, text: string) => {
    log.push(`submit ${terminalId} ${text}`);
    return api.submit;
  }),
  ptyInterrupt: vi.fn(async (terminalId: string) => void log.push(`interrupt ${terminalId}`)),
  answerAsk: vi.fn(async () => {}),
  convoSetMode: vi.fn(async () => ({ status: "sent" })),
  convoSetModel: vi.fn(async () => ({ status: "sent" })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null, Channel: class {} }));
vi.mock("../lib/dictationComposer", () => ({ useDictationComposer: () => ({ listening: false, toggle: () => {} }) }));
vi.mock("../components/MarkdownView", () => ({ MarkdownView: ({ body }: { body: string }) => <div data-md>{body}</div> }));
import SessionConversation, { type SessionConversationProps } from "./SessionConversation";
import { FLOW_TALK_EVENT } from "./SessionComposer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const ev = (id: string, offset: number, body: Record<string, unknown>): ConvoEvent => ({ id, epoch: 0, offset, ts: 1_000 + offset, ...body }) as ConvoEvent;
const PROMPT = ev("u1", 10, { kind: "user_text", text: "Plan the roadmap" });
const READ = ev("t1", 20, { kind: "tool_use", toolUseId: "tu1", name: "Read", summary: "/p/din/docs/a.md" });
const DONE = ev("r1", 30, { kind: "tool_result", toolUseId: "tu1", isError: false, preview: "" });
const BOUND = ev("b", 0, { kind: "bound", harness: "claude", sessionId: "s1", transcriptPath: null, source: "startup" });

function props(over: Partial<SessionConversationProps> = {}): SessionConversationProps {
  return {
    terminalId: "term-1",
    sessionId: "s1",
    harness: "claude",
    layout: "stage",
    planOpen: false,
    onOpenPlan: vi.fn(),
    onShowTerminal: vi.fn(),
    projectPath: "/p/din",
    ...over,
  };
}
async function render(p: SessionConversationProps) {
  await act(async () => root.render(<SessionConversation {...p} />));
  await flush();
}
const q = (selector: string) => host.querySelector(selector);
const all = (selector: string) => [...host.querySelectorAll(selector)];
async function typeAndSend(text: string) {
  const field = q(".rl-convo-field") as HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await flush();
}

beforeEach(() => {
  log.length = 0;
  api.batches.clear();
  api.snapshot = [BOUND, PROMPT, READ, DONE];
  api.submit = { status: "sent" };
  api.hold = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("SessionConversation", () => {
  it("subscribes to its terminal and draws the tail it gets back", async () => {
    await render(props());
    expect(log).toEqual(["subscribe term-1"]);
    expect(q(".rl-convo-bubble")?.textContent).toBe("Plan the roadmap");
    expect(all(".rl-convo-tool").map((e) => e.textContent)).toEqual(["Readdocs/a.md"]);
    expect(q(".rl-convo")?.getAttribute("data-layout")).toBe("stage");
  });

  it("a new terminal is a new subscription; unmounting ends it", async () => {
    await render(props());
    await render(props({ terminalId: "term-2" }));
    expect(log).toEqual(["subscribe term-1", "unsubscribe term-1 sub-term-1", "subscribe term-2"]);
    await act(async () => root.render(<div />));
    await flush();
    expect(log[log.length - 1]).toBe("unsubscribe term-2 sub-term-2");
  });

  it("a batch that beats the snapshot onto the channel is kept", async () => {
    api.hold = () => {};
    await render(props());
    await act(async () => api.batches.get("term-1")!({ events: [ev("a1", 40, { kind: "assistant_text", text: "Early words" })] }));
    await act(async () => api.hold!());
    await flush();
    expect(q("[data-md]")?.textContent).toBe("Early words");
    expect(q(".rl-convo-bubble")?.textContent).toBe("Plan the roadmap");
  });

  it("Enter announces the send, types it, and shows the bubble at once", async () => {
    await render(props());
    await typeAndSend("Also check D3");
    expect(log.slice(1)).toEqual(["expect term-1 Also check D3 true", "submit term-1 Also check D3"]);
    expect(all(".rl-convo-bubble").map((e) => e.textContent)).toContain("Also check D3");
  });

  it("a submit the PTY refuses goes to the queue instead of vanishing", async () => {
    api.submit = { status: "blocked", blocker: "native_dialog" };
    await render(props());
    await typeAndSend("Wait for me");
    expect(all(".rl-convo-bubble").map((e) => e.textContent)).not.toContain("Wait for me");
    expect(q(".rl-queue-count")?.textContent).toBe("1 queued");
  });

  it("sends wait while the host says not ready, then go in order when it is", async () => {
    api.snapshot = [BOUND, PROMPT, ev("h1", 15, { kind: "readiness", ready: false, blocker: "dirty_input" })];
    await render(props());
    expect(q(".rl-convo-readiness")?.textContent).toMatch(/unsent text in the terminal.*Open Terminal/);
    await typeAndSend("one");
    await typeAndSend("two");
    expect(log.filter((l) => l.startsWith("submit"))).toEqual([]);
    expect(q(".rl-queue-count")?.textContent).toBe("2 queued");
    await act(async () => api.batches.get("term-1")!({ events: [ev("h2", 60, { kind: "readiness", ready: true, blocker: null })] }));
    for (let i = 0; i < 4; i++) await flush();
    expect(log.filter((l) => l.startsWith("submit"))).toEqual(["submit term-1 one", "submit term-1 two"]);
    expect(q(".rl-queue-count")).toBeNull();
  });

  it("with no terminal yet, sends wait in the queue and nothing subscribes", async () => {
    await render(props({ terminalId: null }));
    expect(log).toEqual([]);
    expect(q(".rl-convo-readiness")?.textContent).toMatch(/no terminal yet/);
    await typeAndSend("First thought");
    expect(q(".rl-queue-count")?.textContent).toBe("1 queued");
  });

  it("the plan reads as Plan ready while its panel is open, and one line while closed", async () => {
    api.snapshot = [BOUND, PROMPT, ev("p", 40, { kind: "plan_proposed", toolUseId: "x", sessionId: "s1", title: "Roadmap" }), ev("e", 50, { kind: "turn_end", durationMs: 1000 })];
    const onOpenPlan = vi.fn();
    await render(props({ planOpen: true, onOpenPlan, planMarkdown: "## A\n1. x\n2. y\n" }));
    expect(q(".rl-convo-plan-body")?.textContent).toBe("1 section · 2 steps. Mark anything you'd change, then approve.");
    await render(props({ planOpen: false, onOpenPlan, planTitle: "Roadmap", planMarks: 2 }));
    expect(q(".rl-convo-inline-plan")?.textContent).toBe("Plan · Roadmap2 marksOpen");
    await act(async () => (q(".rl-convo-inline-plan") as HTMLButtonElement).click());
    expect(onOpenPlan).toHaveBeenCalledTimes(1);
  });

  it("Stop on the working row presses Esc in the PTY", async () => {
    await render(props());
    await act(async () => (q(".rl-convo-stop") as HTMLButtonElement).click());
    expect(log).toContain("interrupt term-1");
  });

  it("a Codex session no second client can read says so, opens its terminal once, and has no composer", async () => {
    api.snapshot = [ev("b", 0, { kind: "bound", harness: "codex", sessionId: "t1", transcriptPath: null, source: "prompt", mirrored: false })];
    const onShowTerminal = vi.fn();
    await render(props({ harness: "codex", sessionId: "t1", terminalId: "term-cx", onShowTerminal }));
    expect(q(".rl-convo-note")?.textContent).toBe("This Codex session is shown in its terminal. Open Terminal");
    expect(q(".rl-convo-dock")).toBeNull();
    expect(onShowTerminal).toHaveBeenCalledTimes(1);
    // Back on the conversation (remounted), the reader's own toggle wins.
    await act(async () => root.render(<div />));
    await render(props({ harness: "codex", sessionId: "t1", terminalId: "term-cx", onShowTerminal }));
    expect(onShowTerminal).toHaveBeenCalledTimes(1);
    // A mirrored Codex session is drawn like any other.
    api.snapshot = [ev("b", 0, { kind: "bound", harness: "codex", sessionId: "t2", transcriptPath: null, source: "prompt" }), PROMPT];
    await render(props({ harness: "codex", sessionId: "t2", terminalId: "term-cx2", onShowTerminal }));
    expect(q(".rl-convo-note")).toBeNull();
    expect(q(".rl-convo-dock")).not.toBeNull();
    expect(q(".rl-convo-bubble")?.textContent).toBe("Plan the roadmap");
  });

  it("Talk without a handler asks the app for the voice panel", async () => {
    const heard = vi.fn();
    window.addEventListener(FLOW_TALK_EVENT, heard);
    await render(props());
    await act(async () => (q(".rl-convo-talk") as HTMLButtonElement).click());
    window.removeEventListener(FLOW_TALK_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({ terminalId: "term-1", sessionId: "s1" });
  });
});

describe("a question never waits out of sight", () => {
  const QUESTION = ev("a1", 40, { kind: "ask_opened", ask: { askId: "q1", kind: "question", toolName: "AskUserQuestion", summary: "Which key?", questions: [{ question: "Which key?", options: [{ label: "A" }] }], openedAt: 1 } });
  const PERMISSION = ev("a2", 41, { kind: "ask_opened", ask: { askId: "p1", kind: "permission", toolName: "Bash", summary: "npm test", openedAt: 1 } });
  const released = async () => {
    const { answerAsk } = await import("../lib/convo/api");
    return (answerAsk as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  };
  beforeEach(async () => {
    const { answerAsk } = await import("../lib/convo/api");
    (answerAsk as unknown as { mockClear: () => void }).mockClear();
  });

  it("on screen, the question waits as its card", async () => {
    api.snapshot = [BOUND, PROMPT, QUESTION, PERMISSION];
    await render(props());
    expect(await released()).toEqual([]);
    expect(all(".rl-ask-card")).toHaveLength(2);
  });

  it("hidden, open questions go to the terminal — once, and never a permission ask — and it stays subscribed", async () => {
    api.snapshot = [BOUND, PROMPT, QUESTION, PERMISSION];
    await render(props({ hidden: true }));
    expect(await released()).toEqual([["q1", { kind: "terminal" }]]);
    await render(props({ hidden: true }));
    expect(await released()).toHaveLength(1);
    expect(log).toEqual(["subscribe term-1"]);
  });

  it("a question that arrives while hidden goes straight to the terminal", async () => {
    await render(props({ hidden: true }));
    expect(await released()).toEqual([]);
    await act(async () => api.batches.get("term-1")!({ events: [QUESTION] }));
    await flush();
    expect(await released()).toEqual([["q1", { kind: "terminal" }]]);
  });

  it("hiding releases what is open; leaving the stage does too", async () => {
    api.snapshot = [BOUND, PROMPT, QUESTION];
    await render(props());
    expect(await released()).toEqual([]);
    await render(props({ hidden: true }));
    expect(await released()).toEqual([["q1", { kind: "terminal" }]]);
    const other = ev("a3", 42, { kind: "ask_opened", ask: { askId: "q2", kind: "question", toolName: "AskUserQuestion", summary: "Which lock?", openedAt: 2 } });
    await render(props());
    await act(async () => api.batches.get("term-1")!({ events: [other] }));
    await flush();
    expect(await released()).toHaveLength(1);
    await act(async () => root.unmount());
    expect(await released()).toEqual([["q1", { kind: "terminal" }], ["q2", { kind: "terminal" }]]);
    root = createRoot(host);
  });
});
