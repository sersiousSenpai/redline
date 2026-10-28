// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { hidden, seen } = vi.hoisted(() => ({ hidden: [] as boolean[], seen: [] as Record<string, unknown>[] }));
vi.mock("./SessionConversation", () => ({
  default: (p: { hidden?: boolean; header?: (facts: unknown, actions: unknown) => unknown; onShowTerminal: () => void }) => {
    hidden.push(!!p.hidden);
    seen.push(p as unknown as Record<string, unknown>);
    return (
      <div data-convo data-hidden={p.hidden ? "" : undefined}>
        {p.header?.({ model: { model: "claude-opus-4-5", effort: "high" }, mode: "plan", working: true, needsYou: false, hasOlder: true, boundSessionId: "cli-1" }, { earlier: () => hidden.push(true), stop: () => {} }) as never}
        <button type="button" data-open-terminal onClick={p.onShowTerminal}>Open Terminal</button>
      </div>
    );
  },
}));
import AgentPane, { type AgentPaneProps, type CliView } from "./AgentPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const q = (s: string) => host.querySelector(s);

function props(over: Partial<AgentPaneProps> = {}): AgentPaneProps {
  return {
    terminalId: "term-1",
    sessionId: "s1",
    harness: "claude",
    visible: true,
    cliAvailable: true,
    onCliView: vi.fn(),
    planOpen: false,
    onOpenPlan: vi.fn(),
    ...over,
  };
}
async function render(p: AgentPaneProps) {
  await act(async () => root.render(<AgentPane {...p} />));
  await flush();
}

describe("AgentPane", () => {
  beforeEach(() => {
    hidden.length = 0;
    seen.length = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("draws the header from the conversation's facts: agent, model · effort, mode, Chat | CLI, History, Fork", async () => {
    await render(props({ onFork: vi.fn() }));
    const head = q(".rl-agent-head")!;
    expect(head.textContent).toContain("Claude Code");
    expect(head.textContent).toContain("Plan mode");
    expect(head.querySelector('[role=radio][aria-checked="true"]')?.textContent).toBe("Chat");
    expect(q('[aria-label="Earlier messages"]')).not.toBeNull();
    expect(q('[aria-label="Fork this session"]')).not.toBeNull();
  });

  it("CLI pins the dock over the pane's box with the same PTY, and Chat hands it back; hidden follows", async () => {
    const onCliView = vi.fn<(v: CliView | null) => void>();
    await render(props({ onCliView }));
    expect(hidden[hidden.length - 1]).toBe(false);
    const cli = [...host.querySelectorAll("[role=radio]")].find((b) => b.textContent === "CLI") as HTMLButtonElement;
    await act(async () => cli.click());
    await flush();
    const view = onCliView.mock.calls[onCliView.mock.calls.length - 1]?.[0];
    expect(view?.terminalId).toBe("term-1");
    expect(view?.el).toBe(q(".rl-agent-cli"));
    // Out of sight behind its terminal: held questions go there.
    expect(hidden[hidden.length - 1]).toBe(true);
    expect(q(".rl-agent-pane")?.getAttribute("data-view")).toBe("cli");
    const chat = [...host.querySelectorAll("[role=radio]")].find((b) => b.textContent === "Chat") as HTMLButtonElement;
    await act(async () => chat.click());
    await flush();
    expect(onCliView.mock.calls[onCliView.mock.calls.length - 1]?.[0]).toBeNull();
    expect(hidden[hidden.length - 1]).toBe(false);
  });

  it("a hidden kept tab never holds the dock, and gets it back when shown", async () => {
    const onCliView = vi.fn<(v: CliView | null) => void>();
    await render(props({ onCliView }));
    const cli = [...host.querySelectorAll("[role=radio]")].find((b) => b.textContent === "CLI") as HTMLButtonElement;
    await act(async () => cli.click());
    await flush();
    await render(props({ onCliView, visible: false }));
    expect(onCliView.mock.calls[onCliView.mock.calls.length - 1]?.[0]).toBeNull();
    await render(props({ onCliView, visible: true }));
    expect(onCliView.mock.calls[onCliView.mock.calls.length - 1]?.[0]?.terminalId).toBe("term-1");
  });

  it("Open Terminal inside the thread is the pane's CLI view; without a live PTY the toggle is off", async () => {
    await render(props());
    await act(async () => (q("[data-open-terminal]") as HTMLButtonElement).click());
    await flush();
    expect(q(".rl-agent-pane")?.getAttribute("data-view")).toBe("cli");
    await render(props({ cliAvailable: false }));
    const cli = [...host.querySelectorAll("[role=radio]")].find((b) => b.textContent === "CLI") as HTMLButtonElement;
    expect(cli.disabled).toBe(true);
    expect(q(".rl-agent-pane")?.getAttribute("data-view")).toBe("chat");
  });

  it("Fork needs a harness that can, and a bound CLI session", async () => {
    await render(props({ onFork: null }));
    expect(q('[aria-label="Fork this session"]')).toBeNull();
    const onFork = vi.fn();
    await render(props({ onFork }));
    await act(async () => (q('[aria-label="Fork this session"]') as HTMLButtonElement).click());
    expect(onFork).toHaveBeenCalledWith("cli-1", null);
  });

  it("is memoized: equal props skip the render, and its own callbacks keep their identity", async () => {
    const p = props({ onFork: vi.fn(), planState: { label: "Plan", kind: "plan", held: true, toReview: 0 } });
    await render(p);
    const first = seen.length;
    expect(first).toBeGreaterThan(0);
    await render({ ...p });
    expect(seen.length).toBe(first);
    // A prop the header doesn't read re-renders the conversation, but the
    // header and Open Terminal it gets are the same functions.
    await render({ ...p, talking: true });
    expect(seen.length).toBeGreaterThan(first);
    const [before, after] = [seen[first - 1], seen[seen.length - 1]];
    expect(after.header).toBe(before.header);
    expect(after.onShowTerminal).toBe(before.onShowTerminal);
  });

  it("its pane hands it no inline closure or object literal, and App feeds that pane stable values", () => {
    // W6: the element lives in the chat pane module; App hands the pane the
    // session's facts and the stable handlers.
    const pane = readFileSync("src/workbench/panes/chat.tsx", "utf8");
    const start = pane.indexOf("<AgentPane\n");
    expect(start).toBeGreaterThan(-1);
    const element = pane.slice(start, pane.indexOf("/>", start));
    expect(element).not.toMatch(/=>|=\{\{|\? \{/);
    expect(element).toContain("planState={own ? facts.planState : null}");
    expect(element).toContain("fallbackModel={own ? facts.fallbackModel : null}");
    expect(element).toContain("onFork={harness === \"claude\" ? handlers.onFork : null}");
    const app = readFileSync("src/App.tsx", "utf8");
    const facts = app.slice(app.indexOf("const agentFacts = {"), app.indexOf("};", app.indexOf("const agentFacts = {")));
    expect(facts).toContain("planState: activeAgentPlanState,");
    expect(facts).toContain("fallbackModel: activeAgentModel,");
    expect(app).toContain("handlers={agentPaneHandlers}");
    expect(app).toContain("const agentPaneHandlers = useStableHandlers({");
  });
});
