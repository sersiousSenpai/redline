// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Footer } from "./Footer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mount(backend?: string, waiting = false, waitingAsk = false) {
  await act(async () => root.render(createElement(Footer, {
    comments: [], sessionReady: true, canSubmit: true, canApprove: true,
    waiting, waitingAsk, backend,
    onSubmit: () => {}, onApprove: () => {}, onApproveLater: () => {},
  })));
}
describe("plan footer provider and execution labels", () => {
  it.each([["claude-code", "Claude"], ["codex", "Codex"], ["cursor", "Cursor"], ["antigravity", "Antigravity"]])(
    "routes %s feedback labels to the plan author", async (backend, author) => {
      await mount(backend, true, true);
      expect(host.textContent).toContain(`Send to ${author}`);
      expect(host.textContent).toContain(`${author} is working — answering in the terminal`);
      await mount(backend, true, false);
      expect(host.textContent).toContain(`${author} is working — revising in the terminal`);
    },
  );
  it("approves through the plan's own agent, never a run graph", async () => {
    await mount("codex");
    expect(host.textContent).toContain("Approve & build");
    expect(host.textContent).toContain("with Codex");
    expect(host.textContent).not.toContain("Orchestrate");
  });
});

describe("approve, build later, build and reopen", () => {
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text));
  async function mountWith(over: Record<string, unknown>) {
    await act(async () => root.render(createElement(Footer, {
      comments: [], sessionReady: true, canSubmit: false, canApprove: true, waiting: false, waitingAsk: false,
      backend: "claude-code", onSubmit: () => {}, onApprove: () => {}, onApproveLater: () => {},
      ...over,
    })));
  }

  it("offers build later from the approve split button", async () => {
    const calls: string[] = [];
    await mountWith({ onApprove: () => calls.push("now"), onApproveLater: () => calls.push("later") });
    await act(async () => button("Approve & build")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="More approve options"]')!.click());
    const later = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.includes("Approve, build later"))!;
    await act(async () => later.click());
    expect(calls).toEqual(["now", "later"]);
  });

  it("an approved, unbuilt plan shows Build ▾ and Reopen", async () => {
    const built: string[] = [];
    let reopened = 0;
    await mountWith({
      approval: { version: 3, runState: null },
      buildTargets: [{ id: "same", label: "with Claude" }, { id: "codex", label: "with Codex" }],
      onBuild: (id: string) => built.push(id),
      onReopen: () => reopened++,
    });
    expect(host.textContent).toContain("Approved · v3");
    expect(host.textContent).toContain("not built");
    expect(button("Approve & build")).toBeUndefined();
    await act(async () => button("Build")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Build with"]')!.click());
    const codex = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.includes("with Codex"))!;
    await act(async () => codex.click());
    expect(built).toEqual(["same", "codex"]);
    await act(async () => button("Reopen")!.click());
    expect(reopened).toBe(1);
  });

  it("reopening a plan that is already building asks once, inline", async () => {
    let reopened = 0;
    await mountWith({ approval: { version: 2, runState: "building" }, onReopen: () => reopened++ });
    expect(button("Build")).toBeUndefined();
    await act(async () => button("Reopen")!.click());
    expect(reopened).toBe(0);
    expect(host.textContent).toContain("may already have made changes");
    await act(async () => button("Reopen anyway")!.click());
    expect(reopened).toBe(1);
  });
});

describe("Approve & build is one launch", () => {
  it("its menu holds only build later: no team, no run", async () => {
    let later = 0;
    await act(async () => root.render(createElement(Footer, {
      comments: [], sessionReady: true, canSubmit: true, canApprove: true, waiting: false, waitingAsk: false,
      onSubmit: () => {}, onApprove: () => {}, onApproveLater: () => { later++; },
    })));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="More approve options"]')!.click());
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((b) => b.textContent)).toEqual([expect.stringContaining("Approve, build later")]);
    await act(async () => items[0].click());
    expect(later).toBe(1);
  });
});

describe("the terminals that need you", () => {
  async function mountWith(extra: Record<string, unknown>) {
    await act(async () => root.render(createElement(Footer, {
      comments: [], sessionReady: true, canSubmit: true, canApprove: true,
      waiting: false, waitingAsk: false,
      onSubmit: () => {}, onApprove: () => {}, onApproveLater: () => {},
      ...extra,
    })));
  }
  const chip = () => [...host.querySelectorAll("button")].find((b) => b.title.includes("⌘⇧J"));

  it("shows a chip only while something needs you, and its click runs the jump", async () => {
    let jumps = 0;
    await mountWith({ termNeedYou: 0, onJumpToNeedsYou: () => { jumps++; } });
    expect(chip()).toBeUndefined();
    // No terminal count: the bottom dock that chip opened is gone.
    expect(host.textContent).not.toMatch(/\d terminals?/);
    await mountWith({ termNeedYou: 2, onJumpToNeedsYou: () => { jumps++; } });
    expect(chip()?.textContent).toBe("2 need you");
    await act(async () => chip()!.click());
    expect(jumps).toBe(1);
    await mountWith({ termNeedYou: 1, onJumpToNeedsYou: () => {} });
    expect(chip()?.textContent).toBe("1 needs you");
  });

});

// An agent's review request is news, never a move (10/10): the chip is the
// way there, for as long as the agent waits.
describe("a review waiting for you", () => {
  async function mountWith(extra: Record<string, unknown>) {
    await act(async () => root.render(createElement(Footer, {
      comments: [], sessionReady: true, canSubmit: true, canApprove: true,
      waiting: false, waitingAsk: false,
      onSubmit: () => {}, onApprove: () => {}, onApproveLater: () => {},
      ...extra,
    })));
  }
  const chip = () => [...host.querySelectorAll("button")].find((b) => b.title === "Open the review surface");

  it("shows a chip only while a review waits, and its click is the way there", async () => {
    let opened = 0;
    await mountWith({ reviewNews: null, onOpenReviewNews: () => { opened++; } });
    expect(chip()).toBeUndefined();
    await mountWith({ reviewNews: "Review ready", onOpenReviewNews: () => { opened++; } });
    expect(chip()?.textContent).toBe("Review ready → Open");
    await act(async () => chip()!.click());
    expect(opened).toBe(1);
  });
});

describe("one set of plan verbs on screen", () => {
  it("planVerbs={false} keeps the status and drops Send and Approve & build: the Plan pane's footer carries them", async () => {
    await act(async () => root.render(createElement(Footer, {
      comments: [], sessionReady: true, canSubmit: true, canApprove: true, waiting: false, waitingAsk: false,
      onSubmit: () => {}, onApprove: () => {}, onApproveLater: () => {},
      planVerbs: false,
    })));
    expect(host.textContent).toContain("no pending comments");
    expect(host.textContent).not.toContain("Approve & build");
    expect(host.textContent).not.toContain("Send to");
    expect(host.querySelector(".rl-footer-actions")).toBeNull();
  });

  it("App ties it to a Plan pane being on screen", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const footer = app.slice(app.indexOf("<Footer\n"), app.indexOf("/>", app.indexOf("<Footer\n")));
    expect(footer).toMatch(/planVerbs=\{!\(classicWb && wbView\.visibleKinds\.includes\("plan"\)\)\}/);
  });
});
