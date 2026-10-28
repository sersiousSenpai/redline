// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConvoBatch, ConvoEvent, QueueResult, SteerResult, SubmitResult } from "./convo/types";

const { api, log } = vi.hoisted(() => {
  const log: string[] = [];
  const api = {
    batches: new Map<string, (batch: ConvoBatch) => void>(),
    snapshot: [] as ConvoEvent[],
    submit: { status: "sent" } as SubmitResult,
    /** What `convo_queue` answers: idle unless a test holds sends. */
    queue: { status: "idle" } as QueueResult,
    steer: { status: "sent" } as SteerResult,
    screen: "",
    /** Holds `convo_subscribe`'s reply until released. */
    hold: null as null | (() => void),
  };
  return { api, log };
});
vi.mock("./convo/api", () => ({
  convoSubscribe: vi.fn(async (terminalId: string, onBatch: (batch: ConvoBatch) => void) => {
    log.push(`subscribe ${terminalId}`);
    api.batches.set(terminalId, onBatch);
    if (api.hold) await new Promise<void>((resolve) => (api.hold = resolve));
    return { subscriptionId: `sub-${terminalId}`, events: api.snapshot, hasOlder: false };
  }),
  convoUnsubscribe: vi.fn(async (terminalId: string, id: string) => void log.push(`unsubscribe ${terminalId} ${id}`)),
  convoPage: vi.fn(async () => ({ events: [], hasOlder: false })),
  convoExpect: vi.fn(async (terminalId: string, nonce: string, text: string) => void log.push(`expect ${terminalId} ${text} ${nonce.length > 0}`)),
  convoQueue: vi.fn(async (terminalId: string, _id: string, text: string) => {
    log.push(`queue ${terminalId} ${text}`);
    return api.queue;
  }),
  convoUnqueue: vi.fn(async (terminalId: string, id: string) => {
    log.push(`unqueue ${terminalId} ${id}`);
    return `text of ${id}`;
  }),
  convoSteer: vi.fn(async (terminalId: string, id: string) => {
    log.push(`steer ${terminalId} ${id}`);
    return api.steer;
  }),
  ptySubmit: vi.fn(async (terminalId: string, text: string) => {
    log.push(`submit ${terminalId} ${text}`);
    return api.submit;
  }),
  ptyInterrupt: vi.fn(async (terminalId: string) => void log.push(`interrupt ${terminalId}`)),
  interruptTerminal: vi.fn(async (terminalId: string) => void log.push(`interrupt ${terminalId}`)),
  answerAsk: vi.fn(async () => {}),
  ptyScreenTail: vi.fn(async () => api.screen),
  ptyKeys: vi.fn(async (terminalId: string, data: string) => void log.push(`keys ${terminalId} ${JSON.stringify(data)}`)),
  convoSetMode: vi.fn(async () => ({ status: "sent" })),
  convoSetModel: vi.fn(async () => ({ status: "sent" })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null, Channel: class {} }));
vi.mock("../../lib/dictationComposer", () => ({ useDictationComposer: () => ({ listening: false, toggle: () => {} }) }));
vi.mock("../MarkdownView", () => ({ MarkdownView: ({ body }: { body: string }) => <div data-md>{body}</div> }));
import SessionConversation, { type SessionConversationProps } from "./SessionConversation";
import { FLOW_TALK_EVENT } from "./SessionComposer";
import { convoExpect } from "./convo/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
/** Past a hold release's settle (RELEASE_SETTLE_MS), then the sends' turns. */
const settle = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 1_600)); });
  for (let i = 0; i < 6; i++) await flush();
};
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
  sessionStorage.clear();
  log.length = 0;
  api.batches.clear();
  api.snapshot = [BOUND, PROMPT, READ, DONE];
  api.submit = { status: "sent" };
  api.queue = { status: "idle" };
  api.steer = { status: "sent" };
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

  it("Enter asks the outbox first, then announces the send, types it, and shows the bubble at once", async () => {
    await render(props());
    await typeAndSend("Also check D3");
    expect(log.slice(1)).toEqual(["queue term-1 Also check D3", "expect term-1 Also check D3 true", "submit term-1 Also check D3"]);
    expect(all(".rl-convo-bubble").map((e) => e.textContent)).toContain("Also check D3");
  });

  it("a submit the PTY refuses goes to the queue instead of vanishing", async () => {
    api.submit = { status: "blocked", blocker: "native_dialog" };
    await render(props());
    await typeAndSend("Wait for me");
    expect(all(".rl-convo-bubble").map((e) => e.textContent)).not.toContain("Wait for me");
    expect(q(".rl-work-drawer-count")?.textContent).toBe("Queued · 1");
  });

  it("a dialog the CLI holds with no card behind it is never a bare Needs you: the card sends you to the terminal", async () => {
    api.snapshot = [BOUND, PROMPT, ev("h1", 15, { kind: "readiness", ready: false, blocker: "native_dialog" })];
    const onShowTerminal = vi.fn();
    await render(props({ onShowTerminal }));
    expect(q('[data-ask="terminal"]')?.textContent).toContain("Claude is asking in the terminal");
    await act(async () => (q('[data-ask="terminal"] .rl-ask-terminal') as HTMLButtonElement).click());
    expect(onShowTerminal).toHaveBeenCalled();
    await act(async () => api.batches.get("term-1")!({ events: [ev("h2", 60, { kind: "readiness", ready: true, blocker: null })] }));
    expect(q('[data-ask="terminal"]')).toBeNull();
  });

  it("the CLI's own \"Ready to code?\" read off its terminal is the Ready to build card, answered with a person's keys", async () => {
    api.screen = "Claude has written up a plan and is ready to execute. Would you like to proceed?\n\n ❯ 1. Yes, and use auto mode\n   2. Yes, manually approve edits\n   3. Tell Claude what to change\n      shift+tab to approve with this feedback\n\n ctrl+g to edit in Vim · ~/.claude/plans/x.md\n";
    api.snapshot = [BOUND, PROMPT, ev("h1", 15, { kind: "readiness", ready: false, blocker: "native_dialog" })];
    const onShowTerminal = vi.fn();
    await render(props({ onShowTerminal }));
    await flush();
    expect(q('[data-ask="proceed"]')?.textContent).toContain("Ready to build this plan?");
    expect(q('[data-ask="terminal"]')).toBeNull();
    const yes = [...host.querySelectorAll<HTMLButtonElement>('[data-ask="proceed"] .rl-ask-btn')][0];
    expect(yes.textContent).toContain("Yes, build");
    await act(async () => yes.click());
    await flush();
    expect(log.filter((l) => l.startsWith("keys"))).toEqual(['keys term-1 "\\r"']);
    // Its other choice is the prompt's own words, and goes to the terminal.
    expect([...host.querySelectorAll('[data-ask="proceed"] .rl-ask-btn')].map((b) => b.textContent)).toContain("Tell Claude what to change");
    await act(async () => (q('[data-ask="proceed"] .rl-ask-terminal') as HTMLButtonElement).click());
    expect(onShowTerminal).toHaveBeenCalled();
    api.screen = "";
  });

  it("a tool permission the CLI asks itself (no hook armed a card) is a card too, answered with a person's keys", async () => {
    api.screen = " Do you want to create notes.txt?\n ❯ 1. Yes\n   2. Yes, allow all edits during this session (shift+tab)\n   3. No, and tell Claude what to do differently (esc)\n";
    api.snapshot = [BOUND, PROMPT, ev("h1", 15, { kind: "readiness", ready: false, blocker: "native_dialog" })];
    const onShowTerminal = vi.fn();
    await render(props({ onShowTerminal }));
    await flush();
    const card = q('[data-ask="permission-prompt"]');
    expect(card?.textContent).toContain("Do you want to create notes.txt?");
    expect(q('[data-ask="terminal"]')).toBeNull();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-ask="permission-prompt"] .rl-ask-btn')];
    expect(buttons.map((b) => b.textContent)).toEqual(["Yes", "Yes, allow all edits during this session", "No, and tell Claude what to do differently"]);
    await act(async () => buttons[1].click());
    await flush();
    expect(log.filter((l) => l.startsWith("keys"))).toEqual(['keys term-1 "\\u001b[B\\r"']);
    expect(onShowTerminal).not.toHaveBeenCalled();
    api.screen = "";
  });

  it("a release while the CLI shows its own prompt delivers only after it is answered", async () => {
    api.snapshot = [BOUND, PROMPT, READ];
    const held = { label: "Plan", kind: "plan" as const, held: true, toReview: 0 };
    await render(props({ planState: held }));
    await typeAndSend("keep it lowercase");
    log.length = 0;
    await render(props({ planState: { ...held, held: false } }));
    await act(async () => api.batches.get("term-1")!({ events: [ev("h1", 40, { kind: "readiness", ready: false, blocker: "native_dialog" })] }));
    await settle();
    expect(log.filter((l) => /^(submit|steer|queue)/.test(l))).toEqual([]);
    await act(async () => api.batches.get("term-1")!({ events: [ev("h2", 60, { kind: "readiness", ready: true, blocker: null })] }));
    for (let i = 0; i < 6; i++) await flush();
    expect(log.filter((l) => /^(submit|steer)/.test(l))).toEqual(["submit term-1 keep it lowercase"]);
  });

  it("an undelivered send is never a dead end: Retry sends the words again", async () => {
    api.snapshot = [BOUND, PROMPT];
    await render(props());
    await typeAndSend("also keep the line lowercase");
    for (let i = 0; i < 3; i++) await flush();
    const calls = vi.mocked(convoExpect).mock.calls;
    const nonce = calls[calls.length - 1][1];
    await act(async () => api.batches.get("term-1")!({ events: [ev("x1", 80, { kind: "undelivered", nonce })] }));
    const note = q(".rl-convo-bubble-note");
    expect(note?.textContent).toContain("Undelivered");
    log.length = 0;
    const retry = [...note!.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    await act(async () => retry.click());
    for (let i = 0; i < 4; i++) await flush();
    expect(log.filter((l) => l.startsWith("submit"))).toEqual(["submit term-1 also keep the line lowercase"]);
    expect(host.textContent).not.toContain("Undelivered");
  });

  it("sends wait while the host says not ready, then go in order when it is", async () => {
    api.snapshot = [BOUND, PROMPT, ev("h1", 15, { kind: "readiness", ready: false, blocker: "dirty_input" })];
    await render(props());
    expect(q(".rl-convo-readiness")?.textContent).toMatch(/unsent text in the terminal.*Open Terminal/);
    await typeAndSend("one");
    await typeAndSend("two");
    expect(log.filter((l) => l.startsWith("submit"))).toEqual([]);
    expect(q(".rl-work-drawer-count")?.textContent).toBe("Queued · 2");
    await act(async () => api.batches.get("term-1")!({ events: [ev("h2", 60, { kind: "readiness", ready: true, blocker: null })] }));
    for (let i = 0; i < 4; i++) await flush();
    expect(log.filter((l) => l.startsWith("submit"))).toEqual(["submit term-1 one", "submit term-1 two"]);
    expect(q(".rl-work-drawer-count")).toBeNull();
  });

  it("with no terminal yet, sends wait in the queue and nothing subscribes", async () => {
    await render(props({ terminalId: null }));
    expect(log).toEqual([]);
    expect(q(".rl-convo-readiness")?.textContent).toMatch(/Not running in a terminal: restore the session to send/);
    await typeAndSend("First thought");
    expect(q(".rl-work-drawer-count")?.textContent).toBe("Queued · 1");
  });

  it("a plan past its review reads as where it is, not Plan ready", async () => {
    const onOpenPlan = vi.fn();
    const planState = { label: "Building v4", kind: "build" as const, held: false, toReview: 1 };
    await render(props({ planOpen: false, onOpenPlan, planTitle: "Roadmap", planState }));
    expect(q(".rl-convo-plan-body")).toBeNull();
    expect(q(".rl-convo-inline-plan")?.textContent).toBe("Plan · RoadmapBuilding v41 to reviewOpen");
    // With the panel open there is nowhere to open it to.
    await render(props({ planOpen: true, onOpenPlan, planTitle: "Roadmap", planState }));
    expect(q(".rl-convo-inline-plan")?.textContent).toBe("Plan · RoadmapBuilding v41 to review");
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
    // With Talk wired, the note carries it: voice stays one click away.
    const onTalk = vi.fn();
    await render(props({ harness: "codex", sessionId: "t1", terminalId: "term-cx", onShowTerminal, onTalk }));
    expect(q(".rl-convo-note")?.textContent).toBe("This Codex session is shown in its terminal. Open Terminal · Talk");
    await act(async () => (q(".rl-convo-note button:last-child") as HTMLButtonElement).click());
    expect(onTalk).toHaveBeenCalledTimes(1);
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
    const { answerAsk } = await import("./convo/api");
    return (answerAsk as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  };
  beforeEach(async () => {
    const { answerAsk } = await import("./convo/api");
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

describe("the work drawer and the pane's keys (W2)", () => {
  beforeEach(() => {
    log.length = 0;
    api.batches.clear();
    api.snapshot = [];
    api.submit = { status: "sent" };
    api.queue = { status: "idle" };
    api.steer = { status: "sent" };
    api.hold = null;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("a send the CLI can't take yet waits here: Steer puts it first in line, never last; Edit hands its text back; Remove drops it", async () => {
    api.snapshot = [BOUND, PROMPT, ev("h1", 15, { kind: "readiness", ready: false, blocker: "dirty_input" })];
    await render(props());
    await typeAndSend("one");
    await typeAndSend("two");
    await typeAndSend("three");
    expect(all(".rl-work-drawer-row .rl-work-drawer-text").map((e) => e.textContent)).toEqual(["one", "two", "three"]);
    // Steer the second: blocked, so it heads the queue instead of failing to the back.
    await act(async () => (all(".rl-work-drawer-steer")[1] as HTMLButtonElement).click());
    for (let i = 0; i < 4; i++) await flush();
    expect(log.filter((l) => l.startsWith("submit"))).toEqual([]);
    expect(all(".rl-work-drawer-row .rl-work-drawer-text").map((e) => e.textContent)).toEqual(["two", "one", "three"]);
    // Edit the second row: back in the box.
    await act(async () => (q('[aria-label="Edit: one"]') as HTMLButtonElement).click());
    await flush();
    expect((q(".rl-convo-field") as HTMLTextAreaElement).value).toBe("one");
    expect(all(".rl-work-drawer-row .rl-work-drawer-text").map((e) => e.textContent)).toEqual(["two", "three"]);
    // Remove the last: gone, the box untouched.
    await act(async () => (q('[aria-label="Remove: three"]') as HTMLButtonElement).click());
    await flush();
    expect(all(".rl-work-drawer-row .rl-work-drawer-text").map((e) => e.textContent)).toEqual(["two"]);
    expect((q(".rl-convo-field") as HTMLTextAreaElement).value).toBe("one");
    // The CLI can take input again, the agent idle: it goes.
    await act(async () => api.batches.get("term-1")!({ events: [ev("h2", 16, { kind: "readiness", ready: true, blocker: null })] }));
    for (let i = 0; i < 4; i++) await flush();
    expect(log.filter((l) => l.startsWith("submit"))).toEqual(["submit term-1 two"]);
    expect(q(".rl-work-drawer")).toBeNull();
  });

  it("mid-turn, a send is held in the terminal's outbox as a drawer row, not typed into the CLI", async () => {
    api.snapshot = [BOUND, PROMPT, READ];
    api.queue = { status: "queued" };
    await render(props());
    await typeAndSend("and also this");
    expect(log).toContain("queue term-1 and also this");
    expect(log.filter((l) => l.startsWith("submit") || l.startsWith("expect"))).toEqual([]);
    expect(all(".rl-convo-bubble").map((e) => e.textContent)).toEqual(["Plan the roadmap"]);
    // The backend's outbox is the drawer.
    const outbox = (items: { id: string; text: string }[], id: string, offset: number) =>
      ev(id, offset, { kind: "outbox", items: items.map((item) => ({ ...item, at: 1 })) });
    await act(async () => api.batches.get("term-1")!({ events: [outbox([{ id: "n1", text: "and also this" }, { id: "n2", text: "later" }], "o1", 21)] }));
    expect(all(".rl-work-drawer-row .rl-work-drawer-text").map((e) => e.textContent)).toEqual(["and also this", "later"]);
    // Steer: the backend types it now (or asks for the interrupt).
    api.steer = { status: "interrupt" };
    await act(async () => (all(".rl-work-drawer-steer")[1] as HTMLButtonElement).click());
    await flush();
    expect(log).toContain("steer term-1 n2");
    expect(log).toContain("interrupt term-1");
    // Edit: out of the outbox, into the composer.
    await act(async () => (q('[aria-label="Edit: and also this"]') as HTMLButtonElement).click());
    await flush();
    expect(log).toContain("unqueue term-1 n1");
    expect((q(".rl-convo-field") as HTMLTextAreaElement).value).toBe("text of n1");
    // The turn ended and the outbox handed one on: its bubble, then the drawer empties.
    await act(async () =>
      api.batches.get("term-1")!({ events: [outbox([], "o2", 40), ev("s1", 40, { kind: "sending", nonce: "n2", text: "later" })] }),
    );
    expect(q(".rl-work-drawer")).toBeNull();
    expect(all(".rl-convo-bubble").map((e) => e.textContent)).toContain("later");
  });

  it("D25: while the plan is held, sends wait (Steer off, 'Waiting for your review'), the header reads the hold, and the release delivers them", async () => {
    api.snapshot = [BOUND, PROMPT, READ, ev("p1", 25, { kind: "assistant_text", text: "Writing it up." })];
    const outbox = ev("o1", 26, { kind: "outbox", items: [{ id: "n1", text: "keep it brief", at: 1 }] });
    api.snapshot.push(outbox);
    const held = { label: "Plan", kind: "plan" as const, held: true, toReview: 0 };
    const header = vi.fn((facts: { held: string | null }) => <div data-held>{facts.held}</div>);
    await render(props({ planState: held, mode: undefined, header } as Partial<SessionConversationProps>));
    // Never "Writing the plan" over a CLI blocked in the review hook.
    expect(host.textContent).not.toContain("Writing the plan");
    expect(q("[data-held]")?.textContent).toBe("Plan ready · waiting for you");
    expect(q(".rl-work-drawer-held")?.textContent).toBe("Waiting for your review");
    expect((q(".rl-work-drawer-steer") as HTMLButtonElement).disabled).toBe(true);
    // A send now waits here too: nothing is typed into the blocked CLI.
    await typeAndSend("and the tests");
    expect(log.filter((l) => /^(submit|queue|expect|steer)/.test(l))).toEqual([]);
    expect(all(".rl-work-drawer-row .rl-work-drawer-text").map((e) => e.textContent)).toEqual(["keep it brief", "and the tests"]);
    // Approve / Revise / Discuss releases the hold: the outbox's row is
    // steered into the resumed turn, then the one held here is typed in.
    await render(props({ planState: { ...held, held: false }, header } as Partial<SessionConversationProps>));
    for (let i = 0; i < 4; i++) await flush();
    // Not the instant the hold lets go: what the CLI draws next (its own
    // proceed prompt) would take the words. After the settle, ready, they go.
    expect(log.filter((l) => /^(submit|steer)/.test(l))).toEqual([]);
    await settle();
    expect(log.filter((l) => /^(submit|steer)/.test(l))).toEqual(["steer term-1 n1", "submit term-1 and the tests"]);
  });

  it("a send waiting on a held plan survives a reload: the drawer has it back and nothing is typed", async () => {
    api.snapshot = [BOUND, PROMPT, READ];
    const held = { label: "Plan", kind: "plan" as const, held: true, toReview: 0 };
    await render(props({ planState: held }));
    await typeAndSend("and the tests");
    expect(all(".rl-work-drawer-row .rl-work-drawer-text").map((e) => e.textContent)).toEqual(["and the tests"]);
    // ⌘R: the webview's tree goes and comes back.
    await act(async () => root.render(<div />));
    await flush();
    log.length = 0;
    await render(props({ planState: held }));
    expect(all(".rl-work-drawer-row .rl-work-drawer-text").map((e) => e.textContent)).toEqual(["and the tests"]);
    expect(log.filter((l) => /^(submit|queue|steer)/.test(l))).toEqual([]);
    // Released, it is typed once, and the stored copy goes with it.
    await render(props({ planState: { ...held, held: false } }));
    await settle();
    expect(log.filter((l) => /^submit/.test(l))).toEqual(["submit term-1 and the tests"]);
    expect(sessionStorage.getItem("redline.convo.queue.term-1")).toBeNull();
  });

  it("D25: in a genuine mid-turn (no plan held) Steer delivers now", async () => {
    api.snapshot = [BOUND, PROMPT, READ, ev("o1", 26, { kind: "outbox", items: [{ id: "n1", text: "now please", at: 1 }] })];
    await render(props({ planState: { label: "Plan", kind: "plan", held: false, toReview: 0 } }));
    expect(q(".rl-work-drawer-held")).toBeNull();
    const steer = q(".rl-work-drawer-steer") as HTMLButtonElement;
    expect(steer.disabled).toBe(false);
    await act(async () => steer.click());
    await flush();
    expect(log).toContain("steer term-1 n1");
  });

  it("a running subagent shows in the drawer's head with the shared spinner", async () => {
    api.snapshot = [BOUND, PROMPT, ev("t2", 20, { kind: "tool_use", toolUseId: "tu2", name: "Task", summary: "explore-fixtures" })];
    await render(props());
    expect(q(".rl-work-drawer-agent code")?.textContent).toBe("explore-fixtures");
    expect(q(".rl-work-drawer-agent .rl-spinner")).not.toBeNull();
  });

  it("Esc in the pane while a turn runs is Stop, through the terminal's own interrupt path", async () => {
    api.snapshot = [BOUND, PROMPT, READ];
    await render(props());
    await act(async () => q(".rl-convo-field")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(log).toContain("interrupt term-1");
  });

  it("Esc with nothing running is left alone", async () => {
    api.snapshot = [BOUND, PROMPT, READ, DONE, ev("e1", 40, { kind: "turn_end" })];
    await render(props());
    await act(async () => q(".rl-convo-field")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(log.filter((l) => l.startsWith("interrupt"))).toEqual([]);
  });

  it("the header render-prop gets the transcript's facts and its actions", async () => {
    api.snapshot = [BOUND, PROMPT, READ];
    const seen: unknown[] = [];
    await render(props({ header: (facts) => { seen.push(facts); return <div data-head>{facts.working ? "working" : "idle"}</div>; } }));
    expect(q("[data-head]")?.textContent).toBe("working");
    expect((seen[seen.length - 1] as { boundSessionId: string }).boundSessionId).toBe("s1");
  });

  describe("the agent dies while its terminal lives (the last walk's 20-minute spinner)", () => {
    const BUILDING = { label: "Building v1", kind: "build" as const, held: false, toReview: 0 };

    it("the daemon's exited readiness ends the spinning turn and puts the Stopped card up with Retry", async () => {
      // A build mid-turn: the tool is still running when the CLI is killed.
      api.snapshot = [BOUND, PROMPT, READ, ev("h1", 25, { kind: "readiness", ready: true, blocker: null })];
      const onRetryBuild = vi.fn();
      await render(props({ planState: BUILDING, onRetryBuild }));
      expect(q(".rl-convo-working")).not.toBeNull();
      expect(q("[data-ask='stopped']")).toBeNull();
      // The shell is back in front of a session that was live: no SessionEnd,
      // no PTY exit, only the foreground check.
      await act(async () => api.batches.get("term-1")!({ events: [ev("h2", 60, { kind: "readiness", ready: false, blocker: "exited" })] }));
      await flush();
      expect(q(".rl-convo-working")).toBeNull();
      const card = q("[data-ask='stopped']");
      expect(card?.textContent).toMatch(/Claude stopped before the build finished/);
      const retry = [...card!.querySelectorAll("button")].find((b) => b.textContent === "Retry") as HTMLButtonElement;
      expect(retry).toBeTruthy();
      await act(async () => retry.click());
      expect(onRetryBuild).toHaveBeenCalledTimes(1);
      expect(q(".rl-convo-readiness")?.textContent).toMatch(/Claude stopped/);
      expect(q(".rl-convo-readiness")?.textContent).not.toMatch(/Waiting for Claude to start/);
    });

    it("the wall's exited state does the same over a daemon that still says unbound", async () => {
      api.snapshot = [BOUND, PROMPT, READ, ev("h1", 25, { kind: "readiness", ready: false, blocker: "unbound" })];
      await render(props({ planState: BUILDING, onRetryBuild: vi.fn(), termState: "exited" }));
      expect(q(".rl-convo-working")).toBeNull();
      expect(q("[data-ask='stopped']")).not.toBeNull();
      expect(q(".rl-convo-readiness")?.textContent).toMatch(/Claude stopped/);
    });

    it("a CLI still starting (unbound, never live) is not a stop", async () => {
      api.snapshot = [BOUND, ev("h1", 5, { kind: "readiness", ready: false, blocker: "unbound" })];
      await render(props({ planState: BUILDING, onRetryBuild: vi.fn() }));
      expect(q("[data-ask='stopped']")).toBeNull();
      expect(q(".rl-convo-readiness")?.textContent).toMatch(/Waiting for Claude to start/);
    });
  });
});
